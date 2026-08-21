import { describe, expect, it } from 'vitest';
import { extractPdf, looksLikePdf } from './extractPdf.js';
import { makePdf } from '../test/makePdf.js';

describe('Dateityp-Erkennung am Inhalt', () => {
  it('erkennt ein echtes PDF', () => {
    expect(looksLikePdf(makePdf(['Inhalt']))).toBe(true);
  });

  it('weist eine Datei ab, die nur so heisst', () => {
    // Endung und Content-Type bestimmt der Absender frei. Nur der Inhalt zaehlt.
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
    // Manche Erzeuger schreiben Muell vor die Signatur; echte Betrachter
    // akzeptieren das.
    expect(looksLikePdf(Buffer.concat([Buffer.from('\n\n'), makePdf(['x'])]))).toBe(true);
  });

  it('sucht die Signatur nur am Dateianfang', () => {
    // Sonst genuegte es, "%PDF-" irgendwo in eine beliebige Datei zu schreiben.
    const versteckt = Buffer.concat([Buffer.alloc(2048, 0x41), Buffer.from('%PDF-1.4')]);
    expect(looksLikePdf(versteckt)).toBe(false);
  });
});

describe('PDF-Extraktion', () => {
  it('liest den Text einer einseitigen Datei', async () => {
    const result = await extractPdf(makePdf(['Die Berechtigungspruefung steht im Zugriffspfad.']));
    expect(result.text).toContain('Berechtigungspruefung');
    expect(result.pageCount).toBe(1);
    expect(result.pageBreaks).toEqual([]);
  });

  it('liefert Seitenanfaenge als Zeichen-Positionen', async () => {
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

  it('trennt Woerter ueber Zeilengrenzen hinweg', async () => {
    // Ohne diese Behandlung entstuende "ZugriffspfadBerechtigung" - ein Wort,
    // das es nicht gibt, und das Embedding arbeitete darauf.
    const result = await extractPdf(makePdf(['Zugriffspfad\nBerechtigung']));
    expect(result.text).not.toContain('ZugriffspfadBerechtigung');
    expect(result.text).toMatch(/Zugriffspfad\s+Berechtigung/);
  });

  it('weist eine Datei ab, die kein PDF ist', async () => {
    await expect(extractPdf(Buffer.from('<html>kein pdf</html>'))).rejects.toMatchObject({
      code: 'not_a_pdf',
    });
  });

  it('weist ein beschaedigtes PDF mit lesbarer Meldung ab', async () => {
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
