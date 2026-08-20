import { defineConfig } from 'vitest/config';
import { resolveTestDatabaseUrl } from './src/test/testDatabaseUrl.js';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['src/test/globalSetup.ts'],
    // Alle Testdateien teilen sich eine Datenbank und leeren sie - parallel
    // wuerden sie sich gegenseitig die Daten unter den Fuessen wegziehen.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: resolveTestDatabaseUrl(),
      // Fester Wert, damit die Tests nicht von der lokalen .env abhaengen.
      JWT_SECRET: 'test-geheimnis-mit-ausreichender-laenge-fuer-die-pruefung',
      LOG_LEVEL: 'error',
    },
  },
});
