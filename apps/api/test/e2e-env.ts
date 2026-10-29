// Point the app at the test database before config.ts is loaded.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://idv_app:idv_app@localhost:5440/idv_test';
process.env.DATABASE_ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://idv_owner:idv_owner@localhost:5440/idv_test';
process.env.STORAGE_DIR = `${require('node:os').tmpdir()}/idv-e2e-media`;
process.env.WORKER = 'off';
