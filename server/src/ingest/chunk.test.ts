import { describe, expect, it } from 'vitest';
import { limits } from '../config.js';
import { chunkText, estimateTokens, satzgrenzen } from './chunk.js';

/** Erzeugt einen Text aus nummerierten Absätzen. */
function buildText(paragraphs: number, sentencesEach = 6): string {
  const blocks: string[] = [];
  for (let p = 0; p < paragraphs; p += 1) {
    const sentences: string[] = [];
    for (let s = 0; s < sentencesEach; s += 1) {
      sentences.push(
        `Absatz ${p} Satz ${s} behandelt die Berechtigungsprüfung und ihre Auswirkungen.`,
      );
    }
    blocks.push(sentences.join(' '));
  }
  return blocks.join('\n\n');
}

describe('Zerlegung mit Zeichen-Positionen', () => {
  it('jeder Abschnitt liegt exakt an seinen Zeichen-Positionen', () => {
    // Die wichtigste Zusicherung im ganzen Modul: ohne sie zeigt die
    // Hervorhebung in der Oberfläche auf die falsche Stelle im Dokument.
    const text = buildText(30);
    for (const chunk of chunkText(text)) {
      expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    }
  });

  it('deckt den Text ohne Lücke ab', () => {
    const text = buildText(25);
    const chunks = chunkText(text);

    expect(chunks[0]?.charStart).toBe(0);
    expect(chunks.at(-1)?.charEnd).toBe(text.length);

    // Jeder Abschnitt beginnt spätestens dort, wo der vorige aufgehört hat.
    // Wäre eine Lücke dazwischen, fiele der Text darin bei der Suche weg.
    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1]!;
      const current = chunks[i]!;
      expect(current.charStart).toBeLessThanOrEqual(previous.charEnd);
      expect(current.charStart).toBeGreaterThan(previous.charStart);
    }
  });

  it('Abschnitte überlappen sich', () => {
    const chunks = chunkText(buildText(25));
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.charStart).toBeLessThan(chunks[i - 1]!.charEnd);
    }
  });

  it('nummeriert lücken- und doppelfrei ab 0', () => {
    const chunks = chunkText(buildText(20));
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('hält die Zielgrösse ungefähr ein', () => {
    const chunks = chunkText(buildText(40));
    for (const chunk of chunks.slice(0, -1)) {
      // Nicht exakt: geschnitten wird an Absatz- und Satzgrenzen, nicht auf
      // dem Zeichen genau. Aber keiner darf entgleisen.
      // Nicht exakt an der Zielgrösse, aber in ihrer Nähe - geschnitten wird
      // an Absatz- und Satzgrenzen, nicht auf dem Zeichen genau.
      expect(chunk.tokenCount).toBeLessThanOrEqual(limits.chunking.targetTokens * 1.2);
      expect(chunk.tokenCount).toBeGreaterThan(limits.chunking.targetTokens * 0.4);
    }
  });

  it('gibt bei leerem Text nichts zurück', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('   \n\n  \t ')).toEqual([]);
  });

  it('macht aus kurzem Text genau einen Abschnitt', () => {
    const text = 'Ein einzelner kurzer Satz.';
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ charStart: 0, charEnd: text.length, content: text });
  });

  it('bricht bei einem Absatz ohne jede Grenze nicht ab', () => {
    // Ein Text ganz ohne Satzzeichen und Absätze: der Schnitt muss trotzdem
    // erfolgen, sonst entstünde ein einziger riesiger Abschnitt.
    const text = 'wort '.repeat(6000);
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)?.charEnd).toBe(text.length);
    for (const chunk of chunks) {
      expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    }
  });

  it('hängt einen sehr kurzen Rest an den Vorgänger', () => {
    const chunks = chunkText(buildText(20) + '\n\nEnde.');
    expect(chunks.at(-1)!.content.trim().length).toBeGreaterThan(50);
  });

  it('ordnet Seitenzahlen den Zeichen-Positionen zu', () => {
    const page1 = 'Seite eins. '.repeat(200);
    const page2 = 'Seite zwei. '.repeat(200);
    const page3 = 'Seite drei. '.repeat(200);
    const text = page1 + page2 + page3;
    const pageBreaks = [page1.length, page1.length + page2.length];

    const chunks = chunkText(text, pageBreaks);
    for (const chunk of chunks) {
      const expected =
        chunk.charStart >= pageBreaks[1]! ? 3 : chunk.charStart >= pageBreaks[0]! ? 2 : 1;
      expect(chunk.page).toBe(expected);
    }
  });

  it('lässt die Seitenzahl offen, wenn es keine Seiten gibt', () => {
    // Text- und URL-Quellen haben keine Seiten. `undefined` ist ehrlicher als
    // eine erfundene 1.
    for (const chunk of chunkText(buildText(10))) {
      expect(chunk.page).toBeUndefined();
    }
  });

  it('behält Zeichen-Positionen bei Umlauten und Emoji', () => {
    // JavaScript zählt in UTF-16-Einheiten. Ein Emoji außerhalb der
    // Basisebene belegt zwei davon - solange Zerlegung und Hervorhebung
    // dieselbe Zählung verwenden, passt es. Der Test hält das fest.
    const text = 'Grundsätzliche Prüfung 🔐 der Zuständigkeiten. '.repeat(300);
    for (const chunk of chunkText(text)) {
      expect(text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    }
  });
});

describe('Abschnitte an Satzgrenzen', () => {
  it('kein Abschnitt beginnt oder endet mitten im Satz', () => {
    // Der Grund für die ganze Umstellung. Der Abschnitt ist das, was als Beleg
    // angezeigt wird - beginnt er mitten im Satz, liest sich der Nachweis wie
    // ein Fehler. Jeder Satz in `buildText` fängt mit "Absatz" an und hört mit
    // einem Punkt auf; genau das muss für jeden Abschnitt gelten.
    const chunks = chunkText(buildText(30));
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(chunk.content.trimStart().startsWith('Absatz')).toBe(true);
      expect(chunk.content.trimEnd().endsWith('.')).toBe(true);
    }
  });

  it('schneidet auch ohne Absätze an Satzgrenzen', () => {
    // Ein einziger langer Absatz: dann trägt allein die Satzerkennung.
    const satz = 'Die Berechtigungsprüfung liegt im Zugriffspfad und nicht daneben. ';
    const chunks = chunkText(satz.repeat(200));

    for (const chunk of chunks) {
      expect(chunk.content.trimStart().startsWith('Die')).toBe(true);
    }
  });
});

describe('Satzerkennung', () => {
  /** Der Text ab jeder erkannten Grenze - so liest sich der Test wie das Ergebnis. */
  function satzanfaenge(text: string): string[] {
    return satzgrenzen(text).map((position) => text.slice(position));
  }

  it('erkennt gewöhnliche Satzenden', () => {
    expect(satzanfaenge('Er kam an. Sie ging fort.')).toEqual(['Sie ging fort.']);
    expect(satzanfaenge('Wirklich? Ja! Genau.')).toEqual(['Ja! Genau.', 'Genau.']);
  });

  it('trennt nicht an einer Ordnungszahl', () => {
    // "12. August" wäre sonst der Anfang eines neuen Abschnitts - und ein
    // Beleg, der mit "August 2026 Bewerbung als" beginnt, ist unbrauchbar.
    expect(satzanfaenge('Am 12. August 2026 kam Post. Sie lag im Fach.')).toEqual([
      'Sie lag im Fach.',
    ]);
  });

  it('trennt nicht an Abkürzungen', () => {
    expect(satzanfaenge('Wir nutzen z. B. Node. Das genügt.')).toEqual(['Das genügt.']);
    expect(satzanfaenge('Siehe Abs. 3 und Nr. 4 des Vertrags. Danach folgt mehr.')).toEqual([
      'Danach folgt mehr.',
    ]);
    expect(satzanfaenge('Tests, Doku usw. und dann der Rest. Fertig ist es.')).toEqual([
      'Fertig ist es.',
    ]);
  });

  it('trennt nicht ohne Leerraum hinter dem Punkt', () => {
    // Sonst zerfiele jede Adresse in zwei Sätze.
    expect(satzanfaenge('Schreib an k.benziane@web.de Frankfurt gilt weiter.')).toEqual([]);
  });

  it('meldet keine Grenze am Textende', () => {
    // Eine Grenze auf `text.length` wäre ein leerer Abschnitt.
    expect(satzgrenzen('Ein Satz. ')).toEqual([]);
    expect(satzgrenzen('Ein Absatz.\n\n')).toEqual([]);
  });

  it('erkennt den Absatzumbruch als Grenze', () => {
    expect(satzanfaenge('Ohne Punkt am Ende\n\nNeuer Absatz.')).toEqual(['Neuer Absatz.']);
  });
});

describe('Token-Schätzung', () => {
  it('wächst mit der Textlänge und ist nie null bei Inhalt', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('a'.repeat(350))).toBe(100);
  });
});
