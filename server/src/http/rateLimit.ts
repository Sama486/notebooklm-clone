import rateLimit from 'express-rate-limit';
import type { RequestHandler } from 'express';
import { limits } from '../config.js';
import { isTest } from '../config.js';

/**
 * BENANNTE ANNAHME: Ein-Instanz-Betrieb.
 *
 * Die Zähler liegen im Prozessspeicher. Bei zwei Instanzen hinter einem
 * Lastverteiler zählt jede für sich - das effektive Limit verdoppelt sich,
 * und nach einem Neustart ist der Zähler leer. Beim derzeitigen Betrieb mit
 * einer Instanz ist das tragbar und ausdrücklich so entschieden; siehe
 * README, Abschnitt Skalierbarkeit.
 *
 * Der Umbau ist lokal begrenzt: `express-rate-limit` nimmt einen Store, ein
 * Redis-Store wäre ein Konstruktorargument hier in dieser Datei. Deshalb geht
 * KEIN anderer Zustand in den Prozessspeicher - Verarbeitungsstatus und
 * Embedding-Cache liegen in der Datenbank.
 */
function build(config: { windowMs: number; max: number }, code: string): RequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // In Tests würde das Limit die Testfälle gegeneinander ausspielen.
    skip: () => isTest,
    handler: (_req, res) => {
      res.status(429).json({
        error: { code, message: 'Zu viele Anfragen. Bitte kurz warten.' },
      });
    },
  });
}

/** Registrierung und Anmeldung - bremst das Durchprobieren von Passwörtern. */
export const authLimiter = build(limits.rateLimit.auth, 'rate_limited_auth');

/** Einlesen einer Quelle - teür, weil Extraktion und Embeddings dranhängen. */
export const ingestLimiter = build(limits.rateLimit.ingest, 'rate_limited_ingest');

/** Chat - jede Anfrage kostet einen Modellaufruf. */
export const chatLimiter = build(limits.rateLimit.chat, 'rate_limited_chat');

/** Grobes Netz über alles Übrige. */
export const globalLimiter = build(limits.rateLimit.global, 'rate_limited');
