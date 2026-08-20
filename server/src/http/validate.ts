import type { Request } from 'express';
import { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Jede Systemgrenze geht durch Zod. TypeScript ist zur Laufzeit weg - was von
 * aussen kommt, ist bis zur Pruefung `unknown`.
 *
 * Wichtig ist nicht nur die Pruefung, sondern das Ergebnis: zurueck kommt das
 * von Zod erzeugte Objekt mit ausschliesslich den deklarierten Feldern. Ein
 * Request-Body wird damit nie als Ganzes an Prisma weitergereicht, und ein
 * mitgeschicktes `userId` oder `isAdmin` faellt einfach weg.
 */
export function parseBody<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  return runParse(schema, req.body);
}

export function parseQuery<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  return runParse(schema, req.query);
}

export function parseParams<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  return runParse(schema, req.params);
}

function runParse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  // Nur Feldname und Regelverstoss, kein Echo des Eingabewerts - sonst landet
  // ein hochgeladenes Geheimnis in der Fehlerantwort und im Log.
  const first = result.error.issues[0];
  const field = first && first.path.length > 0 ? first.path.join('.') : 'body';
  const reason = first?.message ?? 'ungueltig';
  throw badRequest(`Ungueltige Eingabe: ${field} - ${reason}`, 'validation_failed');
}

/** UUID-Pfadparameter. Ohne diese Pruefung geht jede Zeichenkette an die Datenbank. */
export const uuidParam = <N extends string>(name: N) =>
  z.object({ [name]: z.string().uuid('muss eine UUID sein') } as { [K in N]: z.ZodString });
