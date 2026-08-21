/**
 * Modellvergleich: welches Modell setzt die Zitat-Marker zuverlässiger?
 *
 *   node scripts/compare-models.mjs
 *
 * Zwanzig Fragen gegen dieselben Textstellen, zwei Modelle. Gezählt wird, wie
 * oft ein Marker fehlt, eine Nummer verwendet wird, die es nicht gibt, oder ein
 * Marker mitten in einem Wort steht.
 *
 * Der Grund für die Messung: die Belege sind das Kernfeature. Welches Modell
 * sie sauber setzt, ist eine Tatsachenfrage - und eine halbe Stunde Messung
 * ersetzt eine Vermutung durch eine belastbare Aussage.
 *
 * Braucht GEMINI_API_KEY aus der .env im Wurzelverzeichnis.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(here, '../.env');
const apiKey =
  process.env.GEMINI_API_KEY ??
  (fs.existsSync(envFile)
    ? (fs.readFileSync(envFile, 'utf8').match(/^GEMINI_API_KEY\s*=\s*"?([^"\r\n]+)"?/m)?.[1] ?? '')
    : '');

if (!apiKey) {
  console.error('GEMINI_API_KEY fehlt.');
  process.exit(1);
}

// Kandidaten mit brauchbarem freiem Kontingent.
//
// Die großen Flash-Modelle scheiden aus, bevor die Qualität überhaupt zur
// Debatte steht: gemini-3-flash-preview und gemini-3.6-flash erlauben in der
// kostenlosen Stufe zwanzig Anfragen AM TAG. Das reicht weder für diese
// Messung noch für eine Demo. Gemessen, nicht vermutet - die 429-Antwort
// nennt das Limit ausdrücklich.
const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];

const PASSAGES = [
  'Passwörter werden mit bcrypt und dem Kostenfaktor zwölf gehasht. Zwölf statt der verbreiteten zehn bedeutet viermal so viel Rechenzeit je Versuch und liegt für den anmeldenden Nutzer weiterhin unter einer viertel Sekunde.',
  'Beim Verifizieren eines JWT wird der Algorithmus ausdrücklich als HS256 vorgegeben. Ohne diese Angabe akzeptiert die Bibliothek den Algorithmus, der im Token selbst steht, und ein Angreifer könnte ein Token mit alg none einreichen.',
  'Der Besitz einer Ressource wird im Zugriffspfad geprüft. Ein Notebook wird mit findFirst und den Bedingungen id und userId geholt, nicht mit findUnique und einer nachgelagerten Bedingung.',
  'Die Antwort auf einen Zugriff auf fremde Daten ist 404 und nicht 403. Ein 403 würde bestätigen, dass die angefragte Kennung existiert.',
  'Beim Abruf einer vom Nutzer angegebenen Adresse werden alle aufgelösten IP-Adressen geprüft, nicht nur die erste. Die geprüffte Adresse wird anschliessend an die Verbindung gebunden, damit zwischen Prüfung und Verbindungsaufbau kein Zeitfenster für DNS Rebinding entsteht.',
  'Der Dateityp eines Uploads wird an den ersten Bytes des Inhalts erkannt, nicht an der Dateiendung und nicht am mitgeschickten Content-Type. Beides bestimmt der Absender frei.',
  'Die Ähnlichkeitssuche ist ein exakter Durchlauf über alle Abschnitte eines Notebooks. Bei zehntausend Abschnitten daürt die Datenbankabfrage vierzehn Sekunden, die Rangfolge im Speicher dagegen nur neun Millisekunden.',
  'Embeddings werden erzeugt, bevor die Transaktion beginnt. Ein Netzaufruf innerhalb einer offenen Transaktion hält Verbindung und Sperren so lange, wie der fremde Dienst braucht.',
  'Ein Zitat-Marker kann beim Streamen zwischen zwei Paketen zerrissen werden. Ein Rückhaltefenster von höchstens vier Zeichen am Pufferende löst das, ohne die wahrgenommene Geschwindigkeit zu beeinträchtigen.',
  'Die Abschnitte tragen die Felder charStart und charEnd. Ohne diese Zeichen-Positionen könnte die Oberfläche nicht zur zitierten Stelle im Dokument springen.',
];

const QUESTIONS = [
  'Welcher Kostenfaktor wird bei bcrypt verwendet?',
  'Warum zwölf und nicht zehn?',
  'Welcher Algorithmus wird beim JWT vorgegeben?',
  'Was passiert ohne ausdrückliche Angabe des Algorithmus?',
  'Wie wird der Besitz einer Ressource geprüft?',
  'Welche Prisma-Methode wird dafür verwendet?',
  'Warum wird 404 statt 403 zurückgegeben?',
  'Wie viele IP-Adressen werden beim URL-Abruf geprüft?',
  'Wogegen schützt die Bindung der IP an die Verbindung?',
  'Woran wird der Dateityp eines Uploads erkannt?',
  'Warum reicht die Dateiendung nicht aus?',
  'Wie lange daürt die Datenbankabfrage bei zehntausend Abschnitten?',
  'Wie lange braucht die Rangfolge im Speicher?',
  'Wann werden die Embeddings erzeugt?',
  'Warum liegen die Embeddings außerhalb der Transaktion?',
  'Wie groß ist das Rückhaltefenster beim Streamen?',
  'Welches Problem löst das Rückhaltefenster?',
  'Welche Felder tragen die Zeichen-Positionen?',
  'Wozu werden charStart und charEnd gebraucht?',
  'Welche Rolle spielt der Content-Type beim Upload?',
];

const SYSTEM = [
  'Du beantwortest Fragen ausschließlich auf Grundlage der Textstellen, die dir der Nutzer mitschickt.',
  '',
  'Regeln:',
  '1. Antworte nur mit dem, was in den Textstellen steht.',
  '2. Steht die Antwort nicht dort, sage genau das.',
  '3. Belege jede Aussage mit der Nummer der Textstelle in eckigen Klammern, zum Beispiel [1]. Setze den Marker direkt hinter die Aussage. Verwende nur Nummern, die es wirklich gibt.',
  '4. Antworte auf Deutsch, sachlich und knapp.',
].join('\n');

const userMessage = (question) =>
  [
    'Textstellen:',
    '',
    ...PASSAGES.map((text, i) => `<<<TEXTSTELLE ${i + 1}\n${text}\nENDE-TEXTSTELLE>>>`),
    '',
    `Frage: ${question}`,
  ].join('\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Eine Frage stellen, mit Wiederholung bei Kontingentfehlern.
 *
 * Die kostenlose Stufe erlaubt nur wenige Anfragen je Minute. Ohne Wiederholung
 * scheitert der Grossteil der Aufrufe mit 429, und die Messung zählt dann
 * nicht die Qualität der Marker, sondern das Kontingent - ein Ergebnis, das
 * schlimmer wäre als keines, weil es echt aussieht.
 */
async function ask(model, question) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: 'user', parts: [{ text: userMessage(question) }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
          }),
        },
      );
    } catch {
      // Abgerissene Verbindung: kein Grund, eine halbe Stunde Messung
      // wegzuwerfen. Kurz warten und erneut versuchen.
      await sleep(5_000 * (attempt + 1));
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      return {
        text: parts.map((p) => p.text ?? '').join(''),
        status: 200,
        // Denkschritte zählen gegen das Ausgabe-Kontingent und kosten Zeit.
        // Ob sie für belegte Antworten etwas bringen, ist genau die Frage.
        thoughts: data.usageMetadata?.thoughtsTokenCount ?? 0,
      };
    }

    // 429 heißt Kontingent: warten und erneut versuchen. Alles andere ist ein
    // echter Fehler, den Wiederholen nicht behebt.
    if (response.status !== 429) return { text: '', status: response.status };
    await sleep(15_000 * (attempt + 1));
  }
  return { text: '', status: 429 };
}

/** Zählt die drei Fehlerarten in einer Antwort. */
function inspect(text) {
  const markers = [...text.matchAll(/\[(\d{1,3})\]/g)];

  return {
    missing: markers.length === 0,
    // Nummer, die es in den Textstellen nicht gibt.
    outOfRange: markers.some((m) => {
      const n = Number.parseInt(m[1], 10);
      return n < 1 || n > PASSAGES.length;
    }),
    // Marker klebt zwischen zwei Buchstaben - im Fliesstext unlesbar.
    insideWord: /\p{L}\[\d{1,3}\]\p{L}/u.test(text),
  };
}

async function main() {
  console.log(`${QUESTIONS.length} Fragen, ${PASSAGES.length} Textstellen, ${MODELS.length} Modelle.\n`);

  const results = [];

  for (const model of MODELS) {
    const tally = { missing: 0, outOfRange: 0, insideWord: 0, failed: 0, thoughts: 0 };
    const started = Date.now();

    for (const question of QUESTIONS) {
      const { text, status, thoughts } = await ask(model, question);
      if (status !== 200) {
        tally.failed += 1;
        console.log(`  Frage übersprungen, HTTP ${status}`);
        continue;
      }
      tally.thoughts += thoughts ?? 0;
      const issues = inspect(text);
      if (issues.missing) tally.missing += 1;
      if (issues.outOfRange) tally.outOfRange += 1;
      if (issues.insideWord) tally.insideWord += 1;
    }

    tally.answered = QUESTIONS.length - tally.failed;
    results.push({ model, ...tally, seconds: Math.round((Date.now() - started) / 1000) });
    console.log(`${model} fertig (${Math.round((Date.now() - started) / 1000)} s)`);
  }

  console.log('');
  console.log(
    '| Modell | Beantwortet | Marker fehlt | Nummer erfunden | Marker im Wort | Denk-Token | Sekunden je Frage |',
  );
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of results) {
    const perQuestion = r.answered > 0 ? (r.seconds / r.answered).toFixed(1) : '-';
    console.log(
      `| ${r.model} | ${r.answered}/${QUESTIONS.length} | ${r.missing}/${r.answered} |` +
        ` ${r.outOfRange}/${r.answered} | ${r.insideWord}/${r.answered} |` +
        ` ${r.thoughts} | ${perQuestion} |`,
    );
  }
}

await main();
