import bcrypt from 'bcryptjs';
import { limits } from '../config.js';

/**
 * Kostenfaktor 12 statt des verbreiteten Standards 10: viermal so teür je
 * Versuch, für den anmeldenden Nutzer weiterhin unter ~250 ms.
 */
export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, limits.auth.bcryptRounds);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * Vergleich gegen einen festen Hash. Wird beim Anmeldeversuch mit unbekannter
 * E-Mail ausgeführt, damit "Konto existiert nicht" und "Passwort falsch"
 * gleich lange daürn. Ohne das lässt sich über die Antwortzeit aufzählen,
 * welche E-Mail-Adressen registriert sind - die Fehlermeldung allein
 * gleichzuziehen reicht nicht.
 */
const DUMMY_HASH = bcrypt.hashSync('nicht-vergebenes-passwort', limits.auth.bcryptRounds);

export async function burnTime(plain: string): Promise<void> {
  await bcrypt.compare(plain, DUMMY_HASH);
}
