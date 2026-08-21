import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Verbindungszeichenfolge der Testdatenbank, aus der .env im Repo-Wurzel-
 * verzeichnis. Wird von vitest.config.ts und vom globalSetup gebraucht - beide
 * laufen außerhalb der normalen Konfiguration und lesen deshalb hier.
 *
 * Fällt auf DATABASE_URL zurück, wenn TEST_DATABASE_URL fehlt. Das ist
 * bequem, aber die Testläufe leeren dann die Entwicklungsdatenbank; der
 * Hinweis dazu steht in .env.example.
 */
export function resolveTestDatabaseUrl(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const parsed = dotenv.config({ path: path.resolve(here, '../../../.env') }).parsed ?? {};
  return (
    process.env.TEST_DATABASE_URL ??
    parsed.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    parsed.DATABASE_URL ??
    ''
  );
}
