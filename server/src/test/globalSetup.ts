import { spawnSync } from 'node:child_process';
import { resolveTestDatabaseUrl } from './testDatabaseUrl.js';

/**
 * Bringt die Testdatenbank vor dem ersten Test auf den Stand der Migrationen.
 *
 * Steht hier und nicht in einem `pretest`-Skript, damit auch der Watch-Modus
 * auf einer migrierten Datenbank startet.
 */
export default function setup(): void {
  const databaseUrl = resolveTestDatabaseUrl();
  if (!databaseUrl) throw new Error('TEST_DATABASE_URL fehlt in der .env');

  // Ein einzelner Kommandostring statt Argumentliste: bei `shell: true` warnt
  // Node sonst, dass Argumente nur aneinandergehaengt und nicht maskiert werden.
  const result = spawnSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (result.status !== 0) {
    throw new Error('prisma migrate deploy fuer die Testdatenbank fehlgeschlagen');
  }
}
