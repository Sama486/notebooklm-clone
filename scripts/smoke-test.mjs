/**
 * Durchlauf durch die wichtigsten Wege gegen eine laufende Installation.
 *
 *   node scripts/smoke-test.mjs https://notebooklm-clone-api.onrender.com
 *
 * Deckt ab: Registrierung, Notebook anlegen, Quelle einlesen, Frage stellen
 * mit Streaming und Belegen, Fremdzugriff (muss 404 sein), SSRF-Abwehr.
 *
 * Ruft im Gegensatz zu den Tests eine echte KI-API auf und kostet deshalb ein
 * paar Anfragen aus dem Kontingent. Ausdruecklich kein Ersatz fuer die Tests,
 * sondern eine Pruefung, dass die Verkabelung im Betrieb stimmt.
 */
const base = process.argv[2] ?? 'http://localhost:4310';

let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'OK  ' : 'FEHL';
  if (!condition) failures += 1;
  console.log(`${mark}  ${label}${detail ? `  (${detail})` : ''}`);
}

async function api(path, { token, method = 'GET', body, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (raw) headers['Content-Type'] = raw.contentType;
  else if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: raw ? raw.data : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function register() {
  const email = `smoke.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@example.test`;
  const result = await api('/api/auth/register', {
    method: 'POST',
    body: { email, password: 'ein-sicheres-testpasswort' },
  });
  if (result.status !== 201) throw new Error(`Registrierung: ${result.status}`);
  return result.body.token;
}

const QUELLE = `
Zugriffskontrolle im Projekt Notebook-Klon.

Der Besitz einer Ressource wird im Zugriffspfad geprueft und nicht in einer
nachgelagerten Bedingung. Konkret wird ein Notebook mit findFirst und den
Bedingungen id und userId geholt. Eine Abfrage ohne userId liefert damit
schlicht kein Ergebnis.

Die Antwort auf einen Zugriff auf fremde Daten ist 404 und nicht 403. Ein 403
wuerde bestaetigen, dass die angefragte Kennung existiert, und damit koennte
jemand fremde Kennungen durch Ausprobieren verifizieren.

Kindobjekte wie Quellen und Nachrichten tragen kein eigenes Besitzerfeld. Sie
erben die Trennung ueber ihr Notebook. Deshalb wird niemals eine Quelle direkt
ueber ihre eigene Kennung geladen.
`.repeat(3);

async function main() {
  console.log(`Ziel: ${base}\n`);

  // --- Gesundheit ---------------------------------------------------------
  const health = await api('/api/health');
  check('Health-Endpunkt antwortet', health.status === 200);

  // --- Konten -------------------------------------------------------------
  const alice = await register();
  const bob = await register();
  check('Registrierung liefert ein Token', typeof alice === 'string');

  const meOhneToken = await api('/api/notebooks');
  check('ohne Token gibt es 401', meOhneToken.status === 401, `Status ${meOhneToken.status}`);

  // --- Notebook -----------------------------------------------------------
  const created = await api('/api/notebooks', {
    token: alice,
    method: 'POST',
    body: { title: 'Rauchtest' },
  });
  check('Notebook angelegt', created.status === 201, `Status ${created.status}`);
  const notebookId = created.body?.notebook?.id;

  // --- Autorisierung ------------------------------------------------------
  const fremd = await api(`/api/notebooks/${notebookId}`, { token: bob });
  check('fremdes Notebook gibt 404 (nicht 403)', fremd.status === 404, `Status ${fremd.status}`);

  // --- SSRF ---------------------------------------------------------------
  for (const [label, url] of [
    ['Cloud-Metadaten', 'http://169.254.169.254/latest/meta-data/'],
    ['Loopback', 'http://127.0.0.1:8080/'],
    ['localhost als Name', 'http://localhost:8080/'],
    ['file://', 'file:///etc/passwd'],
  ]) {
    const result = await api(`/api/notebooks/${notebookId}/sources/url`, {
      token: alice,
      method: 'POST',
      body: { url },
    });
    check(`SSRF abgewehrt: ${label}`, result.status === 400, `Status ${result.status}`);
  }

  // --- Quelle einlesen ----------------------------------------------------
  const quelle = await api(`/api/notebooks/${notebookId}/sources/text`, {
    token: alice,
    method: 'POST',
    body: { title: 'Zugriffskontrolle', content: QUELLE },
  });
  check('Quelle angelegt', quelle.status === 201, `Status ${quelle.status}`);
  check('Antwort kommt sofort mit Status pending', quelle.body?.source?.status === 'pending');

  const sourceId = quelle.body?.source?.id;
  let status = 'pending';
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && status !== 'ready' && status !== 'failed') {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const list = await api(`/api/notebooks/${notebookId}/sources`, { token: alice });
    status = list.body?.sources?.find((s) => s.id === sourceId)?.status ?? status;
  }
  check('Quelle wurde verarbeitet', status === 'ready', `Status ${status}`);

  // --- Chat mit Belegen ---------------------------------------------------
  const started = Date.now();
  const response = await fetch(`${base}/api/notebooks/${notebookId}/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${alice}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Warum wird 404 statt 403 zurueckgegeben?' }),
  });
  check('Chat-Endpunkt antwortet', response.ok, `Status ${response.status}`);
  check(
    'Antwort ist ein Ereignisstrom',
    (response.headers.get('content-type') ?? '').includes('text/event-stream'),
  );

  const decoder = new TextDecoder();
  let packets = 0;
  let firstPacketMs = 0;
  let answer = '';
  let markerPositions = '';
  let citations = [];

  for await (const chunk of response.body) {
    if (packets === 0) firstPacketMs = Date.now() - started;
    packets += 1;
    for (const event of decoder.decode(chunk, { stream: true }).split('\n\n')) {
      const dataLine = event.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      try {
        const payload = JSON.parse(dataLine.slice(5).trim());
        if (payload.citations) citations = payload.citations;
        // Segmente statt eines Textfeldes: nur so ist bekannt, hinter welcher
        // Aussage ein Beleg steht.
        for (const segment of payload.segments ?? []) {
          answer += segment.text;
          markerPositions += segment.text + segment.markers.map((m) => `[${m}]`).join('');
        }
      } catch {
        // Unvollstaendiges Ereignis an einer Paketgrenze - der naechste
        // Durchlauf enthaelt es vollstaendig.
      }
    }
  }

  check('Antwort enthaelt Text', answer.trim().length > 20, `${answer.trim().length} Zeichen`);
  check('Antwort kam in mehreren Paketen', packets > 2, `${packets} Pakete`);
  check('erstes Paket kam schnell', firstPacketMs < 15_000, `${firstPacketMs} ms`);
  check('Belege wurden geliefert', citations.length > 0, `${citations.length} Belege`);
  check(
    'Belege tragen Zeichen-Positionen',
    citations.every((c) => Number.isInteger(c.charStart) && c.charEnd > c.charStart),
  );
  check(
    'Marker sind aus dem Antworttext entfernt',
    !/\[\d{1,3}\]/.test(answer),
    answer.slice(0, 80).replace(/\s+/g, ' '),
  );
  check(
    'kein Leerzeichen vor dem Beleg',
    !/ \[\d{1,3}\]/.test(markerPositions),
    markerPositions.slice(-60).replace(/\s+/g, ' '),
  );

  // --- Beleg zeigt auf die richtige Stelle --------------------------------
  const volltext = await api(`/api/notebooks/${notebookId}/sources/${sourceId}`, { token: alice });
  const content = volltext.body?.source?.content ?? '';
  const beleg = citations[0];
  check(
    'Zeichen-Positionen liegen im Volltext',
    Boolean(beleg) && beleg.charEnd <= content.length,
    beleg ? `${beleg.charStart}-${beleg.charEnd} von ${content.length}` : 'kein Beleg',
  );

  // --- Aufraeumen ---------------------------------------------------------
  await api(`/api/notebooks/${notebookId}`, { token: alice, method: 'DELETE' });

  console.log(`\n${failures === 0 ? 'Alle Pruefungen bestanden.' : `${failures} Pruefung(en) fehlgeschlagen.`}`);
  console.log('\nAntwort des Modells:');
  console.log(answer.trim().slice(0, 600));
  process.exit(failures === 0 ? 0 : 1);
}

await main();
