/**
 * Kommt ein Stream ungepuffert beim Client an?
 *
 * Ruft /api/stream-probe auf und schreibt fuer jedes empfangene Paket den
 * Abstand zum vorherigen. Der Endpunkt sendet zehn Woerter im Sekundentakt.
 *
 *   node scripts/check-streaming.mjs https://notebooklm-clone-api.onrender.com
 *
 * Abstaende um 1000 ms: der Stream geht durch.
 * Alle Pakete auf einmal am Ende: etwas dazwischen puffert - dann waere auch
 * die Chat-Antwort keine wachsende Zeile, sondern eine lange Pause mit einem
 * Block am Schluss.
 */
const base = process.argv[2] ?? 'http://localhost:4310';

const started = Date.now();
let previous = started;
let packets = 0;

const response = await fetch(`${base}/api/stream-probe`);
if (!response.ok || !response.body) {
  console.error(`Fehlgeschlagen: HTTP ${response.status}`);
  process.exit(1);
}

const decoder = new TextDecoder();
for await (const chunk of response.body) {
  const now = Date.now();
  const text = decoder.decode(chunk, { stream: true }).replace(/\s+/g, ' ').trim();
  packets += 1;
  console.log(
    `+${String(now - started).padStart(6)} ms  (Abstand ${String(now - previous).padStart(5)} ms)  ${text.slice(0, 70)}`,
  );
  previous = now;
}

const total = Date.now() - started;
console.log(`\n${packets} Pakete in ${total} ms`);
// Zehn Woerter im Sekundentakt: bei durchgereichtem Stream kommen mindestens
// zehn Pakete an. Puffert etwas dazwischen, sind es ein oder zwei.
console.log(packets >= 10 ? 'ERGEBNIS: ungepuffert.' : 'ERGEBNIS: GEPUFFERT - Stream kommt nicht durch.');
process.exit(packets >= 10 ? 0 : 1);
