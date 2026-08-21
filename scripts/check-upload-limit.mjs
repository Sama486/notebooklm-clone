/**
 * Wie groß darf eine Anfrage an die öffentliche API tatsächlich sein?
 *
 * Render dokumentiert keine Obergrenze für die Anfragegrösse. Verlassen kann
 * man sich nur auf eine Messung - und zwar früh, weil die Grenze bestimmt,
 * wie groß ein hochladbares PDF sein darf und was das Frontend vorher abfangen
 * muss.
 *
 *   node scripts/check-upload-limit.mjs https://notebooklm-clone-api.onrender.com
 *
 * Legt dafür ein Wegwerf-Konto an und lädt PDFs wachsender Größe hoch.
 * Erwartet wird, dass die eigene Grenze aus server/src/config.ts zürst greift
 * (HTTP 413) - und nicht der Proxy mit einem Verbindungsabbruch, den niemand
 * dem Nutzer erklären kann.
 */
const base = process.argv[2] ?? 'http://localhost:4310';

/** Minimales gültiges PDF, auf die gewünschte Größe aufgefüllt. */
function makePaddedPdf(targetBytes) {
  const head = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj',
    '4 0 obj << /Length 60 >>',
    'stream',
    'BT /F1 12 Tf 72 720 Td (Messung der Anfragegrösse.) Tj ET',
    'endstream endobj',
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'trailer << /Size 6 /Root 1 0 R >>',
    '%%EOF',
    '',
  ].join('\n');

  // Füllmaterial hinter %%EOF. PDF-Leser ignorieren, was nach dem Dateiende
  // steht; für die Übertragung zählen die Bytes trotzdem.
  const padding = Math.max(0, targetBytes - Buffer.byteLength(head) - 2);
  return Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from('%'.repeat(padding)), Buffer.from('\n')]);
}

async function main() {
  const email = `messung.${Date.now()}@example.test`;
  const password = 'ein-sicheres-testpasswort';

  const registration = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!registration.ok) {
    console.error(`Registrierung fehlgeschlagen: HTTP ${registration.status}`);
    process.exit(1);
  }
  const { token } = await registration.json();
  const authHeader = { Authorization: `Bearer ${token}` };

  const notebookResponse = await fetch(`${base}/api/notebooks`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Messung Anfragegrösse' }),
  });
  const { notebook } = await notebookResponse.json();

  console.log(`Ziel: ${base}`);
  console.log('Größe   Status  Daür     Antwort');
  console.log('-'.repeat(64));

  for (const megabytes of [1, 5, 10, 14, 15, 16, 20, 30]) {
    const body = makePaddedPdf(megabytes * 1024 * 1024);
    const started = Date.now();

    let status = '---';
    let detail = '';
    try {
      const response = await fetch(
        `${base}/api/notebooks/${notebook.id}/sources/pdf?title=${megabytes}MB`,
        { method: 'POST', headers: { ...authHeader, 'Content-Type': 'application/pdf' }, body },
      );
      status = String(response.status);
      const text = await response.text();
      detail = text.slice(0, 60).replace(/\s+/g, ' ');
    } catch (error) {
      // Ein abgebrochener Verbindungsaufbau ist selbst ein Ergebnis: dann hat
      // der Proxy zugeschlagen, nicht die Anwendung.
      status = 'ABBRUCH';
      detail = String(error.cause?.code ?? error.message).slice(0, 60);
    }

    const duration = `${Date.now() - started} ms`;
    console.log(
      `${String(megabytes + ' MB').padEnd(9)} ${status.padEnd(7)} ${duration.padEnd(9)} ${detail}`,
    );
  }

  // Aufräumen: das Wegwerf-Konto und alles daran hängende verschwindet mit
  // dem Notebook nicht - deshalb bleibt es stehen und wird im README als
  // bekannter Nebeneffekt der Messung benannt.
  await fetch(`${base}/api/notebooks/${notebook.id}`, { method: 'DELETE', headers: authHeader });
  console.log('\nNotebook der Messung wieder gelöscht.');
}

await main();
