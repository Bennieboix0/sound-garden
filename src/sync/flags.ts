/**
 * Build-time switch for the entire sync feature.
 *
 * Set `VITE_SYNC_ENABLED=false` to compile Sound Garden as it was: purely
 * local, no accounts, no network code reachable. Everything under src/sync/
 * and every call site guarded by this flag must degrade to the offline
 * behaviour, never to an error.
 *
 * Defaults to enabled so a plain `npm run dev` exercises the same paths a
 * release build does.
 */
// Written as a direct comparison so Vite's define-replacement leaves a plain
// `false` behind, which Rollup can then use to drop the Supabase client and its
// entire dependency tree from the bundle. A cleverer expression here would
// still work at runtime but would defeat the dead-code elimination.
export const SYNC_ENABLED: boolean = import.meta.env.VITE_SYNC_ENABLED !== 'false';

/**
 * Sync additionally needs somewhere to sync *to*. Absent credentials is not an
 * error — it is simply a build with no backend configured, and the app stays
 * fully usable.
 */
/**
 * Read under several names on purpose.
 *
 * Vercel's Supabase integration injects `NEXT_PUBLIC_*` variables whatever
 * framework the project actually uses, and Supabase has renamed the anon key to
 * the "publishable" key. Accepting all of them means connecting the integration
 * just works, instead of silently building a local-only app because the names
 * did not line up.
 *
 * Each read is a literal member access so Vite replaces it with a constant at
 * build time — a dynamic lookup would defeat both the inlining and the dead
 * code elimination that strips the client when sync is off.
 *
 * Only public names are read. The same integration also injects a service role
 * key and a database password; those carry no public prefix, are never read
 * here, and must never be exposed to a browser.
 */
export const SUPABASE_URL: string =
  import.meta.env.VITE_SUPABASE_URL ??
  import.meta.env.NEXT_PUBLIC_SUPABASE_URL ??
  '';

export const SUPABASE_ANON_KEY: string =
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  import.meta.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  '';

export function isSyncConfigured(): boolean {
  return SYNC_ENABLED && SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '';
}
