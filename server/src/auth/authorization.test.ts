import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../db.js';
import { auth, createNotebook, createUser, resetDatabase, type TestUser } from '../test/helpers.js';

/**
 * Der wichtigste Test des Projekts: Nutzer A legt ein Notebook an, Nutzer B
 * versucht es zu lesen, zu aendern und zu loeschen. Erwartet wird jedes Mal 404.
 *
 * 404 und nicht 403 ist der Punkt: ein 403 wuerde bestaetigen, dass die ID
 * existiert. Wer fremde IDs kennt oder erraet, koennte damit die Existenz
 * fremder Notebooks pruefen, auch ohne an den Inhalt zu kommen.
 */
describe('Autorisierung: fremde Notebooks sind nicht erreichbar', () => {
  let app: Express;
  let alice: TestUser;
  let bob: TestUser;
  let aliceNotebook: string;

  beforeAll(async () => {
    app = createApp();
    await resetDatabase();
    alice = await createUser(app);
    bob = await createUser(app);
    aliceNotebook = await createNotebook(app, alice, 'Alices Notizbuch');
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  it('Alice erreicht ihr eigenes Notebook', async () => {
    const res = await request(app).get(`/api/notebooks/${aliceNotebook}`).set(auth(alice));
    expect(res.status).toBe(200);
    expect(res.body.notebook.title).toBe('Alices Notizbuch');
  });

  it('Bob bekommt 404 beim Lesen', async () => {
    const res = await request(app).get(`/api/notebooks/${aliceNotebook}`).set(auth(bob));
    expect(res.status).toBe(404);
    // Die Antwort verraet nichts ueber die Existenz der Ressource.
    expect(JSON.stringify(res.body)).not.toContain('Alices');
  });

  it('Bob bekommt 404 beim Aendern', async () => {
    const res = await request(app)
      .patch(`/api/notebooks/${aliceNotebook}`)
      .set(auth(bob))
      .send({ title: 'Uebernommen' });
    expect(res.status).toBe(404);
  });

  it('Bob bekommt 404 beim Loeschen - und das Notebook lebt noch', async () => {
    const res = await request(app).delete(`/api/notebooks/${aliceNotebook}`).set(auth(bob));
    expect(res.status).toBe(404);

    const still = await prisma.notebook.findUnique({ where: { id: aliceNotebook } });
    expect(still).not.toBeNull();
  });

  it('Bobs Liste enthaelt Alices Notebook nicht', async () => {
    const res = await request(app).get('/api/notebooks').set(auth(bob));
    expect(res.status).toBe(200);
    expect(res.body.notebooks).toHaveLength(0);
  });

  it('ohne Token gibt es 401, nicht 404', async () => {
    // Unterschied mit Absicht: "nicht angemeldet" ist keine Aussage ueber eine
    // bestimmte Ressource und darf deshalb ehrlich beantwortet werden.
    const res = await request(app).get(`/api/notebooks/${aliceNotebook}`);
    expect(res.status).toBe(401);
  });

  it('ein manipuliertes Token wird abgewiesen', async () => {
    const forged = alice.token.slice(0, -3) + 'aaa';
    const res = await request(app)
      .get(`/api/notebooks/${aliceNotebook}`)
      .set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});
