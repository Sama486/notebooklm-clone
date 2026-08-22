import { describe, expect, it } from 'vitest';
import { joinTextItems, type TextItem } from './joinTextItems.js';

const SCHRIFT = 12;

/** Ein Textstück an Position x, mit aus der Länge geschätzter Breite. */
function stueck(str: string, x: number, extra: Partial<TextItem> = {}): TextItem {
  return {
    str,
    transform: [SCHRIFT, 0, 0, SCHRIFT, x, 700],
    width: str.length * SCHRIFT * 0.5,
    ...extra,
  };
}

/** Legt Stücke dicht nebeneinander, mit einer wählbaren Lücke dazwischen. */
function reihe(woerter: string[], luecke: number): TextItem[] {
  let x = 72;
  return woerter.map((wort) => {
    const item = stueck(wort, x);
    x += (item.width ?? 0) + luecke;
    return item;
  });
}

describe('Zusammensetzen der Textstücke einer PDF-Seite', () => {
  it('klebt gesperrt gesetzte Überschriften wieder zusammen', () => {
    // GENAU DIESER FALL war im Export eines Lebenslaufs zu sehen: aus
    // "BERUFSERFAHRUNG" wurde "B E R U F S E R F A H R U N G", weil pdfjs jeden
    // Buchstaben als eigenes Stück liefert. Eingebettet wurden danach fünfzehn
    // einzelne Buchstaben statt eines Wortes.
    const buchstaben = 'BERUFSERFAHRUNG'.split('');
    // Sperrung: eine kleine Lücke, deutlich schmaler als ein Leerzeichen.
    const text = joinTextItems(reihe(buchstaben, SCHRIFT * 0.1));

    expect(text).toContain('BERUFSERFAHRUNG');
    expect(text).not.toContain('B E R U F S');
  });

  it('trennt Wörter, zwischen denen ein echtes Leerzeichen steht', () => {
    const text = joinTextItems(reihe(['Der', 'Besitz', 'wird', 'geprueft'], SCHRIFT * 0.3));
    expect(text).toContain('Der Besitz wird geprueft');
  });

  it('klebt Wörter nicht aneinander, wenn Koordinaten fehlen', () => {
    // Ohne Koordinaten bleibt nur die vorsichtige Annahme - ein Leerzeichen zu
    // viel ist harmloser als zwei aneinandergeklebte Wörter.
    const text = joinTextItems([{ str: 'Zugriffspfad' }, { str: 'Berechtigung' }]);
    expect(text).toContain('Zugriffspfad Berechtigung');
    expect(text).not.toContain('ZugriffspfadBerechtigung');
  });

  it('setzt kein zweites Leerzeichen, wenn schon eines da ist', () => {
    const text = joinTextItems([stueck('Der ', 72), stueck('Besitz', 100)]);
    expect(text).toContain('Der Besitz');
    expect(text).not.toContain('Der  Besitz');
  });

  it('behandelt einen Zeilensprung als Trennung', () => {
    // Zwei Stücke können waagerecht dicht beieinanderliegen und trotzdem auf
    // verschiedenen Zeilen stehen - dann gehören sie nicht zum selben Wort.
    const oben = stueck('Zugriffspfad', 72);
    const unten: TextItem = { ...stueck('Berechtigung', 74), transform: [SCHRIFT, 0, 0, SCHRIFT, 74, 680] };

    expect(joinTextItems([oben, unten])).toContain('Zugriffspfad Berechtigung');
  });

  it('übernimmt Zeilenumbrüche aus hasEOL', () => {
    const text = joinTextItems([stueck('Erste Zeile', 72, { hasEOL: true }), stueck('Zweite', 72)]);
    expect(text).toMatch(/Erste Zeile\nZweite/);
  });

  it('überspringt Einträge ohne Text', () => {
    // In `items` stehen neben Textstücken auch Struktur-Marken ohne `str`.
    const text = joinTextItems([stueck('Vor', 72), { type: 'beginMarkedContent' } as TextItem, stueck('Nach', 100)]);
    expect(text).toContain('Vor Nach');
  });

  it('hängt eine Absatzgrenze ans Seitenende', () => {
    // Die Zerlegung schneidet bevorzugt an Absatzgrenzen - ohne diese bliebe
    // der Seitenwechsel für sie unsichtbar.
    expect(joinTextItems([stueck('Inhalt', 72)]).endsWith('\n\n')).toBe(true);
  });

  it('gibt bei leerer Seite nur die Absatzgrenze zurück', () => {
    expect(joinTextItems([])).toBe('\n\n');
  });
});
