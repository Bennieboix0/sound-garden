/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SYNC_ENABLED?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** Injected by Vercel's Supabase integration regardless of framework. */
  readonly NEXT_PUBLIC_SUPABASE_URL?: string;
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
  readonly NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// pdf.js ships its worker as a plain .mjs asset; Vite resolves it to a URL.
declare module '*.mjs?url' {
  const src: string;
  export default src;
}
