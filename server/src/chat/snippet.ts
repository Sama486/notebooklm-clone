import { limits } from '../config.js';

/**
 * Macht aus einem Abschnitt die Vorschau, die am Beleg hängt.
 *
 * Der Abschnitt selbst wird dabei nicht angefasst - `content`, `charStart` und
 * `charEnd` müssen zeichengenau bleiben, sonst zeigt die Hervorhebung im
 * Dokument auf die falsche Stelle. Was hier entsteht, ist reiner Anzeigetext.
 *
 * Diese Trennung ist der eigentliche Punkt: der Abschnitt hat zwei Aufgaben,
 * Suchmaterial und Nachweis. Als Suchmaterial muss er roh und positionstreu
 * sein, als Nachweis lesbar. Vorher gab es dafür nur `slice(0, 300)` - ein
 * harter Zeichenschnitt, der mitten im Wort endete. In der Oberfläche fiel das
 * kaum auf, weil daneben der Klick ins Dokument liegt; im Markdown-Export, wo
 * der Ausschnitt der ganze Beleg ist, war es sofort sichtbar.
 *
 * Reine Funktion - kein Netz, keine Datenbank, billig zu testen.
 */

/** Unterhalb dieses Anteils der Zielgrösse lohnt der saubere Schnitt nicht. */
const MINDESTANTEIL = 0.5;

export function belegAusschnitt(content: string): string {
  // Zeilenumbrüche aus PDF-Extraktion und HTML sitzen an beliebigen Stellen.
  // In einer einzeiligen Vorschau sind sie nur Lücken, also weg damit.
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= limits.chat.snippetChars) return text;

  const fenster = text.slice(0, limits.chat.snippetChars);
  const mindestens = Math.round(limits.chat.snippetChars * MINDESTANTEIL);

  // Bevorzugt am letzten Satzende innerhalb des Fensters abbrechen. Dann liest
  // sich die Vorschau als vollständiger Gedanke und braucht keine Auslassung.
  let satzende = -1;
  for (const match of fenster.matchAll(/[.!?]["’»')\]]?\s/g)) {
    satzende = match.index + match[0].length;
  }
  if (satzende >= mindestens) return fenster.slice(0, satzende).trimEnd();

  // Ein einzelner sehr langer Satz: dann wenigstens an einer Wortgrenze, mit
  // Auslassungszeichen, damit die Kürzung sichtbar bleibt.
  const wortgrenze = fenster.lastIndexOf(' ');
  const gekuerzt = wortgrenze > mindestens ? fenster.slice(0, wortgrenze) : fenster;

  return `${gekuerzt.trimEnd()}…`;
}
