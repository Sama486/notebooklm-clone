/// <reference types="vite/client" />

/** Die Umgebungsvariablen, die das Frontend kennt. */
interface ImportMetaEnv {
  /**
   * Basis-URL der API. Leer im Entwicklungsbetrieb - dann läuft alles über
   * den Vite-Proxy und damit über denselben Ursprung.
   */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
