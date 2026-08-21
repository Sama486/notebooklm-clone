import { limits } from '../config.js';
import { badRequest, unprocessable } from '../http/errors.js';

/**
 * Textextraktion aus einer PDF-Datei.
 *
 * Gibt neben dem Volltext die Zeichen-Positionen der Seitenanfänge zurück.
 * Ohne sie kann ein Abschnitt später keine Seitenzahl tragen, und im Zitat
 * stünde "Seite unbekannt".
 */

export interface ExtractedPdf {
  text: string;
  /** `pageBreaks[i]` ist die Zeichen-Position, an der Seite `i + 2` beginnt. */
  pageBreaks: number[];
  pageCount: number;
}

/**
 * Prüft den Dateityp am Inhalt, nicht an der Endung und nicht am
 * mitgeschickten Content-Type.
 *
 * Beides bestimmt der Absender frei. Eine ausführbare Datei mit der Endung
 * .pdf und `Content-Type: application/pdf` ist trivial gebaut; die ersten Bytes
 * einer Datei zu fälschen bedeutet dagegen, tatsächlich eine PDF-Struktur zu
 * liefern.
 */
export function looksLikePdf(data: Buffer): boolean {
  // "%PDF-" laut Spezifikation am Dateianfang. Manche Erzeuger schreiben ein
  // paar Bytes davor, deshalb wird der Anfang durchsucht statt nur Position 0
  // geprüft - aber nur der Anfang, nicht die ganze Datei.
  return data.subarray(0, 1024).includes(Buffer.from('%PDF-', 'latin1'));
}

export async function extractPdf(data: Buffer): Promise<ExtractedPdf> {
  if (!looksLikePdf(data)) {
    throw badRequest('Die Datei ist kein PDF.', 'not_a_pdf');
  }

  // Erst hier laden: pdfjs ist groß, und ein Serverstart soll nicht darauf
  // warten, wenn nie ein PDF hochgeladen wird.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  let document;
  try {
    document = await pdfjs.getDocument({
      data: new Uint8Array(data),
      // Ein PDF darf keinen Code ausführen und nichts nachladen. Die
      // Voreinstellungen von pdfjs sind auf Browser-Anzeige ausgelegt, nicht
      // auf das Verarbeiten fremder Dateien auf einem Server.
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      // Kein Nachladen externer Ressourcen - das wäre ein SSRF-Pfad an unserer
      // URL-Prüfung vorbei.
      useWorkerFetch: false,
      stopAtErrors: false,
    }).promise;
  } catch {
    throw unprocessable(
      'Das PDF ließ sich nicht öffnen. Möglicherweise ist es beschädigt oder passwortgeschützt.',
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

      // Obergrenze für extrahierten Text: ein präpariertes Dokument soll den
      // Prozess nicht über den Speicher umbringen können.
      if (length > limits.source.extractedTextMax) {
        throw unprocessable(
          'Das Dokument enthält mehr Text als verarbeitet werden kann.',
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
      'Aus dem PDF ließ sich kein Text lesen. Gescannte Seiten ohne Texterkennung werden nicht unterstützt.',
      'pdf_no_text',
    );
  }

  return { text, pageBreaks, pageCount: document.numPages };
}

/**
 * Setzt die Textstücke einer Seite zusammen.
 *
 * pdfjs liefert Textfragmente in Zeichenreihenfolge, nicht in Leserichtung, und
 * ohne Leerzeichen dazwischen. `hasEOL` markiert einen Zeilenumbruch. Ohne
 * diese Behandlung klebten Wörter über Zeilengrenzen hinweg aneinander -
 * "Berechtigungsprüfungsteht" statt "Berechtigungsprüfung steht" - und das
 * Embedding würde auf Wörtern arbeiten, die es nicht gibt.
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
