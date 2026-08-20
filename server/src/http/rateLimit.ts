import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { limits } from '../config.js';
import { isTest } from '../config.js';

/**
 * BENANNTE ANNAHME: Ein-Instanz-Betrieb.
 *
 * Die Zaehler liegen im Prozessspeicher. Bei zwei Instanzen hinter einem
 * Lastverteiler zaehlt jede fuer sich - das effektive Limit verdoppelt sich,
 * und nach einem Neustart ist der Zaehler leer. Fuer diesen Betrieb (eine
 * Render-Instanz) ist das tragbar und ausdruecklich so entschieden; siehe
 * README, Abschnitt Skalierbarkeit.
 *
 * Der Umbau ist lokal begrenzt: `express-rate-limit` nimmt einen Store, ein
 * Redis-Store waere ein Konstruktorargument hier in dieser Datei. Deshalb geht
 * KEIN anderer Zustand in den Prozessspeicher - Verarbeitungsstatus und
 * Embedding-Cache liegen in der Datenbank.
 */
function build(config: { windowMs: number; max: number }, code: string): RequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // In Tests wuerde das Limit die Testfaelle gegeneinander ausspielen.
    skip: () => isTest,
    handler: (_req, res) => {
      res.status(429).json({
        error: { code, message: 'Zu viele Anfragen. Bitte kurz warten.' },
      });
    },
  });
}

/** Registrierung und Anmeldung - bremst das Durchprobieren von Passwoertern. */
export const authLimiter = build(limits.rateLimit.auth, 'rate_limited_auth');

/** Einlesen einer Quelle - teuer, weil Extraktion und Embeddings dranhaengen. */
export const ingestLimiter = build(limits.rateLimit.ingest, 'rate_limited_ingest');

/** Chat - jede Anfrage kostet einen Modellaufruf. */
export const chatLimiter = build(limits.rateLimit.chat, 'rate_limited_chat');

/** Grobes Netz ueber alles Uebrige. */
export const globalLimiter = build(limits.rateLimit.global, 'rate_limited');
