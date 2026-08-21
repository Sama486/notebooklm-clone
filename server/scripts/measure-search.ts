/**
 * Misst die Ähnlichkeitssuche gegen synthetische Datenmengen.
 *
 * Die Suche ist ein exakter Durchlauf über alle Abschnitte eines Notebooks -
 * eine bewusste Entscheidung gegen einen Vektor-Index. Eine solche Entscheidung
 * ist nur dann eine Entscheidung und kein Versäumnis, wenn man sagen kann, ab
 * wann sie nicht mehr trägt. Dieses Skript liefert die Zahlen dafür.
 *
 * Gemessen werden getrennt:
 *   - die Datenbankabfrage (alle Abschnitte des Notebooks holen)
 *   - die Rangfolge im Speicher (Kosinus gegen jeden Abschnitt)
 * Der interessante Teil ist die Aufteilung: wenn die Abfrage dominiert, ist das
 * Nadelöhr die übertragene Datenmenge und nicht die Rechenzeit.
 *
 * Aufruf:  npm run measure
 * Läuft gegen TEST_DATABASE_URL und räumt hinterher auf.
 */
import { PrismaClient } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import { limits } from '../src/config.js';
import { rankBySimilarity } from '../src/chat/similarity.js';
import { resolveTestDatabaseUrl } from '../src/test/testDatabaseUrl.js';

const DIMENSIONS = limits.embedding.dimensions;
const SIZES = [100, 1_000, 10_000];
const RUNS = 5;

const prisma = new PrismaClient({
  datasources: { db: { url: resolveTestDatabaseUrl() } },
});

/** Zufälliger Einheitsvektor - dieselbe Form wie ein echtes Embedding. */
function randomEmbedding(): number[] {
  const values = Array.from({ length: DIMENSIONS }, () => Math.random() - 0.5);
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / length);
}

async function seed(chunkCount: number): Promise<{ notebookId: string; userId: string }> {
  const user = await prisma.user.create({
    data: { email: `messung.${Date.now()}@example.test`, passwordHash: 'nicht-verwendet' },
  });
  const notebook = await prisma.notebook.create({
    data: { userId: user.id, title: `Messung ${chunkCount}` },
  });
  const source = await prisma.source.create({
    data: {
      notebookId: notebook.id,
      title: 'Synthetisch',
      type: 'text',
      content: '',
      sizeBytes: 0,
      status: 'ready',
      chunkCount,
    },
  });

  // In Stapeln schreiben: 10.000 Zeilen auf einmal sprengen die Grenze für
  // Abfrageparameter.
  const batchSize = 500;
  for (let start = 0; start < chunkCount; start += batchSize) {
    const size = Math.min(batchSize, chunkCount - start);
    await prisma.chunk.createMany({
      data: Array.from({ length: size }, (_, offset) => ({
        sourceId: source.id,
        notebookId: notebook.id,
        index: start + offset,
        content: `Synthetischer Abschnitt ${start + offset}.`,
        charStart: 0,
        charEnd: 40,
        tokenCount: 12,
        embedding: randomEmbedding(),
      })),
    });
  }

  return { notebookId: notebook.id, userId: user.id };
}

async function measure(notebookId: string, chunkCount: number) {
  const query = randomEmbedding();
  const queryTimes: number[] = [];
  const rankTimes: number[] = [];

  for (let run = 0; run < RUNS; run += 1) {
    const beforeQuery = performance.now();
    const chunks = await prisma.chunk.findMany({
      where: { notebookId, source: { selected: true, status: 'ready' } },
      select: {
        id: true,
        content: true,
        charStart: true,
        charEnd: true,
        page: true,
        embedding: true,
        sourceId: true,
        source: { select: { title: true } },
      },
    });
    const afterQuery = performance.now();

    rankBySimilarity(query, chunks, (chunk) => chunk.embedding, limits.chat.topK);
    const afterRank = performance.now();

    queryTimes.push(afterQuery - beforeQuery);
    rankTimes.push(afterRank - afterQuery);
  }

  // Median statt Mittelwert: ein einzelner Ausreisser durch die Speicher-
  // bereinigung soll das Ergebnis nicht verschieben.
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(RUNS / 2)] ?? 0;

  // 8 Byte je Zahl mit doppelter Genauigkeit. Das ist die Datenmenge, die je
  // Frage aus der Datenbank in den Anwendungsprozess wandert.
  const bytes = chunkCount * DIMENSIONS * 8;

  return {
    chunkCount,
    queryMs: median(queryTimes),
    rankMs: median(rankTimes),
    totalMs: median(queryTimes) + median(rankTimes),
    megabytes: bytes / 1024 / 1024,
  };
}

async function main() {
  console.log(`Dimensionen je Vektor: ${DIMENSIONS}`);
  console.log(`Messungen je Größe:  ${RUNS} (Median)`);
  console.log('');
  console.log('| Abschnitte | DB-Abfrage | Rangfolge | Gesamt   | Daten je Frage |');
  console.log('| ---------: | ---------: | --------: | -------: | -------------: |');

  for (const size of SIZES) {
    const { notebookId, userId } = await seed(size);
    try {
      const result = await measure(notebookId, size);
      console.log(
        `| ${String(result.chunkCount).padStart(10)} |` +
          ` ${result.queryMs.toFixed(0).padStart(7)} ms |` +
          ` ${result.rankMs.toFixed(0).padStart(6)} ms |` +
          ` ${result.totalMs.toFixed(0).padStart(5)} ms |` +
          ` ${result.megabytes.toFixed(1).padStart(11)} MB |`,
      );
    } finally {
      // Cascade räumt Notebook, Quelle und Abschnitte mit ab.
      await prisma.user.delete({ where: { id: userId } });
    }
  }

  console.log('');
  console.log(`Rechnung: Abschnitte x ${DIMENSIONS} Dimensionen x 8 Byte je Zahl.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
