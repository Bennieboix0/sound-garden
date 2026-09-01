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
export const SYNC_ENABLED: boolean =
  (import.meta.env.VITE_SYNC_ENABLED ?? 'true').toString().toLowerCase() !== 'false';

/**
 * Sync additionally needs somewhere to sync *to*. Absent credentials is not an
 * error — it is simply a build with no backend configured, and the app stays
 * fully usable.
 */
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY: string = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';

export function isSyncConfigured(): boolean {
  return SYNC_ENABLED && SUPABASE_URL !== '' && SUPABASE_ANON_KEY !== '';
}
