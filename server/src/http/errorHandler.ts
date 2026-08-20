import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from './errors.js';
import { describeError, logger } from '../logger.js';

/** Alles, was keine Route getroffen hat. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'Nicht gefunden.' } });
};

/**
 * Zentrale Fehlerbehandlung - die einzige Stelle, die Fehler in HTTP-Antworten
 * uebersetzt.
 *
 * Die Regel dahinter: nur `AppError` traegt eine Meldung nach aussen. Alles
 * andere wird intern vollstaendig geloggt und extern zu einem neutralen 500.
 * Damit gibt es keinen Pfad, ueber den ein Stack Trace, ein Prisma-Fehlertext
 * oder ein Dateipfad beim Client landen kann.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) {
    // Beim Streamen sind die Header laengst raus. Mehr als das Beenden der
    // Verbindung ist hier nicht moeglich; geloggt wird trotzdem.
    logger.error('Fehler nach begonnener Antwort', {
      path: req.path,
      ...describeError(error),
    });
    res.end();
    return;
  }

  if (error instanceof AppError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }

  // Body-Parser meldet zu grosse oder kaputte Nutzlast als Fehler mit `type`.
  const parserType = (error as { type?: string } | null)?.type;
  if (parserType === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'payload_too_large', message: 'Anfrage zu gross.' },
    });
    return;
  }
  if (parserType === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_json', message: 'Ungueltiges JSON.' } });
    return;
  }

  logger.error('Unbehandelter Fehler', {
    path: req.path,
    method: req.method,
    ...describeError(error),
  });
  res.status(500).json({
    error: { code: 'internal_error', message: 'Interner Fehler.' },
  });
};
