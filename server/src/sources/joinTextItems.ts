/**
 * Setzt die Textstücke einer PDF-Seite zu Fliesstext zusammen.
 *
 * pdfjs liefert Text nicht als Zeilen, sondern als beliebig geschnittene
 * Stücke ohne Leerzeichen dazwischen. Wo eines endet und das nächste beginnt,
 * muss aus den Koordinaten erschlossen werden - und genau daran hängt die
 * Qualität von allem, was danach kommt.
 *
 * ZWEI FEHLER, DIE HIER ENTSTEHEN, WENN MAN ES ZU EINFACH MACHT:
 *
 * 1. Zwischen alle Stücke ein Leerzeichen setzen. Dann zerfällt eine gesperrt
 *    gesetzte Überschrift in Einzelbuchstaben: aus "BERUFSERFAHRUNG" wird
 *    "B E R U F S E R F A H R U N G", weil jeder Buchstabe ein eigenes Stück
 *    ist. Das ist nicht nur unschön - die Überschrift trägt danach nichts mehr
 *    zur Suche bei, denn eingebettet werden fünfzehn einzelne Buchstaben.
 * 2. Gar kein Leerzeichen setzen. Dann kleben Wörter über Stückgrenzen hinweg
 *    aneinander ("ZugriffspfadBerechtigung").
 *
 * Die Entscheidung fällt deshalb über den waagerechten Abstand: liegt das
 * nächste Stück praktisch dort, wo das vorige aufgehört hat, gehört es zum
 * selben Wort. Ist eine erkennbare Lücke dazwischen, ist es ein neues.
 *
 * Reine Funktion über einer schmalen Datenform - dadurch ohne PDF testbar.
 */

/** Was von einem pdfjs-Textstück gebraucht wird. */
export interface TextItem {
  str?: string;
  hasEOL?: boolean;
  /** Transformationsmatrix; [0] ist die Schriftgrösse, [4]/[5] sind x und y. */
  transform?: number[];
  width?: number;
}

/**
 * Ab welchem Abstand ein Leerzeichen gesetzt wird, als Anteil der Schriftgrösse.
 *
 * Ein Leerzeichen ist in den meisten Schriften 0,25 bis 0,33 em breit, eine
 * Sperrung liegt bei 0,05 bis 0,15 em. Der Wert dazwischen trennt die beiden
 * Fälle. Bewusst näher an der Sperrung als am Leerzeichen: ein fehlendes
 * Leerzeichen (zwei Wörter kleben) ist schlimmer als ein zusätzliches.
 */
const LUECKE_ALS_ANTEIL_DER_SCHRIFTGROESSE = 0.2;

export function joinTextItems(items: readonly TextItem[]): string {
  let text = '';
  let vorheriges: TextItem | null = null;

  for (const item of items) {
    if (typeof item.str !== 'string') continue;

    if (vorheriges !== null && !vorheriges.hasEOL && brauchtLeerzeichen(vorheriges, item)) {
      text += ' ';
    }

    text += item.str;
    if (item.hasEOL) text += '\n';
    vorheriges = item;
  }

  // Seitenende als Absatzgrenze: die Zerlegung schneidet bevorzugt dort.
  return text.replace(/[ \t]+\n/g, '\n') + '\n\n';
}

function brauchtLeerzeichen(vorheriges: TextItem, aktuelles: TextItem): boolean {
  // Endet oder beginnt bereits mit Leerraum: kein zweites dazwischen.
  if (vorheriges.str === '' || /\s$/.test(vorheriges.str ?? '')) return false;
  if (/^\s/.test(aktuelles.str ?? '')) return false;

  const links = vorheriges.transform;
  const rechts = aktuelles.transform;

  // Ohne Koordinaten bleibt nur die alte Annahme: lieber ein Leerzeichen zu
  // viel als zwei aneinandergeklebte Wörter.
  if (!links || !rechts || links.length < 6 || rechts.length < 6) return true;

  const schriftgroesse = Math.abs(links[0] ?? 0);
  if (schriftgroesse === 0) return true;

  // Eine neue Zeile ist immer eine Trennung, unabhängig vom Abstand.
  const zeilensprung = Math.abs((links[5] ?? 0) - (rechts[5] ?? 0)) > schriftgroesse * 0.5;
  if (zeilensprung) return true;

  const endeLinks = (links[4] ?? 0) + (vorheriges.width ?? 0);
  const luecke = (rechts[4] ?? 0) - endeLinks;

  return luecke > schriftgroesse * LUECKE_ALS_ANTEIL_DER_SCHRIFTGROESSE;
}
