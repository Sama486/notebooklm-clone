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
import { requireAuth, currentUserId } from './middleware.js';

export const authRouter = Router();

/**
 * Eine einzige Meldung fuer "E-Mail unbekannt" und "Passwort falsch". Zwei
 * unterschiedliche Meldungen wuerden aus dem Anmeldeformular eine Auskunft
 * darueber machen, welche Adressen registriert sind.
 */
const LOGIN_FAILED = 'E-Mail oder Passwort ist falsch.';

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = parseBody(credentialsSchema, req);
    const passwordHash = await hashPassword(password);

    try {
      // Eindeutigkeit erzwingt die Datenbank ueber @unique, nicht ein
      // vorgelagertes findUnique. Ein Vorabtest waere ein Wettlauf: zwei
      // gleichzeitige Registrierungen kaemen beide durch die Pruefung.
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
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Gleiche Rechenzeit wie ein echter Fehlversuch, siehe password.ts.
      await burnTime(password);
      throw unauthorized(LOGIN_FAILED, 'login_failed');
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized(LOGIN_FAILED, 'login_failed');
    }

    res.json({
      token: signToken({ sub: user.id, email: user.email }),
      user: { id: user.id, email: user.email },
    });
  }),
);

/** Bestaetigt dem Frontend, dass der gespeicherte Token noch gilt. */
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
