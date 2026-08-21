import { limits } from '../config.js';
import { badRequest, unprocessable } from '../http/errors.js';

/**
 * Textextraktion aus einer PDF-Datei.
 *
 * Gibt neben dem Volltext die Zeichen-Positionen der Seitenanfaenge zurueck.
 * Ohne sie kann ein Abschnitt spaeter keine Seitenzahl tragen, und im Zitat
 * stuende "Seite unbekannt".
 */

export interface ExtractedPdf {
  text: string;
  /** `pageBreaks[i]` ist die Zeichen-Position, an der Seite `i + 2` beginnt. */
  pageBreaks: number[];
  pageCount: number;
}

/**
 * Prueft den Dateityp am Inhalt, nicht an der Endung und nicht am
 * mitgeschickten Content-Type.
 *
 * Beides bestimmt der Absender frei. Eine ausfuehrbare Datei mit der Endung
 * .pdf und `Content-Type: application/pdf` ist trivial gebaut; die ersten Bytes
 * einer Datei zu faelschen bedeutet dagegen, tatsaechlich eine PDF-Struktur zu
 * liefern.
 */
export function looksLikePdf(data: Buffer): boolean {
  // "%PDF-" laut Spezifikation am Dateianfang. Manche Erzeuger schreiben ein
  // paar Bytes davor, deshalb wird der Anfang durchsucht statt nur Position 0
  // geprueft - aber nur der Anfang, nicht die ganze Datei.
  return data.subarray(0, 1024).includes(Buffer.from('%PDF-', 'latin1'));
}

export async function extractPdf(data: Buffer): Promise<ExtractedPdf> {
  if (!looksLikePdf(data)) {
    throw badRequest('Die Datei ist kein PDF.', 'not_a_pdf');
  }

  // Erst hier laden: pdfjs ist gross, und ein Serverstart soll nicht darauf
  // warten, wenn nie ein PDF hochgeladen wird.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  let document;
  try {
    document = await pdfjs.getDocument({
      data: new Uint8Array(data),
      // Ein PDF darf keinen Code ausfuehren und nichts nachladen. Die
      // Voreinstellungen von pdfjs sind auf Browser-Anzeige ausgelegt, nicht
      // auf das Verarbeiten fremder Dateien auf einem Server.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      // Kein Nachladen externer Ressourcen - das waere ein SSRF-Pfad an unserer
      // URL-Pruefung vorbei.
      useWorkerFetch: false,
      stopAtErrors: false,
    }).promise;
  } catch {
    throw unprocessable(
      'Das PDF liess sich nicht oeffnen. Moeglicherweise ist es beschaedigt oder passwortgeschuetzt.',
      'pdf_unreadable',
    );
  }

  const parts: string[] = [];
  const pageBreaks: number[] = [];
  let length = 0;

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (pageNumber > 1) pageBreaks.push(length);

      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();

      const pageText = joinTextItems(content.items);
      parts.push(pageText);
      length += pageText.length;

      // Speicher der Seite sofort freigeben. Bei einem achtzigseitigen Dokument
      // summiert sich das sonst, und die Instanz hat 512 MB.
      page.cleanup();

      // Obergrenze fuer extrahierten Text: ein praepariertes Dokument soll den
      // Prozess nicht ueber den Speicher umbringen koennen.
      if (length > limits.source.extractedTextMax) {
        throw unprocessable(
          'Das Dokument enthaelt mehr Text als verarbeitet werden kann.',
          'text_too_long',
        );
      }
    }
  } finally {
    await document.destroy();
  }

  const text = parts.join('');
  if (text.trim().length === 0) {
    throw unprocessable(
      'Aus dem PDF liess sich kein Text lesen. Gescannte Seiten ohne Texterkennung werden nicht unterstuetzt.',
      'pdf_no_text',
    );
  }

  return { text, pageBreaks, pageCount: document.numPages };
}

/**
 * Setzt die Textstuecke einer Seite zusammen.
 *
 * pdfjs liefert Textfragmente in Zeichenreihenfolge, nicht in Leserichtung, und
 * ohne Leerzeichen dazwischen. `hasEOL` markiert einen Zeilenumbruch. Ohne
 * diese Behandlung klebten Woerter ueber Zeilengrenzen hinweg aneinander -
 * "Berechtigungspruefungsteht" statt "Berechtigungspruefung steht" - und das
 * Embedding wuerde auf Woertern arbeiten, die es nicht gibt.
 */
function joinTextItems(items: unknown[]): string {
  let text = '';

  for (const item of items) {
    const entry = item as { str?: string; hasEOL?: boolean };
    if (typeof entry.str !== 'string') continue;

    text += entry.str;
    if (entry.hasEOL) text += '\n';
    else if (entry.str.length > 0 && !entry.str.endsWith(' ')) text += ' ';
  }

  // Seitenende als Absatzgrenze: die Zerlegung schneidet bevorzugt dort.
  return text.replace(/[ \t]+\n/g, '\n') + '\n\n';
}
