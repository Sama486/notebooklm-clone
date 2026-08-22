import { describe, expect, it } from 'vitest';
import { buildChatMarkdown, dateiname, type ExportMessage } from './exportChat.js';
import type { Citation } from './types.js';

const beleg = (marker: number, extra: Partial<Citation> = {}): Citation => ({
  marker,
  chunkId: `chunk-${marker}`,
  sourceId: `source-${marker}`,
  sourceTitle: 'Lebenslauf',
  charStart: 0,
  charEnd: 100,
  page: 2,
  snippet: 'Ein Ausschnitt aus dem Dokument.',
  ...extra,
});

const frage = (text: string): ExportMessage => ({
  role: 'user',
  segments: [{ text, markers: [] }],
  citations: [],
});

describe('Markdown-Export des Gesprächsverlaufs', () => {
  it('setzt die Marker an ihrer Position wieder in den Text', () => {
    // GENAU DIESER FALL war der Fehler: die Oberfläche entfernt den Marker aus
    // dem Text und setzt an seiner Stelle einen Chip. Wer für den Export nur
    // diesen Text nimmt, schreibt eine Antwort ohne jeden Marker und darunter
    // eine Liste von Belegen, die zu nichts mehr gehören.
    const markdown = buildChatMarkdown('Notizbuch', [
      frage('Wo hat er gearbeitet?'),
      {
        role: 'assistant',
        segments: [
          { text: 'Bis Juli 2022 bei der ersten Firma', markers: [2] },
          { text: ', danach bei der zweiten', markers: [3] },
          { text: '.', markers: [] },
        ],
        citations: [beleg(2), beleg(3)],
      },
    ]);

    expect(markdown).toContain('Bis Juli 2022 bei der ersten Firma[2], danach bei der zweiten[3].');
  });

  it('schreibt die Belege mit Quelle, Seite und Ausschnitt', () => {
    const markdown = buildChatMarkdown('Notizbuch', [
      frage('Frage?'),
      {
        role: 'assistant',
        segments: [{ text: 'Antwort', markers: [1] }],
        citations: [beleg(1, { sourceTitle: 'Handbuch', page: 7, snippet: 'Der Ausschnitt.' })],
      },
    ]);

    // Eine blosse Nummer wäre ausserhalb der Anwendung wertlos.
    expect(markdown).toContain('- **[1]** Handbuch, Seite 7');
    expect(markdown).toContain('> Der Ausschnitt.');
  });

  it('lässt die Seitenangabe weg, wenn es keine gibt', () => {
    const markdown = buildChatMarkdown('Notizbuch', [
      frage('Frage?'),
      {
        role: 'assistant',
        segments: [{ text: 'Antwort', markers: [1] }],
        citations: [beleg(1, { page: null })],
      },
    ]);
    expect(markdown).toContain('- **[1]** Lebenslauf\n');
    expect(markdown).not.toContain('Seite null');
  });

  it('bricht Zeilenumbrüche im Ausschnitt um, damit der Zitatblock hält', () => {
    // Ein mehrzeiliger Ausschnitt würde den Markdown-Zitatblock nach der ersten
    // Zeile verlassen und der Rest stünde als Fliesstext da.
    const markdown = buildChatMarkdown('Notizbuch', [
      frage('Frage?'),
      {
        role: 'assistant',
        segments: [{ text: 'Antwort', markers: [1] }],
        citations: [beleg(1, { snippet: 'Erste Zeile\n\nZweite Zeile' })],
      },
    ]);
    expect(markdown).toContain('> Erste Zeile Zweite Zeile');
  });

  it('kommt mit einer Antwort ganz ohne Belege zurecht', () => {
    const markdown = buildChatMarkdown('Notizbuch', [
      frage('Frage?'),
      { role: 'assistant', segments: [{ text: 'Weiss ich nicht.', markers: [] }], citations: [] },
    ]);

    expect(markdown).toContain('Weiss ich nicht.');
    expect(markdown).not.toContain('**Belege**');
  });

  it('setzt Titel und Überschriften', () => {
    const markdown = buildChatMarkdown('Mein Notizbuch', [frage('Eine Frage?')]);
    expect(markdown.startsWith('# Mein Notizbuch')).toBe(true);
    expect(markdown).toContain('## Frage');
    expect(markdown).toContain('Eine Frage?');
  });

  it('kommt mit leerem Verlauf zurecht', () => {
    expect(() => buildChatMarkdown('Leer', [])).not.toThrow();
  });
});

describe('Dateiname', () => {
  it('macht aus dem Titel einen unbedenklichen Namen', () => {
    expect(dateiname('Zugriffskontrolle und Belege')).toBe('zugriffskontrolle-und-belege-chat.md');
    expect(dateiname('Größe & Prüfung')).toBe('groesse-pruefung-chat.md');
  });

  it('lässt keine Pfadanteile durch', () => {
    // Der Titel kommt vom Nutzer und darf den Speicherort nicht bestimmen.
    for (const titel of ['../../etc/passwd', 'C:\\Windows\\system32', 'a/b/c']) {
      const name = dateiname(titel);
      expect(name, titel).not.toContain('/');
      expect(name, titel).not.toContain('\\');
      expect(name, titel).not.toContain('..');
    }
  });

  it('fällt auf einen Standardnamen zurück', () => {
    expect(dateiname('///')).toBe('notebook-chat.md');
    expect(dateiname('')).toBe('notebook-chat.md');
  });
});
