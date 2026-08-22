import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../app.js';
import { prisma } from '../db.js';
import { limits } from '../config.js';
import { auth, createNotebook, createUser, resetDatabase, type TestUser } from '../test/helpers.js';

const beleg = {
  marker: 1,
  chunkId: '11111111-1111-4111-8111-111111111111',
  sourceId: '22222222-2222-4222-8222-222222222222',
  sourceTitle: 'Handbuch',
  charStart: 0,
  charEnd: 120,
  page: 2,
  snippet: 'Die Antwort ist 404 und nicht 403.',
};

describe('Notizen', () => {
  let app: Express;
  let alice: TestUser;
  let bob: TestUser;
  let notebookId: string;

  beforeAll(async () => {
    app = createApp();
    await resetDatabase();
    alice = await createUser(app);
    bob = await createUser(app);
  });

  beforeEach(async () => {
    notebookId = await createNotebook(app, alice);
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const anlegen = (user: TestUser, body: Record<string, unknown>) =>
    request(app).post(`/api/notebooks/${notebookId}/notes`).set(auth(user)).send(body);

  describe('Anlegen, lesen, ändern, löschen', () => {
    it('legt eine Notiz an und gibt sie zurück', async () => {
      const res = await anlegen(alice, { title: 'Merkposten', content: 'Erst Notebook, dann Kind.' });

      expect(res.status).toBe(201);
      expect(res.body.note).toMatchObject({ title: 'Merkposten', content: 'Erst Notebook, dann Kind.' });
      // `notebookId` gehört nicht in die Antwort - der Aufrufer kennt es bereits
      // aus der URL, und was nicht rausgeht, kann nicht verwechselt werden.
      expect(res.body.note.notebookId).toBeUndefined();
    });

    it('behält die Belege einer gespeicherten Antwort', async () => {
      const res = await anlegen(alice, {
        title: 'Antwort zu 404',
        content: 'Ein 403 würde die Existenz bestätigen.',
        citations: [beleg],
      });

      expect(res.status).toBe(201);
      expect(res.body.note.citations).toHaveLength(1);
      // Die Zeichen-Positionen überleben den Weg durch die Datenbank - sonst
      // wären die Chips in der Notiz nicht mehr anklickbar.
      expect(res.body.note.citations[0]).toMatchObject({ marker: 1, charStart: 0, charEnd: 120 });
    });

    it('behält die Position der Belege im Notiztext', async () => {
      // Eine gesicherte Antwort bringt ihre Marker mit. Ohne Zerlegung stünde
      // die Nummer als Text da und die Chips hingen gesammelt am Ende.
      const res = await anlegen(alice, {
        title: 'Gesicherte Antwort',
        content: 'Die Antwort ist 404[1] und nicht 403.',
        citations: [beleg],
      });

      expect(res.status).toBe(201);
      // Der reine Wortlaut kommt ohne Marker.
      expect(res.body.note.content).toBe('Die Antwort ist 404 und nicht 403.');

      const mitMarkern = (res.body.note.segments as { text: string; markers: number[] }[])
        .map((s) => s.text + s.markers.map((m) => `<${m}>`).join(''))
        .join('');
      expect(mitMarkern).toBe('Die Antwort ist 404<1> und nicht 403.');
    });

    it('listet die neuesten zuerst', async () => {
      await anlegen(alice, { title: 'Erste', content: 'Inhalt' });
      await anlegen(alice, { title: 'Zweite', content: 'Inhalt' });

      const res = await request(app).get(`/api/notebooks/${notebookId}/notes`).set(auth(alice));
      expect(res.status).toBe(200);
      expect(res.body.notes.map((n: { title: string }) => n.title)).toEqual(['Zweite', 'Erste']);
    });

    it('ändert Titel und Inhalt', async () => {
      const angelegt = await anlegen(alice, { title: 'Alt', content: 'Alter Inhalt' });
      const res = await request(app)
        .patch(`/api/notebooks/${notebookId}/notes/${angelegt.body.note.id}`)
        .set(auth(alice))
        .send({ title: 'Neu' });

      expect(res.status).toBe(200);
      expect(res.body.note.title).toBe('Neu');
      expect(res.body.note.content).toBe('Alter Inhalt');
    });

    it('löscht', async () => {
      const angelegt = await anlegen(alice, { title: 'Weg damit', content: 'Inhalt' });
      const res = await request(app)
        .delete(`/api/notebooks/${notebookId}/notes/${angelegt.body.note.id}`)
        .set(auth(alice));

      expect(res.status).toBe(204);
      expect(await prisma.note.count({ where: { notebookId } })).toBe(0);
    });

    it('verschwindet mit dem Notebook', async () => {
      await anlegen(alice, { title: 'Haengt dran', content: 'Inhalt' });
      await request(app).delete(`/api/notebooks/${notebookId}`).set(auth(alice));

      // Die Datenbank räumt per onDelete: Cascade auf, nicht der Anwendungscode.
      expect(await prisma.note.count({ where: { notebookId } })).toBe(0);
    });
  });

  describe('Eingabeprüfung', () => {
    it('lehnt leere und zu lange Felder ab', async () => {
      expect((await anlegen(alice, { title: '  ', content: 'Inhalt' })).status).toBe(400);
      expect((await anlegen(alice, { title: 'Titel', content: '  ' })).status).toBe(400);
      expect((await anlegen(alice, { title: 'x'.repeat(500), content: 'Inhalt' })).status).toBe(400);
      expect(
        (await anlegen(alice, { title: 'Titel', content: 'x'.repeat(limits.note.contentMax + 1) }))
          .status,
      ).toBe(400);
    });

    it('lehnt Belege in unerwarteter Form ab', async () => {
      // Das Json-Feld ist die bequemste Stelle, an der sich unerwartete Formen
      // einschleichen - deshalb ist es genauso eng validiert wie alles andere.
      const kaputt = [
        { citations: [{ ...beleg, marker: 'eins' }] },
        { citations: [{ ...beleg, chunkId: 'keine-uuid' }] },
        { citations: [{ ...beleg, snippet: 'x'.repeat(5000) }] },
        { citations: 'gar keine Liste' },
        { citations: Array.from({ length: 50 }, () => beleg) },
      ];
      for (const zusatz of kaputt) {
        const res = await anlegen(alice, { title: 'Titel', content: 'Inhalt', ...zusatz });
        expect(res.status, JSON.stringify(zusatz).slice(0, 60)).toBe(400);
      }
    });

    it('ignoriert Felder, die nicht im Schema stehen', async () => {
      const res = await anlegen(alice, {
        title: 'Titel',
        content: 'Inhalt',
        notebookId: '99999999-9999-4999-8999-999999999999',
        id: '88888888-8888-4888-8888-888888888888',
      });

      expect(res.status).toBe(201);
      expect(res.body.note.id).not.toBe('88888888-8888-4888-8888-888888888888');
      // Die Notiz liegt im Notebook aus der URL, nicht im mitgeschickten.
      expect(await prisma.note.count({ where: { notebookId } })).toBe(1);
    });

    it('lehnt einen leeren Änderungsrumpf ab', async () => {
      const angelegt = await anlegen(alice, { title: 'Titel', content: 'Inhalt' });
      const res = await request(app)
        .patch(`/api/notebooks/${notebookId}/notes/${angelegt.body.note.id}`)
        .set(auth(alice))
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('Autorisierung', () => {
    it('Bob kommt an Alices Notizen nicht heran', async () => {
      const angelegt = await anlegen(alice, { title: 'Privat', content: 'Vertraulich' });
      const noteId = angelegt.body.note.id;
      const base = `/api/notebooks/${notebookId}/notes`;

      expect((await request(app).get(base).set(auth(bob))).status).toBe(404);
      expect((await request(app).post(base).set(auth(bob)).send({ title: 'X', content: 'Y' })).status)
        .toBe(404);
      expect(
        (await request(app).patch(`${base}/${noteId}`).set(auth(bob)).send({ title: 'Gekapert' }))
          .status,
      ).toBe(404);
      expect((await request(app).delete(`${base}/${noteId}`).set(auth(bob))).status).toBe(404);

      // Nichts davon hat gewirkt.
      const unberührt = await prisma.note.findUniqueOrThrow({ where: { id: noteId } });
      expect(unberührt.title).toBe('Privat');
      expect(await prisma.note.count({ where: { notebookId } })).toBe(1);
    });

    it('eine Notiz-ID aus einem anderen Notebook wird nicht aufgelöst', async () => {
      // Der Kern der Regel: beide Notebooks gehören Alice, aber die Notiz liegt
      // im anderen. Eine reine userId-Prüfung hätte das durchgelassen.
      const angelegt = await anlegen(alice, { title: 'Woanders', content: 'Inhalt' });
      const zweites = await createNotebook(app, alice, 'Zweites');

      const res = await request(app)
        .patch(`/api/notebooks/${zweites}/notes/${angelegt.body.note.id}`)
        .set(auth(alice))
        .send({ title: 'Verschoben' });

      expect(res.status).toBe(404);
      const unberührt = await prisma.note.findUniqueOrThrow({ where: { id: angelegt.body.note.id } });
      expect(unberührt.title).toBe('Woanders');
    });

    it('ohne Token gibt es 401', async () => {
      expect((await request(app).get(`/api/notebooks/${notebookId}/notes`)).status).toBe(401);
    });
  });

  describe('Obergrenze', () => {
    it('lehnt ab, wenn das Notebook voll ist', async () => {
      // Direkt in der Datenbank anlegen - zweihundert Aufrufe über die API
      // würden den Testlauf ohne Erkenntnisgewinn in die Länge ziehen.
      await prisma.note.createMany({
        data: Array.from({ length: limits.note.maxPerNotebook }, (_, i) => ({
          notebookId,
          title: `Notiz ${i}`,
          content: 'Inhalt',
        })),
      });

      const res = await anlegen(alice, { title: 'Eine zu viel', content: 'Inhalt' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('too_many_notes');
    });
  });
});
