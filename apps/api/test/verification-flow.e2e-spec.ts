import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { config } from '../src/config';
import { JobWorker } from '../src/jobs/job-worker';
import { migrate } from '../src/scripts/migrate';
import { seed } from '../src/scripts/seed';

/** Runs the whole journey against a real Postgres with mock providers. */
describe('verification flow', () => {
  let app: INestApplication;
  let worker: JobWorker;
  let companyA: Awaited<ReturnType<typeof seed>>;
  let companyB: Awaited<ReturnType<typeof seed>>;
  let analystToken: string;

  const http = () => request(app.getHttpServer());

  function fakeJpeg(content = randomBytes(16)) {
    return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30 * 1024, content)]);
  }

  async function drainJobs() {
    while (await worker.runOnce());
  }

  async function createVerification(apiKey: string, body: Record<string, unknown>) {
    const res = await http().post('/v1/verifications').set('authorization', `Bearer ${apiKey}`).send(body).expect(201);
    return res.body as { id: string; session_token: string };
  }

  function capture(sessionToken: string, kind: string, image: Buffer, livenessSessionId?: string) {
    const req = http().post('/v1/sdk/captures').set('x-session-token', sessionToken).field('kind', kind);
    if (livenessSessionId) req.field('liveness_session_id', livenessSessionId);
    return req.attach('file', image, { filename: `${kind}.jpg`, contentType: 'image/jpeg' });
  }

  /** Creates a verification, completes the capture journey and runs the analysis. */
  async function runJourney(options: { scenario?: string; userId?: string; cpf?: string; selfie?: Buffer } = {}) {
    const { id, session_token } = await createVerification(companyA.apiKey, {
      external_user_id: options.userId ?? `user-${randomBytes(4).toString('hex')}`,
      journey: 'signup',
      cpf: options.cpf,
      metadata: options.scenario ? { mock_scenario: options.scenario } : undefined,
    });
    const liveness = await http().post('/v1/sdk/liveness').set('x-session-token', session_token).expect(201);
    await capture(session_token, 'selfie', options.selfie ?? fakeJpeg(), liveness.body.session_id).expect(201);
    await capture(session_token, 'document_front', fakeJpeg()).expect(201);
    await http().post('/v1/sdk/submit').set('x-session-token', session_token).expect(200);
    await drainJobs();
    return id;
  }

  function getVerification(id: string, apiKey = companyA.apiKey) {
    return http().get(`/v1/verifications/${id}`).set('authorization', `Bearer ${apiKey}`);
  }

  beforeAll(async () => {
    await migrate(config.databaseAdminUrl);
    const admin = new Client({ connectionString: config.databaseAdminUrl });
    await admin.connect();
    await admin.query(
      `TRUNCATE tenants, api_keys, analysts, verifications, verification_sessions, captures,
                check_results, extracted_data, decisions, audit_events, jobs CASCADE`,
    );
    await admin.end();

    companyA = await seed(config.databaseAdminUrl, { tenantName: 'Empresa A' });
    companyB = await seed(config.databaseAdminUrl, { tenantName: 'Empresa B', analystEmail: 'b@demo.local' });
    analystToken = companyB.analystToken;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    worker = app.get(JobWorker);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('approves a clean verification automatically and returns the extracted data', async () => {
    const id = await runJourney();
    const res = await getVerification(id).expect(200);
    expect(res.body).toMatchObject({
      status: 'approved',
      decision: { outcome: 'approved', origin: 'automatic', reason: 'all_checks_passed' },
      document_type: 'cnh',
      extracted: { fields: { cpf: '52998224725', address: null } },
    });
    expect(res.body.score).toBeGreaterThanOrEqual(80);
  });

  it('routes a face mismatch to an analyst, who approves it with a recorded reason', async () => {
    const id = await runJourney({ scenario: 'face_mismatch' });
    expect((await getVerification(id)).body.status).toBe('in_review');

    const queue = await http().get('/v1/review/queue').set('authorization', `Bearer ${analystToken}`).expect(200);
    const item = queue.body.items.find((i: { id: string }) => i.id === id);
    expect(item).toMatchObject({ tenant_name: 'Empresa A', suspicious: true });

    await http()
      .post(`/v1/review/verifications/${id}/decision`)
      .set('authorization', `Bearer ${analystToken}`)
      .send({ decision: 'approve', reason: 'Foto do documento antiga; traços conferem.' })
      .expect(200);

    expect((await getVerification(id)).body).toMatchObject({
      status: 'approved',
      decision: { origin: 'manual', reason: 'Foto do documento antiga; traços conferem.' },
    });
  });

  it('requires a justification for analyst decisions', async () => {
    const id = await runJourney({ scenario: 'liveness_spoof' });
    await http()
      .post(`/v1/review/verifications/${id}/decision`)
      .set('authorization', `Bearer ${analystToken}`)
      .send({ decision: 'reject' })
      .expect(400);
  });

  it('reports provider outages as technical errors, not rejections', async () => {
    const id = await runJourney({ scenario: 'provider_down' });
    expect((await getVerification(id)).body).toMatchObject({
      status: 'technical_error',
      decision: { outcome: 'technical_error' },
    });
  });

  it('leaves an unreadable CPF empty instead of guessing it', async () => {
    const id = await runJourney({ scenario: 'unreadable_cpf', cpf: '529.982.247-25' });
    const res = await getVerification(id).expect(200);
    expect(res.body.status).toBe('in_review');
    expect(res.body.extracted.fields.cpf).toBeNull();
    expect(res.body.extracted.unreadable_fields.cpf).toBe('illegible');
  });

  it('flags a selfie reused by a different user', async () => {
    const selfie = fakeJpeg(Buffer.from('same-selfie'));
    await runJourney({ selfie, userId: 'first-user' });
    const id = await runJourney({ selfie, userId: 'second-user' });
    const res = await getVerification(id).expect(200);
    expect(res.body.status).toBe('in_review');
    expect(res.body.checks).toContainEqual({ type: 'capture_reuse', outcome: 'fail', score: 0 });
  });

  it('asks for a new capture when the image is not usable', async () => {
    const { session_token } = await createVerification(companyA.apiKey, { external_user_id: 'u', journey: 'login' });
    const res = await capture(session_token, 'document_front', Buffer.from('not an image')).expect(422);
    expect(res.body.retry).toBe(true);
    expect(res.body.issues.map((i: { code: string }) => i.code)).toContain('unsupported_format');
  });

  it("does not let one company read another company's verification", async () => {
    const id = await runJourney();
    await getVerification(id, companyB.apiKey).expect(404);
  });

  it('lets the analyst request new captures and accepts a second round', async () => {
    const id = await runJourney({ scenario: 'face_borderline' });
    await http()
      .post(`/v1/review/verifications/${id}/decision`)
      .set('authorization', `Bearer ${analystToken}`)
      .send({ decision: 'request_resubmission', reason: 'Selfie com pouca luz, pedir nova captura.' })
      .expect(200);

    const session = await http()
      .post(`/v1/verifications/${id}/sessions`)
      .set('authorization', `Bearer ${companyA.apiKey}`)
      .expect(201);
    const status = await http().get('/v1/sdk/session').set('x-session-token', session.body.session_token).expect(200);
    expect(status.body).toMatchObject({ status: 'resubmission_requested', captured: [] });
  });
});
