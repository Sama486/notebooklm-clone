// Startet die Prisma-CLI mit der .env aus dem Repo-Wurzelverzeichnis.
//
// Prisma sucht die .env nur neben dem Schema oder im Arbeitsverzeichnis. Unsere
// liegt eine Ebene höher, damit Server und Frontend sich eine einzige Datei
// teilen. Auf Render existiert keine .env - dotenv findet dann nichts, und die
// Werte kommen wie vorgesehen aus der Umgebung.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

const result = spawnSync(['prisma', ...process.argv.slice(2)].join(' '), {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});
process.exit(result.status ?? 1);
