/// <reference types="vite/client" />

// pdf.js ships its worker as a plain .mjs asset; Vite resolves it to a URL.
declare module '*.mjs?url' {
  const src: string;
  export default src;
}
