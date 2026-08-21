import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../db.js';
import { resetDatabase } from '../test/helpers.js';

describe('Registrierung und Anmeldung', () => {
  let app: Express;
  const email = 'anmeldung@example.test';
  const password = 'ein-sicheres-testpasswort';

  beforeAll(async () => {
    app = createApp();
    await resetDatabase();
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it('registriert und liefert ein Token', async () => {
    const res = await request(app).post('/api/auth/register').send({ email, password });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user.email).toBe(email);
    // Der Hash darf die Anwendung nie verlassen.
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('speichert das Passwort als bcrypt-Hash mit Kostenfaktor 12', async () => {
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user?.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(user?.passwordHash).not.toContain(password);
  });

  it('lehnt eine zweite Registrierung mit derselben E-Mail ab', async () => {
    const res = await request(app).post('/api/auth/register').send({ email, password });
    expect(res.status).toBe(409);
  });

  it('meldet an', async () => {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
  });

  it('gibt bei falschem Passwort und unbekannter E-Mail dieselbe Antwort', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'ein-völlig-falsches-passwort' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'gibtesnicht@example.test', password });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Identisch bis aufs Zeichen - sonst lässt sich aus der Antwort ablesen,
    // welche Adressen registriert sind.
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it('weist zu kurze Passwörter und kaputte E-Mails ab', async () => {
    const shortPassword = await request(app)
      .post('/api/auth/register')
      .send({ email: 'neu@example.test', password: 'kurz' });
    const badEmail = await request(app)
      .post('/api/auth/register')
      .send({ email: 'keine-email', password });

    expect(shortPassword.status).toBe(400);
    expect(badEmail.status).toBe(400);
  });

  it('ignoriert Felder, die nicht im Schema stehen', async () => {
    // Der Body wird nie als Ganzes an Prisma gereicht - Zod gibt nur die
    // deklarierten Felder zurück. Ein mitgeschicktes `id` hat keine Wirkung.
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        email: 'extra@example.test',
        password,
        id: '99999999-9999-4999-8999-999999999999',
        isAdmin: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.user.id).not.toBe('99999999-9999-4999-8999-999999999999');
  });
});
