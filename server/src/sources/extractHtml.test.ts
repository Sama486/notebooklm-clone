import { describe, expect, it } from 'vitest';
import { extractHtml, titleFromUrl } from './extractHtml.js';

describe('HTML-Extraktion', () => {
  it('nimmt den Titel aus <title>', () => {
    const result = extractHtml(
      '<html><head><title>Jahresbericht 2024</title></head><body><p>Inhalt der Seite hier.</p></body></html>',
      'ersatz',
    );
    expect(result.title).toBe('Jahresbericht 2024');
  });

  it('fällt auf h1 und dann auf den Ersatztitel zurück', () => {
    expect(extractHtml('<body><h1>Überschrift</h1><p>Text.</p></body>', 'ersatz').title).toBe(
      'Überschrift',
    );
    expect(extractHtml('<body><p>Nur Text.</p></body>', 'ersatz').title).toBe('ersatz');
  });

  it('entfernt Skripte, Stile und Navigation', () => {
    const html = `
      <body>
        <nav>Startseite Kontakt Impressum</nav>
        <script>const geheim = "nicht im text";</script>
        <style>.a { color: red; }</style>
        <main><p>Der eigentliche Inhalt der Seite.</p></main>
        <footer>Copyright 2024</footer>
      </body>`;
    const { text } = extractHtml(html, 'ersatz');

    expect(text).toContain('Der eigentliche Inhalt');
    expect(text).not.toContain('nicht im text');
    expect(text).not.toContain('color: red');
    expect(text).not.toContain('Impressum');
    expect(text).not.toContain('Copyright');
  });

  it('entfernt HTML-Kommentare', () => {
    const { text } = extractHtml(
      '<body><p>Sichtbar.</p><!-- verworfene Fassung: geheim --></body>',
      'ersatz',
    );
    expect(text).not.toContain('geheim');
  });

  it('bevorzugt <article>, wenn dort genug Text steht', () => {
    const langerText = 'Ein Satz mit ausreichend Zeichen für die Erkennung. '.repeat(10);
    const html = `<body><div>Beiwerk am Rand.</div><article><p>${langerText}</p></article></body>`;
    const { text } = extractHtml(html, 'ersatz');

    expect(text).toContain('ausreichend Zeichen');
    expect(text).not.toContain('Beiwerk am Rand');
  });

  it('ignoriert ein leeres <main> und nimmt den Body', () => {
    const html = '<body><main></main><p>Der Text steht hier daneben.</p></body>';
    expect(extractHtml(html, 'ersatz').text).toContain('Der Text steht hier daneben');
  });

  it('macht aus Blockelementen Absatzgrenzen', () => {
    // Ohne diese Grenzen hätte die Zerlegung nichts zum Schneiden und der
    // ganze Text wäre ein einziger Block.
    const { text } = extractHtml('<body><p>Erster Absatz.</p><p>Zweiter Absatz.</p></body>', 'e');
    expect(text).toMatch(/Erster Absatz\.\s*\n\s*\n?\s*Zweiter Absatz\./);
  });

  it('normalisiert geschützte Leerzeichen', () => {
    // Sehen aus wie Leerzeichen, sind aber keine - die Zerlegung würde an
    // ihnen keine Wortgrenze erkennen.
    const { text } = extractHtml('<body><p>zehn&nbsp;Prozent&nbsp;mehr</p></body>', 'e');
    expect(text).toContain('zehn Prozent mehr');
    expect(text).not.toContain(' ');
  });

  it('wirft, wenn die Seite keinen Text enthält', () => {
    expect(() => extractHtml('<body><script>nur code</script></body>', 'e')).toThrowError();
  });
});

describe('Ersatztitel aus der URL', () => {
  it('nimmt Hostname und Pfad', () => {
    expect(titleFromUrl('https://example.com/berichte/2024')).toBe('example.com/berichte/2024');
    expect(titleFromUrl('https://example.com/')).toBe('example.com');
  });

  it('kommt mit einer kaputten URL zurecht', () => {
    expect(titleFromUrl('keine-url')).toBe('keine-url');
  });
});
