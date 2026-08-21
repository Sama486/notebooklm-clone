/**
 * Der einzige Fehlertyp, dessen Meldung den Client erreicht.
 *
 * Alles andere - Datenbankfehler, Programmierfehler, Fehler aus Bibliotheken -
 * wird von der zentralen Fehlerbehandlung zu einem neutralen 500 ohne Details.
 * Damit kann kein Stack Trace und keine Datenbankmeldung nach außen lecken.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'bad_request') =>
  new AppError(400, code, message);

export const unauthorized = (message = 'Nicht angemeldet.', code = 'unauthorized') =>
  new AppError(401, code, message);

/**
 * Wird auch dann verwendet, wenn die Ressource existiert, aber einem anderen
 * Nutzer gehört. Ein 403 würde verraten, dass die ID vergeben ist - damit
 * ließen sich fremde IDs durch Ausprobieren bestätigen.
 */
export const notFound = (message = 'Nicht gefunden.', code = 'not_found') =>
  new AppError(404, code, message);

export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);

export const payloadTooLarge = (message: string, code = 'payload_too_large') =>
  new AppError(413, code, message);

export const unprocessable = (message: string, code = 'unprocessable') =>
  new AppError(422, code, message);
