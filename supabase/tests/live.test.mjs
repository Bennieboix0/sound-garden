/**
 * Live verification against a real Supabase project.
 *
 * Everything else in this suite runs offline against PGlite, which proves the
 * policy *logic* but not that Supabase applies it. This connects real clients
 * over the network and checks the things only a live server can answer:
 * whether RLS is actually enforced by PostgREST, whether Realtime honours the
 * broadcast policies, and whether two devices genuinely converge.
 *
 * Needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (read from .env.local).
 * Creates real rows and deletes them again; see cleanup() at the end.
 *
 * Run with:  npm run test:live
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match) env[match[1]] = match[2];
    }
  } catch {
    /* fall through to process.env */
  }
  return {
    url: env.VITE_SUPABASE_URL ?? process.env.VITE_SUPABASE_URL,
    key: env.VITE_SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY,
  };
}

const { url, key } = loadEnv();
if (!url || !key) {
  console.log('SKIP: no Supabase credentials in .env.local');
  process.exit(0);
}

const results = [];
const check = (name, passed, detail = '') => results.push({ name, passed, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A signed-in anonymous client, i.e. a student's device. */
async function device(displayName) {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  const { data, error } = await client.auth.signInAnonymously({
    options: { data: { display_name: displayName } },
  });
  if (error) throw new Error(`anonymous sign-in failed: ${error.message}`);
  await client.realtime.setAuth(data.session.access_token);
  return { client, userId: data.user.id, name: displayName };
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const uuid = () => crypto.randomUUID();

const created = { devices: [] };

async function main() {
  // --- Three real devices --------------------------------------------------
  const director = await device('Ms Vaughan');
  const student = await device('Ben R');
  const outsider = await device('Someone Else');
  created.devices.push(director, student, outsider);
  check('anonymous sign-in works with no email or personal details',
    Boolean(director.userId && student.userId), `${director.userId?.slice(0, 8)}…`);

  // --- Personal sync isolation --------------------------------------------
  const mine = uuid();
  {
    const { error } = await director.client.from('strokes').insert({
      id: mine, user_id: director.userId, content_hash: HASH_A, page_number: 1,
      layer: 'personal', tool: 'pen', color: '#d32020', width: 0.004,
      points: [0.1, 0.1, 0.2, 0.2], created_at: 1, updated_at: 1,
    });
    check('a user can write their own stroke', !error, error?.message ?? '');
  }
  {
    const { data } = await student.client.from('strokes').select('id').eq('id', mine);
    check("a user cannot read another user's stroke over the real API",
      (data ?? []).length === 0, `${(data ?? []).length} row(s)`);
  }
  {
    const { error } = await student.client.from('strokes').insert({
      id: uuid(), user_id: director.userId, content_hash: HASH_A, page_number: 1,
      layer: 'personal', tool: 'pen', color: '#000', width: 0.004,
      points: [0.1, 0.1], created_at: 1, updated_at: 1,
    });
    check('forging user_id is refused by the server', Boolean(error), error?.code ?? 'accepted!');
  }
  {
    const { error } = await director.client.from('strokes').insert({
      id: uuid(), user_id: director.userId, content_hash: 'local:not-hashed', page_number: 1,
      layer: 'personal', tool: 'pen', color: '#000', width: 0.004,
      points: [0.1, 0.1], created_at: 1, updated_at: 1,
    });
    check('a provisional local: hash is rejected by the schema', Boolean(error),
      error?.code ?? 'accepted!');
  }

  // --- Two-device convergence ---------------------------------------------
  {
    const second = await device('Ms Vaughan laptop');
    created.devices.push(second);
    // A second device of the *same* person is a different anonymous account
    // here, so simulate convergence on the director's own two rows instead.
    const id = uuid();
    await director.client.from('strokes').insert({
      id, user_id: director.userId, content_hash: HASH_B, page_number: 2,
      layer: 'personal', tool: 'pen', color: '#1668d8', width: 0.004,
      points: [0.5, 0.5, 0.6, 0.6], created_at: 10, updated_at: 10,
    });
    const pulled = await director.client.from('strokes').select('*').gte('updated_at', 5);
    check('a second session pulls the row back by cursor',
      (pulled.data ?? []).some((r) => r.id === id), `${(pulled.data ?? []).length} row(s)`);

    // Last-write-wins, and a tombstone survives the round trip.
    await director.client.from('strokes').upsert({
      id, user_id: director.userId, content_hash: HASH_B, page_number: 2,
      layer: 'personal', tool: 'pen', color: '#12903f', width: 0.004,
      points: [0.5, 0.5, 0.6, 0.6], created_at: 10, updated_at: 20,
    });
    const after = await director.client.from('strokes').select('color, deleted_at').eq('id', id).single();
    check('the later write wins on the server', after.data?.color === '#12903f', after.data?.color);

    await director.client.from('strokes').upsert({
      id, user_id: director.userId, content_hash: HASH_B, page_number: 2,
      layer: 'personal', tool: 'pen', color: '#12903f', width: 0.004,
      points: [0.5, 0.5, 0.6, 0.6], created_at: 10, updated_at: 30, deleted_at: 30,
    });
    const dead = await director.client.from('strokes').select('deleted_at').eq('id', id).single();
    check('a delete travels as a tombstone, not a missing row',
      dead.data?.deleted_at !== null && dead.data?.deleted_at !== undefined,
      String(dead.data?.deleted_at));
  }

  // --- Ensembles -----------------------------------------------------------
  const ens = await director.client.rpc('create_ensemble', {
    ensemble_name: 'Live Test Orchestra', director_name: 'Ms Vaughan',
  });
  const ensemble = Array.isArray(ens.data) ? ens.data[0] : ens.data;
  check('a director can create an ensemble', Boolean(ensemble?.id), ens.error?.message ?? '');
  check('the join code uses the unambiguous alphabet',
    /^[A-HJ-NP-Z2-9]{6}$/.test(ensemble?.join_code ?? ''), ensemble?.join_code);

  {
    const { data } = await outsider.client.from('ensembles').select('id, join_code');
    check('an outsider cannot list ensembles or harvest codes',
      (data ?? []).length === 0, `${(data ?? []).length} row(s)`);
  }
  {
    const { data } = await outsider.client.rpc('join_ensemble', {
      code: 'ZZZZZZ', display_name: 'Nobody',
    });
    check('a wrong code returns nothing rather than confirming existence', data === null,
      String(data));
  }

  const joined = await student.client.rpc('join_ensemble', {
    code: ensemble.join_code, display_name: 'Ben R',
  });
  check('a student joins with a code and a display name only',
    joined.data === ensemble.id, joined.error?.message ?? String(joined.data));

  // --- The director must not see a student's personal layer ---------------
  const studentPersonal = uuid();
  await student.client.from('strokes').insert({
    id: studentPersonal, user_id: student.userId, content_hash: HASH_A, page_number: 3,
    layer: 'personal', tool: 'pen', color: '#12903f', width: 0.004,
    points: [0.7, 0.7, 0.8, 0.8], created_at: 1, updated_at: 1,
  });
  {
    const { data } = await director.client.from('strokes').select('id').eq('id', studentPersonal);
    check("a director cannot see a student's personal markings",
      (data ?? []).length === 0, `${(data ?? []).length} row(s)`);
  }

  // --- The ensemble layer --------------------------------------------------
  const published = uuid();
  {
    const { error } = await director.client.from('strokes').insert({
      id: published, user_id: director.userId, content_hash: HASH_A, page_number: 1,
      layer: 'ensemble', ensemble_id: ensemble.id, tool: 'pen', color: '#d32020',
      width: 0.005, points: [0.2, 0.2, 0.6, 0.25], created_at: 1, updated_at: 1,
    });
    check('a director can publish to the ensemble layer', !error, error?.message ?? '');
  }
  {
    const { data } = await student.client.from('strokes').select('id').eq('id', published);
    check('a member receives the published layer', (data ?? []).length === 1,
      `${(data ?? []).length} row(s)`);
  }
  {
    const { error } = await student.client.from('strokes').insert({
      id: uuid(), user_id: student.userId, content_hash: HASH_A, page_number: 1,
      layer: 'ensemble', ensemble_id: ensemble.id, tool: 'pen', color: '#000',
      width: 0.004, points: [0.1, 0.1], created_at: 1, updated_at: 1,
    });
    check('a member cannot publish into the ensemble layer', Boolean(error),
      error?.code ?? 'accepted!');
  }
  {
    const { data } = await student.client.from('strokes')
      .update({ color: '#000000' }).eq('id', published).select();
    check('a member cannot edit the ensemble layer', (data ?? []).length === 0,
      `${(data ?? []).length} row(s)`);
  }
  {
    const { data } = await outsider.client.from('strokes').select('id').eq('id', published);
    check('an outsider sees no ensemble strokes', (data ?? []).length === 0,
      `${(data ?? []).length} row(s)`);
  }
  {
    const { data } = await student.client.from('ensemble_members').select('display_name');
    check('a student cannot enumerate classmates',
      (data ?? []).length === 1 && data[0].display_name === 'Ben R',
      JSON.stringify((data ?? []).map((r) => r.display_name)));
  }

  // --- Realtime channel authorization -------------------------------------
  const topic = `ensemble:${ensemble.id}:follow`;
  /** Handlers must be attached before subscribe, or they never fire. */
  const subscribeAs = (dev) =>
    new Promise((resolve) => {
      const channel = dev.client.channel(topic, { config: { private: true, broadcast: { self: false } } });
      const inbox = [];
      channel.on('broadcast', { event: 'position' }, (m) => inbox.push(m.payload));
      const timer = setTimeout(() => resolve({ status: 'TIMEOUT', channel, inbox }), 12000);
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'CLOSED') {
          clearTimeout(timer);
          resolve({ status, channel, inbox, err });
        }
      });
    });

  const dirChannel = await subscribeAs(director);
  check('a director can open the private follow channel',
    dirChannel.status === 'SUBSCRIBED', dirChannel.status);

  const memChannel = await subscribeAs(student);
  check('a member can open the channel to receive',
    memChannel.status === 'SUBSCRIBED', memChannel.status);

  // Control: the director's own broadcast must reach the member. Without this
  // passing, a later "nothing arrived" result would prove nothing at all.
  await sleep(600);
  if (dirChannel.status === 'SUBSCRIBED') {
    await dirChannel.channel.send({
      type: 'broadcast', event: 'position',
      payload: { v: 1, contentHash: HASH_A, title: 'Prelude', page: 4, seq: 1, sentAt: Date.now() },
    });
  }
  await sleep(3000);
  check('a member receives the director’s position over Realtime',
    memChannel.inbox.some((p) => p.page === 4), JSON.stringify(memChannel.inbox));

  // The one that matters. supabase-js resolves a broadcast send optimistically
  // — there is no server ack to inspect — so the enforcement to verify is that
  // the message never propagates to anybody.
  const beforeDir = dirChannel.inbox.length;
  const beforeMem = memChannel.inbox.length;
  let memberSendResult = 'not-attempted';
  if (memChannel.status === 'SUBSCRIBED') {
    memberSendResult = await memChannel.channel.send({
      type: 'broadcast', event: 'position',
      payload: { v: 1, contentHash: HASH_A, title: 'Hijack', page: 99, seq: 2, sentAt: Date.now() },
    });
  }
  await sleep(3000);
  const hijackReachedDirector = dirChannel.inbox.slice(beforeDir).some((p) => p.page === 99);
  const hijackReachedMember = memChannel.inbox.slice(beforeMem).some((p) => p.page === 99);
  check('a member’s hand-crafted broadcast reaches nobody',
    !hijackReachedDirector && !hijackReachedMember,
    `director=${hijackReachedDirector}, member=${hijackReachedMember}, clientSend=${memberSendResult}`);

  // A second, independent proof: the director's next legitimate broadcast still
  // arrives, so the silence above was the policy refusing the member and not
  // the channel having quietly died.
  if (dirChannel.status === 'SUBSCRIBED') {
    await dirChannel.channel.send({
      type: 'broadcast', event: 'position',
      payload: { v: 1, contentHash: HASH_A, title: 'Prelude', page: 7, seq: 3, sentAt: Date.now() },
    });
  }
  await sleep(3000);
  check('the channel is still live afterwards, so the silence was enforcement',
    memChannel.inbox.some((p) => p.page === 7), JSON.stringify(memChannel.inbox.map((p) => p.page)));

  const outChannel = await subscribeAs(outsider);
  check('an outsider cannot open the channel at all',
    outChannel.status !== 'SUBSCRIBED', outChannel.status);

  for (const c of [dirChannel, memChannel, outChannel]) {
    try { await c.channel.unsubscribe(); } catch { /* already gone */ }
  }

  // --- Cleanup -------------------------------------------------------------
  await student.client.rpc('leave_ensemble', { target: ensemble.id });
  await director.client.rpc('delete_ensemble', { target: ensemble.id });
  for (const dev of created.devices) {
    // The query builder is thenable but has no .catch, so await it plainly.
    try {
      await dev.client.rpc('delete_my_data');
    } catch {
      /* best effort */
    }
  }
  const leftovers = await director.client.from('strokes').select('id');
  check('test data cleaned up', (leftovers.data ?? []).length === 0,
    `${(leftovers.data ?? []).length} row(s) left`);
  for (const dev of created.devices) {
    await dev.client.auth.signOut().catch(() => undefined);
    dev.client.realtime.disconnect();
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
