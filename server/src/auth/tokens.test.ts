import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { env } from '../config.js';
import { signToken, verifyToken } from './tokens.js';

const payload = { sub: '11111111-1111-4111-8111-111111111111', email: 'a@example.test' };

describe('JWT-Prüfung', () => {
  it('akzeptiert ein selbst ausgestelltes Token', () => {
    expect(verifyToken(signToken(payload))).toEqual(payload);
  });

  it('weist "alg: none" ab', () => {
    // Genau der Angriff, den `algorithms: ['HS256']` beim Verifizieren
    // verhindert: ein Token ganz ohne Signatur.
    const unsigned = jwt.sign(payload, '', { algorithm: 'none', issuer: 'notebooklm-clone' });
    expect(verifyToken(unsigned)).toBeNull();
  });

  it('weist ein Token mit falschem Geheimnis ab', () => {
    const foreign = jwt.sign(payload, 'ein-anderes-geheimnis-mit-genug-länge', {
      algorithm: 'HS256',
      issuer: 'notebooklm-clone',
    });
    expect(verifyToken(foreign)).toBeNull();
  });

  it('weist ein Token mit fremdem Aussteller ab', () => {
    const foreign = jwt.sign(payload, env.JWT_SECRET, {
      algorithm: 'HS256',
      issuer: 'jemand-anderes',
    });
    expect(verifyToken(foreign)).toBeNull();
  });

  it('weist ein abgelaufenes Token ab', () => {
    const expired = jwt.sign(payload, env.JWT_SECRET, {
      algorithm: 'HS256',
      issuer: 'notebooklm-clone',
      expiresIn: -10,
    });
    expect(verifyToken(expired)).toBeNull();
  });

  it('weist ein Token mit unpassender Nutzlast ab', () => {
    // Signatur korrekt, aber `sub` ist keine UUID - die Zod-Prüfung fängt es.
    const odd = jwt.sign({ sub: 'nicht-uuid', email: 'a@example.test' }, env.JWT_SECRET, {
      algorithm: 'HS256',
      issuer: 'notebooklm-clone',
    });
    expect(verifyToken(odd)).toBeNull();
  });
});
