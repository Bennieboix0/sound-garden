/**
 * Live check of the two reported bugs, against the real Supabase project.
 *  1. A signed-out student can join a group with a code and a name.
 *  2. A session survives a reload without a network round trip.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync('/Users/176510/sound-garden/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const url = env.VITE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const ok = [], bad = [];
const check = (n, p, d = '') => (p ? ok : bad).push(n + (d ? ': ' + d : ''));

/** A localStorage stand-in, so session persistence can actually be observed. */
function makeStore() {
  const map = new Map();
  return {
    store: map,
    adapter: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    },
  };
}

function client(storage) {
  return createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      storageKey: 'sound-garden-auth',
      storage,
    },
  });
}

// --- A director makes a group ----------------------------------------------
const dir = client(makeStore().adapter);
await dir.auth.signInAnonymously({ options: { data: { display_name: 'Ms Vaughan' } } });
const made = await dir.rpc('create_ensemble', {
  ensemble_name: 'Join Bug Test', director_name: 'Ms Vaughan',
});
const ensemble = Array.isArray(made.data) ? made.data[0] : made.data;
check('director created an ensemble', Boolean(ensemble?.id), made.error?.message ?? '');

// --- Bug 1: joining while signed out ---------------------------------------
// Old behaviour: call the RPC with no session at all.
const strangerStore = makeStore();
const stranger = client(strangerStore.adapter);
const beforeFix = await stranger.rpc('join_ensemble', {
  code: ensemble.join_code, display_name: 'Ben R',
});
check('reproduced the bug: joining signed-out is refused by the server',
  Boolean(beforeFix.error) || beforeFix.data === null,
  beforeFix.error?.message ?? 'returned ' + JSON.stringify(beforeFix.data));

// New behaviour: sign in anonymously first, exactly as the app now does.
await stranger.auth.signInAnonymously({ options: { data: { display_name: 'Ben R' } } });
const afterFix = await stranger.rpc('join_ensemble', {
  code: ensemble.join_code, display_name: 'Ben R',
});
check('after signing in anonymously, the join succeeds',
  afterFix.data === ensemble.id, afterFix.error?.message ?? String(afterFix.data));

const strangerId = (await stranger.auth.getUser()).data.user?.id ?? null;
const membership = await stranger.from('ensemble_members').select('display_name, role');
check('the student is now a member, by display name only',
  membership.data?.length === 1 && membership.data[0].display_name === 'Ben R'
    && membership.data[0].role === 'member',
  JSON.stringify(membership.data));

const visible = await stranger.from('ensembles').select('name');
check('the student can now see the group',
  visible.data?.length === 1 && visible.data[0].name === 'Join Bug Test',
  JSON.stringify(visible.data));

// --- Bug 2: the session survives a reload ----------------------------------
check('a session was written to storage',
  strangerStore.store.has('sound-garden-auth'),
  [...strangerStore.store.keys()].join(','));

// A "reload": a brand new client reading the same storage, with no network.
const reloaded = client(strangerStore.adapter);
const restored = await reloaded.auth.getSession();
check('getSession restores the user after a reload',
  Boolean(restored.data.session?.user),
  restored.error?.message ?? (restored.data.session ? 'restored' : 'no session found'));
check('the restored user is the same account',
  Boolean(strangerId) && restored.data.session?.user?.id === strangerId,
  `${restored.data.session?.user?.id} vs ${strangerId}`);
check('the display name survives the reload',
  restored.data.session?.user?.user_metadata?.display_name === 'Ben R',
  JSON.stringify(restored.data.session?.user?.user_metadata));

// And the restored session is actually usable.
const afterReload = await reloaded.from('ensembles').select('name');
check('the restored session can still read the group',
  afterReload.data?.length === 1, JSON.stringify(afterReload.error ?? afterReload.data));

// --- Cleanup ----------------------------------------------------------------
await stranger.rpc('leave_ensemble', { target: ensemble.id });
await dir.rpc('delete_ensemble', { target: ensemble.id });
for (const c of [dir, stranger, reloaded]) {
  try { await c.rpc('delete_my_data'); } catch { /* best effort */ }
}
const leftover = await dir.from('ensembles').select('id');
check('test data cleaned up', (leftover.data ?? []).length === 0,
  `${(leftover.data ?? []).length} left`);

console.log('PASS (' + ok.length + ')');
ok.forEach(o => console.log('  ✓ ' + o));
if (bad.length) { console.log('FAIL (' + bad.length + ')'); bad.forEach(x => console.log('  ✗ ' + x)); }
process.exit(bad.length ? 1 : 0);
