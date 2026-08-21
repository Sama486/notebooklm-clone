import { useEffect, useRef } from 'react';

/**
 * Zeigt Dokumenttext und hebt einen Bereich hervor.
 *
 * DIE SICHERHEITSRELEVANTE STELLE DES FRONTENDS.
 *
 * Der angezeigte Text stammt aus einer hochgeladenen Datei oder einer fremden
 * Website - also von jemandem, dem wir nicht vertraün. Der naheliegende Weg
 * wäre, um die Fundstelle ein <mark> zu baün und das Ganze per
 * dangerouslySetInnerHTML einzusetzen. Das wäre eine XSS-Lücke: ein Dokument
 * mit <script> oder <img onerror=...> im Text würde bei jedem Betrachter
 * ausgeführt.
 *
 * Stattdessen wird der Text in drei Stücke geschnitten und als drei React-
 * Kinder gerendert. React setzt Zeichenketten als Textknoten ein, nie als
 * Markup - "<script>" erscheint dann als die acht Zeichen, die es ist. Es gibt
 * in diesem Projekt keine Stelle, an der Dokumentinhalt oder Modellausgabe zu
 * HTML zusammengesetzt wird.
 */

interface HighlightedTextProps {
  text: string;
  /** Zeichen-Position, ab der hervorgehoben wird; `null` für keine Hervorhebung. */
  charStart: number | null;
  charEnd: number | null;
}

export function HighlightedText({ text, charStart, charEnd }: HighlightedTextProps) {
  const markRef = useRef<HTMLElement>(null);

  // Zur hervorgehobenen Stelle scrollen, sobald sie sich ändert.
  useEffect(() => {
    markRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [charStart, charEnd]);

  const hasHighlight =
    charStart !== null &&
    charEnd !== null &&
    charStart >= 0 &&
    charEnd > charStart &&
    charStart < text.length;

  if (!hasHighlight) {
    return <span className="whitespace-pre-wrap break-words">{text}</span>;
  }

  // Auf die Textlänge begrenzen: veraltete Positionen würden sonst einen
  // leeren oder falschen Ausschnitt ergeben.
  const start = Math.min(charStart, text.length);
  const end = Math.min(charEnd, text.length);

  return (
    <span className="whitespace-pre-wrap break-words">
      {text.slice(0, start)}
      <mark ref={markRef} className="rounded bg-amber-200 px-0.5 py-px text-slate-900">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </span>
  );
}
