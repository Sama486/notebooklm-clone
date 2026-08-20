import { PrismaClient } from '@prisma/client';

// Ein einziger PrismaClient fuer den gesamten Prozess. Mehrere Instanzen wuerden
// jeweils einen eigenen Verbindungspool aufmachen und die Datenbank ausgehen
// lassen, lange bevor die Anwendung selbst an eine Grenze kaeme.
//
// `warn` und `error` gehen an stderr; Abfragen werden bewusst nicht geloggt,
// weil sie Nutzerinhalte enthalten koennen.
export const prisma = new PrismaClient({ log: ['warn', 'error'] });
