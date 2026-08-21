import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env, limits } from '../config.js';

const ISSUER = 'notebooklm-clone';

const payloadSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
});

export type TokenPayload = z.infer<typeof payloadSchema>;

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    algorithm: limits.auth.jwtAlgorithm,
    expiresIn: limits.auth.tokenLifetime,
    issuer: ISSUER,
  });
}

/**
 * Gibt bei jedem Problem `null` zurück - abgelaufen, falsch signiert, falscher
 * Aussteller, unpassende Nutzlast. Der Aufrufer hat damit keinen Weg, versehent-
 * lich einen halb geprüften Token zu verwenden.
 *
 * `algorithms` ist der wichtige Teil: ohne diese Angabe akzeptiert die
 * Bibliothek den Algorithmus, der im Token selbst steht. Ein Angreifer setzt
 * dann `alg: none` oder signiert mit RS256, wo der öffentliche Schlüssel als
 * HMAC-Geheimnis missbraucht wird. Der Algorithmus muss vom Server kommen,
 * nicht vom Token.
 */
export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      algorithms: [limits.auth.jwtAlgorithm],
      issuer: ISSUER,
    });
    const parsed = payloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
