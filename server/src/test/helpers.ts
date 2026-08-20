import type { Express } from 'express';
import request from 'supertest';
import { prisma } from '../db.js';

/**
 * Leert alle Tabellen. `User` reicht nicht - der Embedding-Cache haengt an
 * keinem Nutzer. Notebooks und ihre Kinder verschwinden per Cascade.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.embeddingCache.deleteMany();
  await prisma.user.deleteMany();
}

let counter = 0;

export interface TestUser {
  email: string;
  password: string;
  token: string;
  id: string;
}

/** Legt einen Nutzer ueber den echten Registrierungsendpunkt an. */
export async function createUser(app: Express): Promise<TestUser> {
  counter += 1;
  const email = `nutzer${counter}.${Date.now()}@example.test`;
  const password = 'ein-sicheres-testpasswort';

  const res = await request(app).post('/api/auth/register').send({ email, password });
  if (res.status !== 201) {
    throw new Error(`Registrierung fehlgeschlagen: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { email, password, token: res.body.token, id: res.body.user.id };
}

export const auth = (user: TestUser) => ({ Authorization: `Bearer ${user.token}` });

export async function createNotebook(
  app: Express,
  user: TestUser,
  title = 'Testnotizbuch',
): Promise<string> {
  const res = await request(app).post('/api/notebooks').set(auth(user)).send({ title });
  if (res.status !== 201) {
    throw new Error(`Notebook anlegen fehlgeschlagen: ${res.status}`);
  }
  return res.body.notebook.id;
}
