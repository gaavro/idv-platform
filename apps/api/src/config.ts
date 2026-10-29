export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://idv_app:idv_app@localhost:5440/idv',
  databaseAdminUrl: process.env.DATABASE_ADMIN_URL ?? 'postgres://idv_owner:idv_owner@localhost:5440/idv',
  storageDir: process.env.STORAGE_DIR ?? './.data/media',
  /** Which provider adapters to use. Only "mock" exists until vendors are contracted. */
  providers: process.env.PROVIDERS ?? 'mock',
  /** Set WORKER=off to run the API without background job processing (tests, API-only replicas). */
  workerEnabled: process.env.WORKER !== 'off',
  sessionTtlMinutes: Number(process.env.SESSION_TTL_MINUTES ?? 60),
  verificationTtlHours: Number(process.env.VERIFICATION_TTL_HOURS ?? 72),
};
