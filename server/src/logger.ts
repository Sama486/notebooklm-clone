import { env } from './config.js';

// Zentrales Logging. Kein `console.log` sonst irgendwo im Projekt.
// Ausgabe als eine JSON-Zeile je Ereignis, damit Render sie durchsuchbar macht.

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

const threshold = levels[env.LOG_LEVEL];

function write(level: Level, message: string, context?: Record<string, unknown>): void {
  if (levels[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...context,
  });
  // Fehler nach stderr, alles andere nach stdout.
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => write('debug', message, context),
  info: (message: string, context?: Record<string, unknown>) => write('info', message, context),
  warn: (message: string, context?: Record<string, unknown>) => write('warn', message, context),
  error: (message: string, context?: Record<string, unknown>) => write('error', message, context),
};

/**
 * Reduziert einen unbekannten Fehler auf etwas Loggbares.
 * Wird nur intern verwendet - an den Client geht davon nie etwas.
 */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message, stack: error.stack };
  }
  return { errorMessage: String(error) };
}
