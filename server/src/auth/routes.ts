import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { asyncHandler } from '../http/asyncHandler.js';
import { parseBody } from '../http/validate.js';
import { authLimiter } from '../http/rateLimit.js';
import { conflict, unauthorized } from '../http/errors.js';
import { credentialsSchema } from './schemas.js';
import { burnTime, hashPassword, verifyPassword } from './password.js';
import { signToken } from './tokens.js';
import {
  cleanupExpiredAttempts,
  clearLoginAttempts,
  registerLoginAttempt,
} from './loginThrottle.js';
import { requireAuth, currentUserId } from './middleware.js';

export const authRouter = Router();

/**
 * Eine einzige Meldung für "E-Mail unbekannt" und "Passwort falsch". Zwei
 * unterschiedliche Meldungen würden aus dem Anmeldeformular eine Auskunft
 * darüber machen, welche Adressen registriert sind.
 */
const LOGIN_FAILED = 'E-Mail oder Passwort ist falsch.';

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parseBody(credentialsSchema, req);
    const passwordHash = await hashPassword(password);

    try {
      // Eindeutigkeit erzwingt die Datenbank über @unique, nicht ein
      // vorgelagertes findUnique. Ein Vorabtest wäre ein Wettlauf: zwei
      // gleichzeitige Registrierungen kämen beide durch die Prüfung.
      const user = await prisma.user.create({
        data: { email, passwordHash },
        select: { id: true, email: true },
      });
      res.status(201).json({
        token: signToken({ sub: user.id, email: user.email }),
        user,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw conflict('Diese E-Mail-Adresse ist bereits registriert.', 'email_taken');
      }
      throw error;
    }
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parseBody(credentialsSchema, req);

    // Zählt den Versuch und wirft 429, wenn zu viele auf dieses Konto
    // entfallen. Der Zähler liegt in der Datenbank - Begründung und Messung
    // in loginThrottle.ts.
    await registerLoginAttempt(email);

    // Gelegentlich abgelaufene Fenster wegräumen. Bei etwa jedem
    // fünfzigsten Anmeldeversuch, damit die Tabelle nicht unbegrenzt wächst
    // und trotzdem kein Zeitgeber im Prozess laufen muss.
    if (Math.random() < 0.02) void cleanupExpiredAttempts().catch(() => undefined);

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Gleiche Rechenzeit wie ein echter Fehlversuch, siehe password.ts.
      await burnTime(password);
      throw unauthorized(LOGIN_FAILED, 'login_failed');
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized(LOGIN_FAILED, 'login_failed');
    }

    // Erfolgreiche Anmeldung setzt den Zähler zurück - sonst wäre jemand,
    // der sich mehrfach vertippt hat, beim nächsten Mal ausgesperrt.
    await clearLoginAttempts(email);

    res.json({
      token: signToken({ sub: user.id, email: user.email }),
      user: { id: user.id, email: user.email },
    });
  }),
);

/** Bestätigt dem Frontend, dass der gespeicherte Token noch gilt. */
authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: currentUserId(req) },
      select: { id: true, email: true, createdAt: true },
    });
    if (!user) throw unauthorized();
    res.json({ user });
  }),
);
