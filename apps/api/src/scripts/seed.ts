import { Client } from 'pg';
import { generateToken, hashToken } from '../auth/tokens';
import { config } from '../config';

export interface SeedOptions {
  tenantName?: string;
  webhookUrl?: string | null;
  analystEmail?: string;
}

/** Creates a company with a sandbox API key, plus an analyst. Prints the secrets once; only hashes are stored. */
export async function seed(connectionString = config.databaseAdminUrl, options: SeedOptions = {}) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const webhookSecret = generateToken('whsec');
    const {
      rows: [tenant],
    } = await client.query(`INSERT INTO tenants (name, webhook_url, webhook_secret) VALUES ($1, $2, $3) RETURNING id`, [
      options.tenantName ?? 'Empresa Demo',
      options.webhookUrl ?? null,
      webhookSecret,
    ]);

    const apiKey = generateToken('idv_sk_sandbox');
    await client.query(
      `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, environment) VALUES ($1, $2, $3, 'sandbox')`,
      [tenant.id, hashToken(apiKey), apiKey.slice(0, 20)],
    );

    const analystToken = generateToken('ana');
    await client.query(
      `INSERT INTO analysts (name, email, token_hash, role) VALUES ('Analista Demo', $1, $2, 'supervisor')
       ON CONFLICT (email) DO UPDATE SET token_hash = excluded.token_hash`,
      [options.analystEmail ?? 'analista@demo.local', hashToken(analystToken)],
    );

    return { tenantId: tenant.id as string, apiKey, webhookSecret, analystToken };
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  seed(config.databaseAdminUrl, { webhookUrl: process.env.WEBHOOK_URL ?? null })
    .then((result) => {
      console.log('Guarde estes valores; eles não serão exibidos de novo:');
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
