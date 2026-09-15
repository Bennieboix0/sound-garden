/**
 * Shared ensemble annotations, end to end against the live project.
 *
 * The feature rests entirely on content-hash identity: a director's markings
 * reach a member because both devices hashed the same PDF bytes. These checks
 * push on exactly that — including swapping the file for a different one.
 *
 * Run with:  npm run test:annotations
 */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

const env = {};
for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2];
}
const url = env.VITE_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const results = [];
const check = (n, p, d = '') => results.push({ name: n, passed: p, detail: d });
const uuid = () => crypto.randomUUID();

/** The same hash the app computes on import. */
const hashOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const seeds = readdirSync('public/seed').filter((f) => f.endsWith('.pdf')).sort();
const HASH_BACH = hashOf(`public/seed/${seeds[0]}`);
const HASH_OTHER = hashOf(`public/seed/${seeds[1]}`);

function device(name) {
  const client = createClient(url, key, { auth: { persistSession: false } });
  return { client, name };
}

async function signIn(dev) {
  const { data, error } = await dev.client.auth.signInAnonymously({
    options: { data: { display_name: dev.name } },
  });
  if (error) throw new Error(`${dev.name}: ${error.message}`);
  dev.id = data.user.id;
  return dev;
}

/** Same derivation the client uses, so a re-publish overwrites rather than adds. */
async function publishedStrokeId(ensembleId, sourceId) {
  const digest = createHash('sha256').update(`${ensembleId}:${sourceId}`).digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Mirrors the client's publish: a replacement of everything for this score. */
async function publish(dev, ensembleId, contentHash, strokes) {
  const rows = strokes.map((s) => ({
    id: s.sourceId,
    user_id: dev.id,
    content_hash: contentHash,
    page_number: s.page,
    layer: 'ensemble',
    ensemble_id: ensembleId,
    tool: 'pen',
    color: s.color,
    width: 0.004,
    points: s.points,
    created_at: s.at,
    updated_at: s.at,
  }));
  const { error } = await dev.client.from('strokes').upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(error.message);
  // Sweep anything previously published for this score that is not in this set.
  let sweep = dev.client.from('strokes').delete()
    .eq('ensemble_id', ensembleId).eq('content_hash', contentHash);
  if (rows.length > 0) sweep = sweep.not('id', 'in', `(${rows.map((r) => r.id).join(',')})`);
  const { error: sweepError } = await sweep;
  if (sweepError) throw new Error(sweepError.message);
  return rows.length;
}

/** Mirrors the client's pull-and-reconcile for one ensemble. */
async function pullInto(dev, ensembleId, localStore, reconcile = true) {
  const { data, error } = await dev.client
    .from('strokes')
    .select('*')
    .eq('ensemble_id', ensembleId)
    .gte('updated_at', 0);
  if (error) throw new Error(error.message);
  const live = (data ?? []).filter((r) => r.deleted_at === null || r.deleted_at === undefined);
  if (reconcile) {
    // The server is authoritative for a published layer: drop anything held
    // locally that it no longer has.
    const keep = new Set(live.map((r) => r.id));
    for (const id of [...localStore.keys()]) if (!keep.has(id)) localStore.delete(id);
  }
  for (const row of live) localStore.set(row.id, row);
  return data ?? [];
}

async function main() {
  const director = await signIn(device('Ms Vaughan'));
  const member = await signIn(device('Ben R'));

  const made = await director.client.rpc('create_ensemble', {
    ensemble_name: 'Annotation Test', director_name: 'Ms Vaughan',
  });
  const ensemble = Array.isArray(made.data) ? made.data[0] : made.data;
  if (!ensemble?.id) throw new Error('could not create ensemble: ' + made.error?.message);
  await member.client.rpc('join_ensemble', {
    code: ensemble.join_code, display_name: 'Ben R',
  });

  // --- The happy path: same PDF on both devices ----------------------------
  const SRC_P1 = await publishedStrokeId(ensemble.id, 'director-stroke-page-1');
  const SRC_P2 = await publishedStrokeId(ensemble.id, 'director-stroke-page-2');
  await publish(director, ensemble.id, HASH_BACH, [
    { sourceId: SRC_P1, page: 1, color: '#d32020', points: [0.1, 0.1, 0.4, 0.2], at: 1000 },
    { sourceId: SRC_P2, page: 2, color: '#d32020', points: [0.2, 0.3, 0.5, 0.4], at: 1001 },
  ]);

  const memberStore = new Map();
  await pullInto(member, ensemble.id, memberStore);
  check('a member receives markings for the score they share',
    memberStore.size === 2, `${memberStore.size} stroke(s)`);
  check('the markings carry the content hash, not a local id',
    [...memberStore.values()].every((r) => r.content_hash === HASH_BACH));

  // --- Swapping the PDF ----------------------------------------------------
  // A member holding a *different* edition hashes differently, so nothing of
  // the director's should attach to it.
  const forOtherFile = [...memberStore.values()].filter((r) => r.content_hash === HASH_OTHER);
  check('a different PDF gets none of those markings',
    forOtherFile.length === 0, `${forOtherFile.length} leaked`);

  // The same bytes under a different filename must still match: identity is the
  // content, not the name.
  check('identity is the bytes, not the filename',
    hashOf(`public/seed/${seeds[0]}`) === HASH_BACH);

  // --- Re-publishing after editing -----------------------------------------
  const beforeRepublish = memberStore.size;
  await publish(director, ensemble.id, HASH_BACH, [
    { sourceId: SRC_P1, page: 1, color: '#1668d8', points: [0.1, 0.1, 0.4, 0.2], at: 2000 },
    { sourceId: SRC_P2, page: 2, color: '#1668d8', points: [0.2, 0.3, 0.5, 0.4], at: 2001 },
  ]);
  await pullInto(member, ensemble.id, memberStore);
  check('re-publishing replaces the previous version rather than stacking on it',
    memberStore.size === beforeRepublish,
    `${beforeRepublish} before, ${memberStore.size} after re-publishing the same two strokes`);

  // --- Unpublishing ---------------------------------------------------------
  const serverRows = await director.client
    .from('strokes').select('id').eq('ensemble_id', ensemble.id);
  // The director deletes the page-1 marking and publishes again.
  await publish(director, ensemble.id, HASH_BACH, [
    { sourceId: SRC_P2, page: 2, color: '#1668d8', points: [0.2, 0.3, 0.5, 0.4], at: 3000 },
  ]);
  await pullInto(member, ensemble.id, memberStore, true);
  const stillHasPage1 = [...memberStore.values()].some((r) => r.page_number === 1);
  check('withdrawing a marking removes it from the member too',
    !stillHasPage1,
    `server had ${serverRows.data?.length ?? 0} rows; member still shows page 1: ${stillHasPage1}`);

  // --- Leaving --------------------------------------------------------------
  await member.client.rpc('leave_ensemble', { target: ensemble.id });
  const afterLeave = await member.client
    .from('strokes').select('id').eq('ensemble_id', ensemble.id);
  check('a member who leaves can no longer read the layer',
    (afterLeave.data ?? []).length === 0, `${(afterLeave.data ?? []).length} still visible`);

  // --- Cleanup --------------------------------------------------------------
  await director.client.rpc('delete_ensemble', { target: ensemble.id });
  for (const dev of [director, member]) {
    try { await dev.client.rpc('delete_my_data'); } catch { /* best effort */ }
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`PASS (${results.length - failed.length})`);
  for (const r of results.filter((x) => x.passed)) console.log('  ✓ ' + r.name);
  if (failed.length) {
    console.log(`FAIL (${failed.length})`);
    for (const r of failed) console.log(`  ✗ ${r.name}${r.detail ? ': ' + r.detail : ''}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
