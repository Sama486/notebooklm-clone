import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express 4 fängt Fehler aus `async`-Handlern nicht selbst ab - eine abgelehnte
 * Promise würde als unbehandelt im Prozess landen statt in der Fehlerbehandlung.
 * Jeder asynchrone Handler wird deshalb hier eingepackt.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
