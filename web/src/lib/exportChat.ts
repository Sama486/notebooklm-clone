import type { Citation } from './types.js';

/**
 * Baut aus einem Gesprächsverlauf ein Markdown-Dokument zum Herunterladen.
 *
 * Reine Funktion ohne DOM-Zugriff - damit ist sie ohne Browser testbar, und der
 * Teil, der wirklich etwas tun kann (der Download), bleibt drei Zeilen lang.
 *
 * Die Belege werden als Fussnoten unter jede Antwort geschrieben. Ein Zitat,
 * das nur aus einer Nummer besteht, ist ausserhalb der Anwendung wertlos -
 * mitgeschrieben gehören Quelle, Seite und der zitierte Ausschnitt.
 */

export interface ExportMessage {
  role: 'user' | 'assistant';
  text: string;
  citations: Citation[];
}

export function buildChatMarkdown(notebookTitle: string, messages: ExportMessage[]): string {
  const zeilen: string[] = [
    `# ${notebookTitle}`,
    '',
    `_Exportiert am ${new Date().toLocaleString('de-DE')}_`,
    '',
    '---',
    '',
  ];

  for (const message of messages) {
    if (message.role === 'user') {
      zeilen.push(`## Frage`, '', message.text.trim(), '');
      continue;
    }

    zeilen.push('### Antwort', '', message.text.trim(), '');

    if (message.citations.length > 0) {
      zeilen.push('**Belege**', '');
      for (const citation of message.citations) {
        const seite = citation.page === null ? '' : `, Seite ${citation.page}`;
        zeilen.push(`- **[${citation.marker}]** ${citation.sourceTitle}${seite}`);
        // Der Ausschnitt als Zitatblock, damit er sich vom Fliesstext abhebt.
        zeilen.push(`  > ${citation.snippet.replace(/\n+/g, ' ').trim()}`);
      }
      zeilen.push('');
    }

    zeilen.push('---', '');
  }

  return zeilen.join('\n');
}

/** Aus einem Titel einen Dateinamen machen, der auf jedem System funktioniert. */
export function dateiname(notebookTitle: string): string {
  const grundlage = notebookTitle
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    // Alles, was in Dateinamen Ärger macht, wird zum Bindestrich. Der Titel
    // kommt vom Nutzer und darf keine Pfadanteile einschleusen.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return `${grundlage || 'notebook'}-chat.md`;
}

/** Lädt den Text als Datei herunter. */
export function downloadMarkdown(inhalt: string, name: string): void {
  const url = URL.createObjectURL(new Blob([inhalt], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  // Ohne das bleibt der Blob bis zum Neuladen der Seite im Speicher.
  URL.revokeObjectURL(url);
}
