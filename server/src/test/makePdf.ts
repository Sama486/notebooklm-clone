/**
 * Baut ein minimales, gültiges PDF mit vorgegebenem Text je Seite.
 *
 * Erzeugt statt mitgeliefert: eine Binärdatei im Repo könnte niemand lesen
 * oder prüfen, und der Test soll nachvollziehbar bleiben. Außerdem lässt
 * sich so gezielt ein PDF baün, das einen Injektionsversuch enthält.
 *
 * Eine Seite fasst etwa 45 umbrochene Zeilen zu 90 Zeichen, also rund 4.000
 * Zeichen. Mehr läuft unten aus der Seite heraus und fehlt anschliessend im
 * extrahierten Text - für längere Texte also mehrere Seiten übergeben.
 */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const pageCount = Math.max(pages.length, 1);

  // Objektnummern: 1 Katalog, 2 Seitenbaum, 3 Schrift,
  // dann je Seite ein Page- und ein Contents-Objekt.
  const pageIds = pages.map((_, i) => 4 + i * 2);
  const contentIds = pages.map((_, i) => 5 + i * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageCount} >>`;
  // /WinAnsiEncoding ist nötig, damit Umlaute im extrahierten Text ankommen.
  // Ohne die Angabe raet der Leser die Kodierung aus der Standardbelegung der
  // Schrift, und aus einem "ü" wird ein Leerzeichen. Echte Erzeuger schreiben
  // eine Kodierung oder eine ToUnicode-Tabelle mit; das Test-PDF muss das
  // ebenso tun, sonst prüft der Test etwas anderes als die Wirklichkeit.
  objects[3] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  pages.forEach((text, i) => {
    objects[pageIds[i] as number] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;

    // Eine Zeile je Textzeile, damit pdfjs Zeilenumbrüche liefert.
    // Umbrechen, bevor der Text über den rechten Seitenrand hinausläuft:
    // was dort landet, liefert pdfjs nicht mehr zurück, und das Test-PDF wäre
    // stillschweigend kürzer als beabsichtigt.
    const lines = text.split('\n').flatMap((line) => wrap(line));
    const body = [
      'BT',
      '/F1 12 Tf',
      '14 TL',
      '72 720 Td',
      ...lines.map((line) => `(${escapePdfString(line)}) Tj T*`),
      'ET',
    ].join('\n');

    objects[contentIds[i] as number] = `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
  });

  // Zusammensetzen und dabei die Byte-Position jedes Objekts merken - die
  // Querverweistabelle am Ende braucht sie exakt.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (let id = 1; id < objects.length; id += 1) {
    const object = objects[id];
    if (object === undefined) continue;
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${object}\nendobj\n`;
  }

  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  const size = objects.length;

  pdf += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) {
    const offset = offsets[id];
    pdf +=
      offset === undefined
        ? '0000000000 65535 f \n'
        : `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * Bricht eine Zeile an Wortgrenzen um.
 *
 * 90 Zeichen passen bei Helvetica 12pt in die Breite einer A4-ähnlichen Seite
 * (612pt minus Rand). Längere Zeilen laufen aus der Seite heraus und fehlen
 * anschliessend im extrahierten Text.
 */
function wrap(line: string, maxChars = 90): string[] {
  if (line.length <= maxChars) return [line];

  const lines: string[] = [];
  let current = '';
  for (const word of line.split(' ')) {
    if (current.length + word.length + 1 > maxChars && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current.length === 0 ? word : `${current} ${word}`;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Klammern und Backslash haben in PDF-Zeichenketten Sonderbedeutung. */
function escapePdfString(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}
