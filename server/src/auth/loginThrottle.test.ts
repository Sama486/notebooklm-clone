import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../db.js';
import { limits } from '../config.js';
import { resetDatabase } from '../test/helpers.js';
import { cleanupExpiredAttempts, clearLoginAttempts, registerLoginAttempt } from './loginThrottle.js';

/**
 * Anders als die uebrigen Rate-Limits wird dieses hier tatsaechlich getestet.
 *
 * Die Limits aus http/rateLimit.ts sind im Testlauf abgeschaltet, weil sie
 * sonst die Testfaelle gegeneinander ausspielen wuerden. Beim Schutz gegen das
 * Durchprobieren von Passwoertern waere das die falsche Abwaegung: eine
 * Schutzmassnahme, die nie ausgefuehrt wird, ist keine.
 */
describe('Begrenzung der Anmeldeversuche', () => {
  const max = limits.rateLimit.auth.max;

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it('laesst die erlaubte Anzahl durch und blockt danach', async () => {
    const email = 'opfer@example.test';

    for (let attempt = 1; attempt <= max; attempt += 1) {
      await expect(registerLoginAttempt(email), `Versuch ${attempt}`).resolves.toBeUndefined();
    }
    await expect(registerLoginAttempt(email)).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited_auth',
    });
  });

  it('zaehlt je Konto getrennt', async () => {
    // Ein ausgesperrtes Konto darf kein anderes aussperren.
    for (let attempt = 0; attempt <= max; attempt += 1) {
      await registerLoginAttempt('erstes@example.test').catch(() => undefined);
    }
    await expect(registerLoginAttempt('zweites@example.test')).resolves.toBeUndefined();
  });

  it('setzt nach erfolgreicher Anmeldung zurueck', async () => {
    const email = 'vertipper@example.test';
    for (let attempt = 0; attempt < max; attempt += 1) await registerLoginAttempt(email);

    await clearLoginAttempts(email);

    // Wieder von vorn - wer sich vertippt und dann richtig anmeldet, ist beim
    // naechsten Vertippen nicht ausgesperrt.
    await expect(registerLoginAttempt(email)).resolves.toBeUndefined();
  });

  it('beginnt nach Ablauf des Fensters von vorn', async () => {
    const email = 'geduldig@example.test';
    for (let attempt = 0; attempt < max; attempt += 1) await registerLoginAttempt(email);

    // Fenster kuenstlich in die Vergangenheit setzen.
    await prisma.loginAttempt.update({
      where: { key: `login:${email}` },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(registerLoginAttempt(email)).resolves.toBeUndefined();
    const row = await prisma.loginAttempt.findUniqueOrThrow({ where: { key: `login:${email}` } });
    expect(row.count).toBe(1);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('zaehlt gleichzeitige Versuche vollstaendig', async () => {
    // Der eigentliche Grund fuer die eine Datenbankanweisung: mit getrenntem
    // Lesen und Schreiben wuerden gleichzeitige Versuche denselben alten Wert
    // lesen und das Limit gemeinsam ueberschreiten.
    const email = 'gleichzeitig@example.test';
    const versuche = 20;

    const ergebnisse = await Promise.all(
      Array.from({ length: versuche }, () =>
        registerLoginAttempt(email).then(
          () => 'durch' as const,
          () => 'geblockt' as const,
        ),
      ),
    );

    expect(ergebnisse.filter((e) => e === 'durch')).toHaveLength(max);
    expect(ergebnisse.filter((e) => e === 'geblockt')).toHaveLength(versuche - max);
  });

  it('raeumt abgelaufene Fenster weg', async () => {
    await registerLoginAttempt('alt@example.test');
    await prisma.loginAttempt.update({
      where: { key: 'login:alt@example.test' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await registerLoginAttempt('neu@example.test');

    expect(await cleanupExpiredAttempts()).toBe(1);
    expect(await prisma.loginAttempt.count()).toBe(1);
  });

  it('greift auch ueber den Endpunkt', async () => {
    const app = createApp();
    const email = 'endpunkt@example.test';
    const body = { email, password: 'ein-falsches-testpasswort' };

    for (let attempt = 0; attempt < max; attempt += 1) {
      const res = await request(app).post('/api/auth/login').send(body);
      expect(res.status).toBe(401);
    }

    const geblockt = await request(app).post('/api/auth/login').send(body);
    expect(geblockt.status).toBe(429);
    // Die Meldung sagt, wie lange - sonst probiert der Nutzer im Sekundentakt
    // weiter und versteht nicht, warum nichts passiert.
    expect(geblockt.body.error.message).toMatch(/\d+ Sekunden/);
  });
});
