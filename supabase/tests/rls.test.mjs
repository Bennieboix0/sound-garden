/**
 * Row level security tests.
 *
 * Runs the real migration SQL against a real Postgres (PGlite, Postgres
 * compiled to WASM) rather than mocking the database, because RLS is exactly
 * the kind of thing a mock would happily get wrong. Supabase's `auth.uid()` is
 * reimplemented here with the same contract it has in production: read the
 * user id out of the request's JWT claims.
 *
 * Run with:  npm run test:rls
 */
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

const results = [];
const check = (name, passed, detail = '') =>
  results.push({ name, passed, detail });

/** Stands in for Supabase's auth schema. */
const AUTH_SHIM = `
  create schema if not exists auth;

  create table if not exists auth.users (
    id uuid primary key,
    email text
  );

  -- Same contract as Supabase: the user id comes from the request's JWT claims.
  create or replace function auth.uid() returns uuid
    language sql stable
  as $$
    select nullif(
      current_setting('request.jwt.claims', true)::json ->> 'sub',
      ''
    )::uuid
  $$;

  -- The role PostgREST runs queries as. RLS must apply to it, so it is
  -- deliberately not a superuser and not BYPASSRLS.
  do $$ begin
    if not exists (select from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
  end $$;
`;

async function migrate(db) {
  await db.exec(AUTH_SHIM);
  for (const file of ['0001_personal_sync.sql']) {
    await db.exec(await readFile(join(migrations, file), 'utf8'));
  }
  // Grant the API role table access; RLS then decides which rows it sees.
  await db.exec(`
    grant usage on schema public to authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant execute on all functions in schema public to authenticated;
    -- Supabase grants these itself. The shim has to do it explicitly, or
    -- auth.uid() is not callable from inside a security-invoker function.
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
  `);
}

/** Runs sql as a given user, exactly as PostgREST would. */
async function asUser(db, userId, sql, params = []) {
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    await db.exec(`set local role authenticated`);
    const out = await db.query(sql, params);
    await db.exec('commit');
    return out;
  } catch (err) {
    await db.exec('rollback');
    throw err;
  }
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function main() {
  const db = new PGlite();
  await migrate(db);

  await db.query(`insert into auth.users (id, email) values ($1,$2), ($3,$4)`, [
    ALICE, 'alice@example.test', BOB, 'bob@example.test',
  ]);

  // --- Each user writes their own data -------------------------------------
  await asUser(db, ALICE, `
    insert into public.strokes
      (id, user_id, content_hash, page_number, tool, color, width, points, created_at, updated_at)
    values ('33333333-3333-4333-8333-333333333333', $1, $2, 1, 'pen', '#d32020', 0.004,
            array[0.1,0.1,0.2,0.2]::double precision[], 1, 1)
  `, [ALICE, HASH_A]);

  await asUser(db, BOB, `
    insert into public.strokes
      (id, user_id, content_hash, page_number, tool, color, width, points, created_at, updated_at)
    values ('44444444-4444-4444-8444-444444444444', $1, $2, 1, 'pen', '#1668d8', 0.004,
            array[0.5,0.5,0.6,0.6]::double precision[], 1, 1)
  `, [BOB, HASH_B]);

  // --- A user sees only their own rows -------------------------------------
  const aliceSees = await asUser(db, ALICE, `select id, content_hash from public.strokes`);
  check('a user reads their own strokes', aliceSees.rows.length === 1,
    `${aliceSees.rows.length} row(s)`);
  check("a user cannot read another user's strokes",
    !aliceSees.rows.some((r) => r.content_hash === HASH_B),
    JSON.stringify(aliceSees.rows.map((r) => r.content_hash.slice(0, 6))));

  const bobSees = await asUser(db, BOB, `select id from public.strokes`);
  check('the isolation is symmetric', bobSees.rows.length === 1, `${bobSees.rows.length} row(s)`);

  // --- Forging user_id on insert is refused --------------------------------
  let forgedInsert = false;
  try {
    await asUser(db, ALICE, `
      insert into public.strokes
        (id, user_id, content_hash, page_number, tool, color, width, points, created_at, updated_at)
      values ('55555555-5555-4555-8555-555555555555', $1, $2, 1, 'pen', '#000', 0.004,
              array[0.1,0.1]::double precision[], 1, 1)
    `, [BOB, HASH_A]);
    forgedInsert = true;
  } catch {
    /* expected: the WITH CHECK clause rejects it */
  }
  check("a user cannot insert a row owned by someone else", !forgedInsert);

  // --- Updating and deleting someone else's row affects nothing ------------
  const stolenUpdate = await asUser(db, ALICE,
    `update public.strokes set color = '#000000' where content_hash = $1 returning id`, [HASH_B]);
  check("a user cannot update another user's stroke", stolenUpdate.rows.length === 0,
    `${stolenUpdate.rows.length} row(s) updated`);

  const stolenDelete = await asUser(db, ALICE,
    `delete from public.strokes where content_hash = $1 returning id`, [HASH_B]);
  check("a user cannot delete another user's stroke", stolenDelete.rows.length === 0,
    `${stolenDelete.rows.length} row(s) deleted`);

  const bobIntact = await asUser(db, BOB, `select color from public.strokes`);
  check("the other user's data is untouched",
    bobIntact.rows.length === 1 && bobIntact.rows[0].color === '#1668d8',
    JSON.stringify(bobIntact.rows));

  // --- Setlists and preferences are isolated the same way ------------------
  await asUser(db, ALICE, `
    insert into public.setlists (id, user_id, name, items, created_at, updated_at)
    values ('66666666-6666-4666-8666-666666666666', $1, 'Alice set', '[]'::jsonb, 1, 1)
  `, [ALICE]);
  const bobSetlists = await asUser(db, BOB, `select id from public.setlists`);
  check("a user cannot read another user's setlists", bobSetlists.rows.length === 0,
    `${bobSetlists.rows.length} row(s)`);

  await asUser(db, ALICE, `
    insert into public.score_prefs (user_id, content_hash, title, updated_at)
    values ($1, $2, 'Alice title', 1)
  `, [ALICE, HASH_A]);
  const bobPrefs = await asUser(db, BOB, `select content_hash from public.score_prefs`);
  check("a user cannot read another user's score preferences", bobPrefs.rows.length === 0,
    `${bobPrefs.rows.length} row(s)`);

  // --- The no-PDF constraint is structural ---------------------------------
  const cols = await db.query(`
    select table_name, column_name, data_type
    from information_schema.columns
    where table_schema = 'public'
  `);
  const suspicious = cols.rows.filter((c) =>
    /blob|bytea|file|pdf|binary|thumbnail|image|content_text|ocr/i.test(
      `${c.column_name} ${c.data_type}`,
    ),
  );
  check('no column anywhere could hold a file', suspicious.length === 0,
    JSON.stringify(suspicious));

  // A content hash is 64 hex characters; the provisional local ids the client
  // uses before backfill must be impossible to upload.
  let provisionalAccepted = false;
  try {
    await asUser(db, ALICE, `
      insert into public.strokes
        (id, user_id, content_hash, page_number, tool, color, width, points, created_at, updated_at)
      values ('77777777-7777-4777-8777-777777777777', $1, 'local:abc', 1, 'pen', '#000', 0.004,
              array[0.1,0.1]::double precision[], 1, 1)
    `, [ALICE]);
    provisionalAccepted = true;
  } catch {
    /* expected: the content_hash check constraint rejects it */
  }
  check('provisional local: hashes are rejected by the schema', !provisionalAccepted);

  // --- RLS is actually on, for every table ---------------------------------
  const rls = await db.query(`
    select relname, relrowsecurity from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'
  `);
  check('row level security is enabled on every table',
    rls.rows.length > 0 && rls.rows.every((r) => r.relrowsecurity === true),
    JSON.stringify(rls.rows));

  // --- Deleting your own data removes rows, not flags ----------------------
  await asUser(db, ALICE, `select public.delete_my_data()`);
  const aliceAfter = await asUser(db, ALICE,
    `select (select count(*) from public.strokes) as s,
            (select count(*) from public.setlists) as l,
            (select count(*) from public.score_prefs) as p`);
  const row = aliceAfter.rows[0];
  check('delete_my_data really removes the rows',
    Number(row.s) === 0 && Number(row.l) === 0 && Number(row.p) === 0,
    JSON.stringify(row));
  const bobStillThere = await asUser(db, BOB, `select count(*)::int as n from public.strokes`);
  check("one user's deletion leaves everyone else alone",
    bobStillThere.rows[0].n === 1, JSON.stringify(bobStillThere.rows[0]));

  await db.close();

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
