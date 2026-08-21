import { prisma } from '../db.js';
import { limits } from '../config.js';
import { AppError } from '../http/errors.js';

/**
 * Begrenzt die Anmeldeversuche je Konto - mit dem Zaehler in der Datenbank.
 *
 * WARUM NICHT DER ZAEHLER IM PROZESSSPEICHER (wie bei den uebrigen Limits):
 *
 * Die Annahme "eine Instanz" wurde gegen die laufende Installation gemessen und
 * ist dort bereits falsch. Aufeinanderfolgende Anmeldeversuche bekamen
 * Antworten mit unterschiedlichen Fensterenden zurueck (reset=900, 818, 814,
 * 860 ...) - also mehrere voneinander unabhaengige Zaehler. Ein Angreifer, der
 * Passwoerter durchprobiert, bekommt damit ein Vielfaches der zehn erlaubten
 * Versuche, ohne irgendetwas dafuer tun zu muessen.
 *
 * Bei einem Kostenlimit waere das hinnehmbar. Beim Schutz gegen das
 * Durchprobieren von Passwoertern ist es das nicht: eine Schutzmassnahme, die
 * nicht wirkt, ist schlimmer als keine, weil sie Sicherheit vortaeuscht.
 *
 * WARUM DER SCHLUESSEL DIE E-MAIL IST UND NICHT DIE IP:
 *
 * Hinter Renders Proxy ist die Absender-IP nicht verlaesslich (genau das hat
 * die Messung oben gezeigt). Die E-Mail ist dagegen genau das, was geschuetzt
 * werden soll: das einzelne Konto. Ein Angreifer mit wechselnden IPs bekommt
 * trotzdem nur zehn Versuche gegen dieses Konto.
 *
 * Der Preis, offen benannt: wer viele verschiedene Konten mit je wenigen
 * Passwoertern durchprobiert (Password Spraying), wird hiervon nicht gebremst.
 * Dagegen hilft eine verlaessliche Absenderkennung - siehe README,
 * "Was als Naechstes kaeme".
 */

/** Zaehlt einen Versuch und wirft 429, wenn das Fenster voll ist. */
export async function registerLoginAttempt(email: string): Promise<void> {
  const { windowMs, max } = limits.rateLimit.auth;
  const key = `login:${email}`;
  const expiresAt = new Date(Date.now() + windowMs);

  // Eine einzige Anweisung, damit Zaehlen und Pruefen nicht auseinanderfallen.
  // Mit getrenntem Lesen und Schreiben koennten zwei gleichzeitige Versuche
  // beide denselben alten Wert lesen und das Limit gemeinsam ueberschreiten.
  //
  // Ist das Fenster abgelaufen, beginnt der Zaehler wieder bei 1 - deshalb die
  // Fallunterscheidung direkt in der Anweisung statt einer vorherigen Abfrage.
  const rows = await prisma.$queryRaw<{ count: number; expiresAt: Date }[]>`
    INSERT INTO "LoginAttempt" ("key", "count", "expiresAt")
    VALUES (${key}, 1, ${expiresAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "LoginAttempt"."expiresAt" < NOW() THEN 1
        ELSE "LoginAttempt"."count" + 1
      END,
      "expiresAt" = CASE
        WHEN "LoginAttempt"."expiresAt" < NOW() THEN ${expiresAt}
        ELSE "LoginAttempt"."expiresAt"
      END
    RETURNING "count", "expiresAt"
  `;

  const attempt = rows[0];
  if (attempt && attempt.count > max) {
    const seconds = Math.max(1, Math.ceil((attempt.expiresAt.getTime() - Date.now()) / 1000));
    throw new AppError(
      429,
      'rate_limited_auth',
      `Zu viele Anmeldeversuche. Bitte in ${seconds} Sekunden erneut versuchen.`,
    );
  }
}

/**
 * Loescht den Zaehler nach erfolgreicher Anmeldung.
 *
 * Ohne das wuerde jemand, der sich zehnmal am Tag vertippt und dann richtig
 * anmeldet, beim naechsten Vertippen ausgesperrt.
 */
export async function clearLoginAttempts(email: string): Promise<void> {
  await prisma.loginAttempt.deleteMany({ where: { key: `login:${email}` } });
}

/**
 * Raeumt abgelaufene Fenster weg.
 *
 * Ohne Aufraeumen waechst die Tabelle mit jeder je verwendeten E-Mail-Adresse.
 * Laeuft gelegentlich statt regelmaessig - ein Zeitgeber im Prozess waere
 * wieder Zustand, der bei mehreren Instanzen mehrfach liefe.
 */
export async function cleanupExpiredAttempts(): Promise<number> {
  const { count } = await prisma.loginAttempt.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return count;
}
