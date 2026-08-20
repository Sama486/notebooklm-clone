import bcrypt from 'bcryptjs';
import { limits } from '../config.js';

/**
 * Kostenfaktor 12 statt des verbreiteten Standards 10: viermal so teuer je
 * Versuch, fuer den anmeldenden Nutzer weiterhin unter ~250 ms.
 */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, limits.auth.bcryptRounds);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Vergleich gegen einen festen Hash. Wird beim Anmeldeversuch mit unbekannter
 * E-Mail ausgefuehrt, damit "Konto existiert nicht" und "Passwort falsch"
 * gleich lange dauern. Ohne das laesst sich ueber die Antwortzeit aufzaehlen,
 * welche E-Mail-Adressen registriert sind - die Fehlermeldung allein
 * gleichzuziehen reicht nicht.
 */
const DUMMY_HASH = bcrypt.hashSync('nicht-vergebenes-passwort', limits.auth.bcryptRounds);

export async function burnTime(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}
