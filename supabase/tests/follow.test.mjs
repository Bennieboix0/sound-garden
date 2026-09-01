/**
 * Live page follow: the override rule, and channel authorization.
 *
 * Two halves:
 *
 *  1. The pedal-beats-the-network rule, tested against the real decision
 *     functions with the race run in both orders. This is the rule that
 *     matters most — a device that fights the person holding it is worse than
 *     one that is out of step.
 *  2. The Realtime channel policies, run against real Postgres. Broadcast
 *     authorization has to be enforced server-side, or a hand-crafted client
 *     could publish page turns to a school's rehearsal.
 *
 * Run with:  npm run test:follow
 */
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FOLLOW_PROTOCOL_VERSION,
  newGate,
  receive,
  resume,
  takeControl,
} from '../../dist-test/followGate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

const results = [];
const check = (name, passed, detail = '') => results.push({ name, passed, detail });

const HASH = 'a'.repeat(64);
const at = (seq, page) => ({
  v: FOLLOW_PROTOCOL_VERSION,
  contentHash: HASH,
  title: 'Prelude',
  seq,
  sentAt: 1000 + seq,
  page,
});

/** A device that applies decisions, so we can assert on where it ended up. */
class Device {
  constructor() {
    this.gate = newGate();
    this.page = 1;
    this.following = true;
  }
  inbound(position) {
    const decision = receive(this.gate, position);
    this.gate = decision.gate;
    if (decision.apply) this.page = decision.page;
    return decision;
  }
  localTurn(toPage) {
    // Exactly what the performance view does: move, then drop out. Both are
    // synchronous, so no message can interleave between them.
    this.page = toPage;
    this.gate = takeControl(this.gate);
    this.following = false;
  }
  resume() {
    this.gate = resume(this.gate);
    this.following = true;
  }
}

function overrideRuleTests() {
  // --- Ordinary following --------------------------------------------------
  {
    const d = new Device();
    d.inbound(at(1, 3));
    check('an inbound position moves the device', d.page === 3, `page ${d.page}`);
    d.inbound(at(2, 4));
    check('following keeps up with the director', d.page === 4, `page ${d.page}`);
  }

  // --- Race, direction A: the pedal lands first ----------------------------
  {
    const d = new Device();
    d.inbound(at(1, 3));
    d.localTurn(7);
    // The message was already in flight when the pedal was pressed.
    const decision = d.inbound(at(2, 4));
    check('a message already in flight cannot undo a pedal press',
      d.page === 7 && !decision.apply && decision.reason === 'released',
      `page ${d.page}, ${decision.reason ?? 'applied'}`);
    check('follow is off after a local turn', d.following === false);
  }

  // --- Race, direction B: the message lands first --------------------------
  {
    const d = new Device();
    d.inbound(at(1, 3));
    d.inbound(at(2, 9));
    d.localTurn(7);
    check('a pedal press after a follow jump still wins', d.page === 7, `page ${d.page}`);
    // And nothing that arrives afterwards may move it back.
    d.inbound(at(3, 12));
    check('later messages cannot reclaim a released device', d.page === 7, `page ${d.page}`);
  }

  // --- Every kind of local turn drops out ----------------------------------
  {
    for (const source of ['pedal', 'tap zone', 'toolbar button', 'keyboard']) {
      const d = new Device();
      d.inbound(at(1, 2));
      d.localTurn(5);
      d.inbound(at(2, 8));
      check(`a ${source} turn exits follow mode`, d.page === 5 && !d.following, `page ${d.page}`);
    }
  }

  // --- Sequence ordering ---------------------------------------------------
  {
    const d = new Device();
    d.inbound(at(5, 10));
    const stale = d.inbound(at(4, 2));
    check('an out-of-order message cannot jump the score backwards',
      d.page === 10 && stale.reason === 'stale', `page ${d.page}`);
    const duplicate = d.inbound(at(5, 99));
    check('a duplicate message is ignored', d.page === 10 && duplicate.reason === 'stale');
    d.inbound(at(6, 11));
    check('the next genuine message still applies', d.page === 11, `page ${d.page}`);
  }

  // --- Resuming ------------------------------------------------------------
  {
    const d = new Device();
    d.inbound(at(1, 2));
    d.localTurn(6);
    d.inbound(at(2, 7)); // seen but not applied
    d.resume();
    check('resuming does not retroactively apply what was missed', d.page === 6, `page ${d.page}`);
    d.inbound(at(3, 8));
    check('resuming rejoins from the next message', d.page === 8, `page ${d.page}`);
  }

  // --- Forward compatibility ----------------------------------------------
  {
    const d = new Device();
    d.inbound(at(1, 4));
    const future = d.inbound({
      v: FOLLOW_PROTOCOL_VERSION,
      contentHash: HASH,
      title: 'Prelude',
      seq: 2,
      sentAt: 2,
      mark: 'Letter C', // a coordinate this version cannot resolve
    });
    check('a coordinate this version cannot resolve holds the page still',
      d.page === 4 && future.reason === 'unresolvable', `page ${d.page}`);

    const wrongVersion = d.inbound({ ...at(3, 9), v: 99 });
    check('a message from an incompatible protocol is ignored',
      d.page === 4 && wrongVersion.reason === 'wrong-version', `page ${d.page}`);
  }
}

// ---------------------------------------------------------------------------
// Channel authorization
// ---------------------------------------------------------------------------

const REALTIME_SHIM = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub','')::uuid $$;
  do $$ begin if not exists (select from pg_roles where rolname='authenticated') then
    create role authenticated nologin; end if; end $$;

  -- Stand-in for Supabase's realtime.messages, which is what Realtime
  -- Authorization actually applies row level security to.
  create schema if not exists realtime;
  create table if not exists realtime.messages (
    id bigserial primary key,
    topic text not null,
    extension text not null,
    payload jsonb
  );
  -- Supabase ships realtime.messages with row level security already on, and
  -- the table owned by an internal role. The migration therefore only creates
  -- policies; enabling RLS is the platform's job, so the shim does it here.
  alter table realtime.messages enable row level security;
  -- Supabase exposes the current channel topic to policies through this.
  create or replace function realtime.topic() returns text language sql stable as $$
    select current_setting('realtime.topic', true)
  $$;
`;

async function authorizationTests() {
  const db = new PGlite();
  await db.exec(REALTIME_SHIM);
  for (const file of ['0001_personal_sync.sql', '0002_ensembles.sql', '0003_follow_channel.sql']) {
    await db.exec(await readFile(join(migrations, file), 'utf8'));
  }
  await db.exec(`
    grant usage on schema public, auth, realtime to authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant select, insert on realtime.messages to authenticated;
    grant usage on all sequences in schema realtime to authenticated;
    grant execute on all functions in schema public to authenticated;
    grant execute on function auth.uid() to authenticated;
    grant execute on function realtime.topic() to authenticated;
  `);

  const DIRECTOR = '11111111-1111-4111-8111-111111111111';
  const MEMBER = '22222222-2222-4222-8222-222222222222';
  const OUTSIDER = '33333333-3333-4333-8333-333333333333';
  await db.query(`insert into auth.users (id) values ($1),($2),($3)`, [DIRECTOR, MEMBER, OUTSIDER]);

  const asUser = async (userId, topic, sql, params = []) => {
    await db.exec('begin');
    try {
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ]);
      await db.query(`select set_config('realtime.topic', $1, true)`, [topic]);
      await db.exec(`set local role authenticated`);
      const out = await db.query(sql, params);
      await db.exec('commit');
      return out;
    } catch (err) {
      await db.exec('rollback');
      throw err;
    }
  };
  const refused = async (fn) => {
    try {
      await fn();
      return false;
    } catch {
      return true;
    }
  };

  const ensemble = (await asUser(DIRECTOR, '',
    `select id, join_code from public.create_ensemble('Orchestra','Ms Vaughan')`)).rows[0];
  // Join with the literal code. Reading it back inside the member's own
  // statement would return null — they cannot see the ensemble yet, which is
  // exactly the point of the code — and the join would silently do nothing.
  await asUser(MEMBER, '', `select public.join_ensemble($1, 'Ben R')`, [ensemble.join_code]);
  const membership = await db.query(
    `select count(*)::int as n from public.ensemble_members where user_id = $1`, [MEMBER]);
  check('the test fixture actually joined the member', membership.rows[0].n === 1,
    `${membership.rows[0].n} membership row(s)`);

  const topic = `ensemble:${ensemble.id}:follow`;
  const broadcast = (user) =>
    asUser(user, topic,
      `insert into realtime.messages (topic, extension, payload)
       values ($1, 'broadcast', '{"seq":1}'::jsonb)`, [topic]);

  await broadcast(DIRECTOR);
  check('a director can broadcast on their ensemble channel', true);

  check('a member cannot broadcast, even hand-crafting the message',
    await refused(() => broadcast(MEMBER)));
  check('an outsider cannot broadcast', await refused(() => broadcast(OUTSIDER)));

  const memberReads = await asUser(MEMBER, topic, `select id from realtime.messages`);
  check('a member can receive on their ensemble channel', memberReads.rows.length === 1,
    `${memberReads.rows.length} row(s)`);

  const outsiderReads = await asUser(OUTSIDER, topic, `select id from realtime.messages`);
  check('an outsider cannot receive on the channel', outsiderReads.rows.length === 0,
    `${outsiderReads.rows.length} row(s)`);

  // A director of one group must not be able to drive another group's channel.
  const other = (await asUser(OUTSIDER, '',
    `select id from public.create_ensemble('Jazz Band','Mr Ellis')`)).rows[0];
  check("a director cannot broadcast into another group's channel",
    await refused(() => asUser(DIRECTOR, `ensemble:${other.id}:follow`,
      `insert into realtime.messages (topic, extension, payload)
       values ($1, 'broadcast', '{}'::jsonb)`, [`ensemble:${other.id}:follow`])));

  // A malformed topic must not fall through to "allowed".
  check('a malformed topic is refused rather than defaulting open',
    await refused(() => asUser(DIRECTOR, 'ensemble:not-a-uuid:follow',
      `insert into realtime.messages (topic, extension, payload)
       values ('ensemble:not-a-uuid:follow', 'broadcast', '{}'::jsonb)`)));

  // Nothing about a member's own position is ever stored.
  const cols = (await db.query(`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public'`)).rows;
  check('no table records a member’s current page',
    !cols.some((c) => /current_page|last_page|position|viewing|seen_page/i.test(c.column_name)),
    cols.filter((c) => /page/i.test(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`).join(',') || 'none');

  await db.close();
}

async function main() {
  overrideRuleTests();
  await authorizationTests();

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
