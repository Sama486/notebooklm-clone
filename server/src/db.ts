import { PrismaClient } from '@prisma/client';

// Ein einziger PrismaClient für den gesamten Prozess. Mehrere Instanzen würden
// jeweils einen eigenen Verbindungspool aufmachen und die Datenbank ausgehen
// lassen, lange bevor die Anwendung selbst an eine Grenze käme.
//
// `warn` und `error` gehen an stderr; Abfragen werden bewusst nicht geloggt,
// weil sie Nutzerinhalte enthalten können.
export const prisma = new PrismaClient({ log: ['warn', 'error'] });
