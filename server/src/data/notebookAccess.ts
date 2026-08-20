import type { Notebook } from '@prisma/client';
import { prisma } from '../db.js';
import { notFound } from '../http/errors.js';

/**
 * DER Zugriffspfad. Jede Anfrage auf Nutzerdaten faengt hier an.
 *
 * Zwei Regeln, die zusammen die Mandantentrennung tragen:
 *
 * 1. Besitz wird IM Zugriffspfad geprueft, nicht daneben. Die Abfrage lautet
 *    `findFirst({ where: { id, userId } })` - nicht `findUnique({ id })` mit
 *    anschliessendem `if (nb.userId !== userId)`. Der Unterschied ist nicht
 *    kosmetisch: bei der zweiten Form ist die Zeile, die den Zugriff verbietet,
 *    von der Zeile getrennt, die die Daten holt. Genau diese Zeile wird beim
 *    naechsten Umbau vergessen. Hier gibt es keine Zeile zum Vergessen - eine
 *    Abfrage ohne `userId` liefert schlicht nichts.
 *
 * 2. Der Einstieg ist IMMER das Notebook. Quellen, Abschnitte und Nachrichten
 *    tragen kein `userId`; sie erben die Trennung ueber ihr Notebook. Deshalb
 *    wird nie eine Quelle ueber ihre eigene ID geladen, sondern immer erst das
 *    Notebook gegen `userId` aufgeloest und dann das Kindobjekt ueber
 *    `notebookId` eingeschraenkt.
 *
 * Und: die Antwort ist 404, nicht 403. Ein 403 wuerde bestaetigen, dass die ID
 * existiert - damit liessen sich fremde Notebook-IDs durch Ausprobieren
 * verifizieren, auch ohne an den Inhalt zu kommen.
 */
export async function requireNotebook(notebookId: string, userId: string): Promise<Notebook> {
  const notebook = await prisma.notebook.findFirst({
    where: { id: notebookId, userId },
  });
  if (!notebook) throw notFound('Notebook nicht gefunden.');
  return notebook;
}

/**
 * Loest eine Quelle innerhalb eines Notebooks auf, das dem Nutzer gehoert.
 *
 * Der `where`-Block enthaelt beide Bedingungen: die Quelle muss diese ID haben
 * UND in einem Notebook liegen, das diesem Nutzer gehoert. Auch das ist eine
 * einzige Abfrage ohne nachgelagerte Pruefung.
 */
export async function requireSource(sourceId: string, notebookId: string, userId: string) {
  const source = await prisma.source.findFirst({
    where: { id: sourceId, notebookId, notebook: { userId } },
  });
  if (!source) throw notFound('Quelle nicht gefunden.');
  return source;
}
