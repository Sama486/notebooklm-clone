import { describe, expect, it } from 'vitest';
import { limits } from '../config.js';
import { belegAusschnitt } from './snippet.js';

const grenze = limits.chat.snippetChars;

describe('Beleg-Ausschnitt', () => {
  it('lässt einen kurzen Abschnitt unverändert', () => {
    const text = 'Der Besitz wird im Zugriffspfad geprüft, nicht daneben.';
    expect(belegAusschnitt(text)).toBe(text);
  });

  it('macht aus Zeilenumbrüchen Leerzeichen', () => {
    // Aus PDF und HTML kommen Umbrüche an beliebigen Stellen. In einer
    // einzeiligen Vorschau sind sie nur Lücken.
    expect(belegAusschnitt('Erste Zeile\nzweite   Zeile\n\ndritte Zeile')).toBe(
      'Erste Zeile zweite Zeile dritte Zeile',
    );
  });

  it('kürzt am letzten Satzende und hängt dann nichts an', () => {
    const satz = 'Die Antwort ist 404 und nicht 403, weil ein 403 die Existenz verrät. ';
    const ausschnitt = belegAusschnitt(satz.repeat(20));

    expect(ausschnitt.endsWith('.')).toBe(true);
    expect(ausschnitt.length).toBeLessThanOrEqual(grenze);
    expect(ausschnitt.length).toBeGreaterThan(grenze * 0.5);
  });

  it('kürzt einen sehr langen Satz an einer Wortgrenze', () => {
    // Ein Satz ohne jedes Satzzeichen bis weit hinter die Grenze: hier gibt es
    // kein Satzende zum Abbrechen, und genau hier stand vorher der harte
    // Zeichenschnitt mitten im Wort.
    const text = 'Zuständigkeit '.repeat(60).trim() + '.';
    const ausschnitt = belegAusschnitt(text);

    expect(ausschnitt.endsWith('…')).toBe(true);
    const ohneZeichen = ausschnitt.slice(0, -1);
    expect(text.startsWith(ohneZeichen)).toBe(true);
    // Nach dem Schnitt folgt im Original ein Leerzeichen - also endet der
    // Ausschnitt an einer Wortgrenze und nicht mitten im Wort.
    expect(text[ohneZeichen.length]).toBe(' ');
  });

  it('bleibt in jedem Fall innerhalb der Grenze', () => {
    // Die Notiz-Route validiert genau diese Länge (notes/routes.ts).
    const faelle = [
      'Wort '.repeat(400),
      'Satz eins. '.repeat(60),
      'x'.repeat(1000),
      'Ein Satz mit Zahlen 12. August 2026 und weiteren Angaben. '.repeat(30),
    ];

    for (const text of faelle) {
      expect(belegAusschnitt(text).length).toBeLessThanOrEqual(grenze + 1);
    }
  });

  it('kommt mit einem einzigen überlangen Wort zurecht', () => {
    // Keine Wortgrenze in Reichweite: dann bleibt nur der harte Schnitt, aber
    // die Grenze muss halten.
    const ausschnitt = belegAusschnitt('a'.repeat(2000));
    expect(ausschnitt).toBe('a'.repeat(grenze) + '…');
  });
});
