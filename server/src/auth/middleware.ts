import type { NextFunction, Request, Response } from 'express';
import { unauthorized } from '../http/errors.js';
import { verifyToken } from './tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Nur gesetzt, wenn `requireAuth` gelaufen ist. */
      userId?: string;
    }
  }
}

/**
 * Setzt `req.userId` oder wirft 401. Wird auf ganze Router gelegt, nicht auf
 * einzelne Routen: eine spaeter hinzugefuegte Route ist damit automatisch
 * geschuetzt. Vergessene Absicherung ist der haeufigste Auth-Fehler, und ein
 * Standardwert "geschuetzt" macht ihn unmoeglich.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    next(unauthorized());
    return;
  }
  const payload = verifyToken(header.slice('Bearer '.length).trim());
  if (!payload) {
    next(unauthorized('Token ungueltig oder abgelaufen.', 'invalid_token'));
    return;
  }
  req.userId = payload.sub;
  next();
}

/**
 * Liest `req.userId` und stellt fuer TypeScript sicher, dass er da ist.
 * Wenn das wirft, fehlt `requireAuth` auf dem Router - ein Programmierfehler,
 * kein Nutzerfehler, deshalb bewusst laut.
 */
export function currentUserId(req: Request): string {
  if (!req.userId) throw new Error('requireAuth fehlt auf dieser Route');
  return req.userId;
}
