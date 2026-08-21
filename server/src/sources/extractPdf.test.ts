import { describe, expect, it } from 'vitest';
import { extractPdf, looksLikePdf } from './extractPdf.js';
import { makePdf } from '../test/makePdf.js';
import { chunkText } from '../ingest/chunk.js';

describe('Dateityp-Erkennung am Inhalt', () => {
  it('erkennt ein echtes PDF', () => {
    expect(looksLikePdf(makePdf(['Inhalt']))).toBe(true);
  });

  it('weist eine Datei ab, die nur so heißt', () => {
    // Endung und Content-Type bestimmt der Absender frei. Nur der Inhalt zählt.
    for (const fake of [
      Buffer.from('MZ\x90\x00', 'latin1'), // Windows-Programm
      Buffer.from('PK\x03\x04', 'latin1'), // ZIP
      Buffer.from('<?php system($_GET["c"]); ?>'),
      Buffer.from('<html><body>kein pdf</body></html>'),
      Buffer.alloc(0),
    ]) {
      expect(looksLikePdf(fake)).toBe(false);
    }
  });

  it('findet die Signatur auch mit ein paar Bytes davor', () => {
    // Manche Erzeuger schreiben Müll vor die Signatur; echte Betrachter
    // akzeptieren das.
    expect(looksLikePdf(Buffer.concat([Buffer.from('\n\n'), makePdf(['x'])]))).toBe(true);
  });

  it('sucht die Signatur nur am Dateianfang', () => {
    // Sonst genügte es, "%PDF-" irgendwo in eine beliebige Datei zu schreiben.
    const versteckt = Buffer.concat([Buffer.alloc(2048, 0x41), Buffer.from('%PDF-1.4')]);
    expect(looksLikePdf(versteckt)).toBe(false);
  });
});

describe('PDF-Extraktion', () => {
  it('liest den Text einer einseitigen Datei', async () => {
    const result = await extractPdf(makePdf(['Die Berechtigungsprüfung steht im Zugriffspfad.']));
    expect(result.text).toContain('Berechtigungsprüfung');
    expect(result.pageCount).toBe(1);
    expect(result.pageBreaks).toEqual([]);
  });

  it('liefert Seitenanfänge als Zeichen-Positionen', async () => {
    const result = await extractPdf(
      makePdf(['Text der ersten Seite.', 'Text der zweiten Seite.', 'Text der dritten Seite.']),
    );

    expect(result.pageCount).toBe(3);
    expect(result.pageBreaks).toHaveLength(2);
    // Aufsteigend und innerhalb des Textes - sonst zeigt die Seitenzahl im
    // Zitat auf die falsche Seite.
    expect(result.pageBreaks[0]).toBeGreaterThan(0);
    expect(result.pageBreaks[1]).toBeGreaterThan(result.pageBreaks[0]!);
    expect(result.pageBreaks[1]).toBeLessThan(result.text.length);

    // Der Text der zweiten Seite beginnt hinter dem ersten Umbruch.
    expect(result.text.slice(result.pageBreaks[0]!)).toContain('zweiten Seite');
    expect(result.text.slice(0, result.pageBreaks[0]!)).not.toContain('zweiten Seite');
  });

  it('trennt Wörter über Zeilengrenzen hinweg', async () => {
    // Ohne diese Behandlung entstünde "ZugriffspfadBerechtigung" - ein Wort,
    // das es nicht gibt, und das Embedding arbeitete darauf.
    const result = await extractPdf(makePdf(['Zugriffspfad\nBerechtigung']));
    expect(result.text).not.toContain('ZugriffspfadBerechtigung');
    expect(result.text).toMatch(/Zugriffspfad\s+Berechtigung/);
  });

  it('liest Umlaute und scharfes s', async () => {
    // Deutsche Dokumente sind der Regelfall dieses Projekts. Geht die Kodierung
    // verloren, wird aus "Prüfung" ein "Pr fung" - das Embedding arbeitet dann
    // auf Wörtern, die es nicht gibt, und die Zeichen-Positionen verschieben
    // sich gegenüber dem angezeigten Text.
    const result = await extractPdf(
      makePdf(['Grundsätzliche Prüfung der Zuständigkeiten. Größe, Verstöße und Maße.']),
    );

    expect(result.text).toContain('Grundsätzliche');
    expect(result.text).toContain('Prüfung');
    expect(result.text).toContain('Zuständigkeiten');
    expect(result.text).toContain('Größe');
    expect(result.text).toContain('Verstöße');
    expect(result.text).not.toContain('�');
  });

  it('behält die Zeichen-Positionen bei Umlauten', async () => {
    const result = await extractPdf(
      makePdf(['Zuständigkeit für Änderungen und Überprüfung der Größe. '.repeat(40)]),
    );

    for (const chunk of chunkText(result.text, result.pageBreaks)) {
      expect(result.text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
    }
  });

  it('weist eine Datei ab, die kein PDF ist', async () => {
    await expect(extractPdf(Buffer.from('<html>kein pdf</html>'))).rejects.toMatchObject({
      code: 'not_a_pdf',
    });
  });

  it('weist ein beschädigtes PDF mit lesbarer Meldung ab', async () => {
    // Signatur stimmt, Struktur nicht. Der Fehler muss als Statusmeldung an
    // der Quelle landen, nicht als Absturz.
    const kaputt = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0x00)]);
    await expect(extractPdf(kaputt)).rejects.toMatchObject({ status: 422 });
  });

  it('weist ein PDF ohne Text ab', async () => {
    // Entspricht einem eingescannten Dokument ohne Texterkennung.
    await expect(extractPdf(makePdf(['']))).rejects.toMatchObject({ code: 'pdf_no_text' });
  });
});
