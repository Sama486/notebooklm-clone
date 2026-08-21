import { describe, expect, it } from 'vitest';
import { cosineSimilarity, rankBySimilarity } from './similarity.js';

describe('Kosinus-Aehnlichkeit', () => {
  it('gibt 1 fuer identische Vektoren', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('ist unabhaengig von der Laenge des Vektors', () => {
    // Der Grund fuer Kosinus statt Abstand: derselbe Inhalt, doppelt so lang,
    // soll denselben Wert bekommen.
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 10);
  });

  it('gibt 0 fuer orthogonale und -1 fuer entgegengesetzte Vektoren', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('rechnet ein bekanntes Beispiel korrekt', () => {
    // [1,1] und [1,0] schliessen 45 Grad ein, cos(45 Grad) = 0,7071...
    expect(cosineSimilarity([1, 1], [1, 0])).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('gibt 0 statt zu werfen, wenn die Dimensionen nicht passen', () => {
    // Kann vorkommen, wenn ein Abschnitt mit einem anderen Modell eingebettet
    // wurde. "Nicht aehnlich" ist die sichere Antwort.
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('gibt 0 fuer einen Nullvektor statt NaN', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });
});

describe('Rangfolge', () => {
  const chunks = [
    { id: 'genau', embedding: [1, 0, 0] },
    { id: 'schraeg', embedding: [1, 1, 0] },
    { id: 'quer', embedding: [0, 1, 0] },
    { id: 'gegen', embedding: [-1, 0, 0] },
  ];
  const embeddingOf = (c: (typeof chunks)[number]) => c.embedding;

  it('sortiert absteigend nach Aehnlichkeit', () => {
    const ranked = rankBySimilarity([1, 0, 0], chunks, embeddingOf, 3);
    expect(ranked.map((r) => r.chunk.id)).toEqual(['genau', 'schraeg']);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it('haelt sich an topK', () => {
    expect(rankBySimilarity([1, 1, 1], chunks, embeddingOf, 2)).toHaveLength(2);
    expect(rankBySimilarity([1, 1, 1], chunks, embeddingOf, 0)).toHaveLength(0);
  });

  it('laesst Abschnitte ohne Aehnlichkeit weg', () => {
    // "quer" ist orthogonal (0), "gegen" entgegengesetzt (-1). Beide haben in
    // der Antwort nichts verloren.
    const ranked = rankBySimilarity([1, 0, 0], chunks, embeddingOf, 10);
    expect(ranked.map((r) => r.chunk.id)).not.toContain('quer');
    expect(ranked.map((r) => r.chunk.id)).not.toContain('gegen');
  });

  it('kommt mit einer leeren Menge zurecht', () => {
    expect(rankBySimilarity([1, 0, 0], [], embeddingOf, 5)).toEqual([]);
  });

  it('ueberspringt Abschnitte mit unpassender Dimension', () => {
    const gemischt = [
      { id: 'passend', embedding: [1, 0, 0] },
      { id: 'fremd', embedding: [1, 0] },
    ];
    const ranked = rankBySimilarity([1, 0, 0], gemischt, (c) => c.embedding, 5);
    expect(ranked.map((r) => r.chunk.id)).toEqual(['passend']);
  });
});
