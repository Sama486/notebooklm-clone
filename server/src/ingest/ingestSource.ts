import { prisma } from '../db.js';
import { limits } from '../config.js';
import { describeError, logger } from '../logger.js';
import { AppError } from '../http/errors.js';
import type { AiClient } from '../ai/types.js';
import { chunkText } from './chunk.js';
import { embedWithCache } from './embeddingCache.js';

/**
 * Verarbeitet eine bereits angelegte Quelle: zerlegen, einbetten, speichern.
 *
 * Laeuft NACH der HTTP-Antwort. Der Endpunkt legt die Quelle mit Status
 * "pending" an und antwortet sofort; diese Funktion arbeitet danach im
 * Hintergrund. Ein achtzigseitiges PDF braucht mehrere Sekunden - eine HTTP-
 * Anfrage so lange offen zu halten bindet einen Verbindungsplatz, laeuft bei
 * jedem Proxy irgendwann ins Zeitlimit und laesst den Nutzer vor einem
 * hängenden Ladebalken sitzen.
 *
 * Der Fortschritt steht im Feld `status` der Datenbank, nicht in einer Map im
 * Prozess. Damit ueberlebt er einen Neustart, und eine zweite Instanz sieht
 * denselben Zustand. Das Frontend fragt den Status ab.
 *
 * Der Vorgang ist WIEDERHOLBAR: zweimal ausgefuehrt entstehen keine doppelten
 * Abschnitte, weil das Schreiben mit dem Loeschen der alten beginnt.
 */
export async function ingestSource(sourceId: string, ai: AiClient): Promise<void> {
  const started = Date.now();

  try {
    // `updateMany` statt `update`: wurde die Quelle inzwischen geloescht, soll
    // das kein Fehler sein, sondern schlicht null betroffene Zeilen. `update`
    // wuerde werfen und die geloeschte Quelle in den Fehlerpfad schicken - mit
    // einer Fehlermeldung im Log fuer einen voellig normalen Vorgang.
    await prisma.source.updateMany({
      where: { id: sourceId },
      data: { status: 'processing', error: null },
    });

    // BENANNTE AUSNAHME von der Regel "Kindobjekte nur ueber ihr Notebook":
    // hier wird eine Quelle ueber ihre eigene ID geladen. Das ist zulaessig,
    // weil diese Funktion kein Zugriffspfad ist - sie laeuft im Hintergrund und
    // die ID kommt nicht von aussen, sondern von dem Endpunkt, der den Besitz
    // bereits geprueft hat (sources/routes.ts). Es gibt keinen Weg, sie mit
    // einer fremden ID aufzurufen.
    const source = await prisma.source.findUnique({
      where: { id: sourceId },
      select: { id: true, notebookId: true, content: true, pageBreaks: true },
    });
    if (!source) {
      // Die Quelle wurde geloescht, waehrend sie in der Warteschlange stand.
      // Kein Fehler - nur nichts mehr zu tun.
      logger.info('Quelle vor der Verarbeitung geloescht', { sourceId });
      return;
    }

    const chunks = chunkText(source.content, source.pageBreaks);
    if (chunks.length === 0) {
      throw new AppError(422, 'no_text', 'Die Quelle enthaelt keinen verwertbaren Text.');
    }

    /**
     * Die Embeddings entstehen VOR der Transaktion.
     *
     * Ein Netzaufruf innerhalb einer offenen Transaktion haelt eine
     * Datenbankverbindung und deren Sperren so lange, wie der fremde Dienst
     * braucht. Bei einem langsamen Anbieter sind das Sekunden je Stapel; bei
     * mehreren gleichzeitigen Einlesevorgaengen ist der Verbindungspool leer,
     * und die Anwendung steht - obwohl die Datenbank nichts zu tun hat. Das
     * sieht man erst unter Last, und dann ist es teuer.
     */
    const embeddings = await embedWithCache(
      ai,
      chunks.map((chunk) => chunk.content),
    );

    // Die Transaktion umfasst nur noch das Schreiben: alte Abschnitte weg,
    // neue rein, Status setzen. Entweder alles davon oder nichts - sonst
    // gaebe es einen Zustand mit halb geloeschten Abschnitten und Status
    // "ready".
    await prisma.$transaction(async (tx) => {
      await tx.chunk.deleteMany({ where: { sourceId: source.id } });
      await tx.chunk.createMany({
        data: chunks.map((chunk, index) => ({
          sourceId: source.id,
          notebookId: source.notebookId,
          index: chunk.index,
          content: chunk.content,
          charStart: chunk.charStart,
          charEnd: chunk.charEnd,
          page: chunk.page ?? null,
          tokenCount: chunk.tokenCount,
          embedding: embeddings[index] as number[],
        })),
      });
      await tx.source.update({
        where: { id: source.id },
        data: { status: 'ready', chunkCount: chunks.length, error: null },
      });
    });

    logger.info('Quelle eingelesen', {
      sourceId,
      chunks: chunks.length,
      dauerMs: Date.now() - started,
    });
  } catch (error) {
    logger.error('Einlesen fehlgeschlagen', { sourceId, ...describeError(error) });

    // Der Nutzer soll sehen, WAS schiefging - aber nur, wenn die Meldung von
    // uns stammt. Bei allem anderen bleibt es bei einem neutralen Satz, damit
    // kein Datenbankfehler oder Stack Trace in der Oberflaeche landet.
    const message =
      error instanceof AppError
        ? error.message
        : 'Beim Verarbeiten ist ein Fehler aufgetreten. Bitte erneut versuchen.';

    await prisma.source
      .updateMany({ where: { id: sourceId }, data: { status: 'failed', error: message } })
      .catch((updateError: unknown) => {
        // Wenn selbst das Setzen des Fehlerstatus scheitert, ist die Datenbank
        // weg. Dann bleibt nur das Log.
        logger.error('Fehlerstatus liess sich nicht setzen', {
          sourceId,
          ...describeError(updateError),
        });
      });
  }
}

/**
 * Startet die Verarbeitung im Hintergrund.
 *
 * Bewusst KEINE Warteschlange mit Redis. Fuer diese Anwendung waere das ein
 * zusaetzlicher Dienst, ein zusaetzlicher Ausfallpunkt und ein zusaetzliches
 * Konzept - fuer einen Vorteil, der erst bei deutlich hoeherem
 * Aufkommen eintritt.
 *
 * BENANNTE ANNAHME: geht der Prozess mitten im Einlesen unter, bleibt die
 * Quelle auf "processing" stehen. Der Zustand ist nicht verloren (er steht in
 * der Datenbank), aber niemand nimmt die Arbeit automatisch wieder auf - der
 * Nutzer stoesst sie ueber "Erneut versuchen" neu an. Ein Aufraeumlauf, der
 * lange haengende Vorgaenge zurueksetzt, waere der naechste Schritt; er steht
 * im README unter "Was als Naechstes kaeme".
 */
export function startIngestInBackground(sourceId: string, ai: AiClient): void {
  void ingestSource(sourceId, ai).catch((error: unknown) => {
    // ingestSource faengt selbst ab; das hier ist das Netz darunter, damit ein
    // Fehler niemals als unbehandelte Promise den Prozess beendet.
    logger.error('Hintergrundverarbeitung abgebrochen', { sourceId, ...describeError(error) });
  });
}

/** Obergrenze fuer die Zahl der Quellen je Notebook, an einer Stelle definiert. */
export const maxSourcesPerNotebook = limits.source.maxPerNotebook;
