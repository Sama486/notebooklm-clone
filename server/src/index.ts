import { createApp } from './app.js';
import { env } from './config.js';
import { prisma } from './db.js';
import { describeError, logger } from './logger.js';

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info('Server gestartet', { port: env.PORT, env: env.NODE_ENV });
});

/**
 * Render schickt SIGTERM und wartet danach eine begrenzte Zeit. Ohne sauberes
 * Herunterfahren werden laufende Anfragen mitten im Satz abgeschnitten und
 * Datenbankverbindungen bleiben auf der Serverseite hängen.
 */
function shutdown(signal: string): void {
  logger.info('Fahre herunter', { signal });
  server.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0));
  });
  // Notbremse, falls eine Verbindung nicht zumacht.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unbehandelte Promise-Ablehnung', describeError(reason));
});
