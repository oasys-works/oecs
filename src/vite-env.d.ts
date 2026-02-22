/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_TITLE?: string;
  // Add more env variables as needed
  readonly MODE: "dev" | "staging" | "prod";
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Global build-mode flags for dead code elimination
declare const __DEV__: boolean;
