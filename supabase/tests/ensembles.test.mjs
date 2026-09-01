/**
 * Ensemble privacy tests.
 *
 * These are the checks that matter most in this project, because the users are
 * children and the boundaries are enforced by Postgres rather than by the UI.
 * Everything runs against real Postgres (PGlite) with the real migration SQL.
 *
 * Run with:  npm run test:ensembles
 */
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '..', 'migrations');

const results = [];
const check = (name, passed, detail = '') => results.push({ name, passed, detail });

const AUTH_SHIM = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text);
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub','')::uuid $$;
  do $$ begin if not exists (select from pg_roles where rolname='authenticated') then
    create role authenticated nologin; end if; end $$;
`;

async function migrate(db) {
  await db.exec(AUTH_SHIM);
  for (const file of ['0001_personal_sync.sql', '0002_ensembles.sql']) {
    await db.exec(await readFile(join(migrations, file), 'utf8'));
  }
  await db.exec(`
    grant usage on schema public to authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant execute on all functions in schema public to authenticated;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
  `);
}

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

/** Returns true if the statement was refused. */
async function refused(fn) {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const DIRECTOR = '11111111-1111-4111-8111-111111111111';
const STUDENT = '22222222-2222-4222-8222-222222222222';
const CLASSMATE = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const OTHER_DIRECTOR = '55555555-5555-4555-8555-555555555555';
const HASH = 'a'.repeat(64);

async function main() {
  const db = new PGlite();
  await migrate(db);
  await db.query(
    `insert into auth.users (id, email) values ($1,null),($2,null),($3,null),($4,null),($5,null)`,
    [DIRECTOR, STUDENT, CLASSMATE, OUTSIDER, OTHER_DIRECTOR],
  );

  // --- Setting up two separate groups --------------------------------------
  const orchestra = (await asUser(db, DIRECTOR,
    `select id, join_code from public.create_ensemble('School Orchestra','Ms Vaughan')`)).rows[0];
  const jazz = (await asUser(db, OTHER_DIRECTOR,
    `select id, join_code from public.create_ensemble('Jazz Band','Mr Ellis')`)).rows[0];

  check('a join code uses an unambiguous alphabet',
    /^[A-HJ-NP-Z2-9]{6}$/.test(orchestra.join_code), orchestra.join_code);

  await asUser(db, STUDENT, `select public.join_ensemble($1, 'Ben R')`, [orchestra.join_code]);
  await asUser(db, CLASSMATE, `select public.join_ensemble($1, 'Ada L')`, [orchestra.join_code]);

  const joined = await asUser(db, STUDENT, `select role from public.ensemble_members where user_id = $1`, [STUDENT]);
  check('joining with a code makes you a member, not a director',
    joined.rows.length === 1 && joined.rows[0].role === 'member', JSON.stringify(joined.rows));

  // --- Join codes must not be enumerable -----------------------------------
  const peek = await asUser(db, OUTSIDER, `select id, join_code from public.ensembles`);
  check('an outsider cannot list ensembles or harvest join codes',
    peek.rows.length === 0, `${peek.rows.length} row(s)`);

  const badCode = await asUser(db, OUTSIDER, `select public.join_ensemble('ZZZZZZ','Nobody') as id`);
  check('a wrong code returns nothing rather than confirming existence',
    badCode.rows[0].id === null, JSON.stringify(badCode.rows[0]));

  // --- The core requirement: no cross-ensemble reads ------------------------
  await asUser(db, OTHER_DIRECTOR, `
    insert into public.ensemble_setlists (id, ensemble_id, name, items, created_at, updated_at)
    values (gen_random_uuid(), $1, 'Jazz night', '[]'::jsonb, 1, 1)`, [jazz.id]);
  await asUser(db, DIRECTOR, `
    insert into public.ensemble_setlists (id, ensemble_id, name, items, created_at, updated_at)
    values (gen_random_uuid(), $1, 'Spring concert', '[]'::jsonb, 1, 1)`, [orchestra.id]);

  const studentSetlists = await asUser(db, STUDENT, `select name from public.ensemble_setlists`);
  check('a member sees only their own ensemble’s setlists',
    studentSetlists.rows.length === 1 && studentSetlists.rows[0].name === 'Spring concert',
    JSON.stringify(studentSetlists.rows));

  const studentEnsembles = await asUser(db, STUDENT, `select name from public.ensembles`);
  check('a member cannot see an ensemble they do not belong to',
    studentEnsembles.rows.length === 1 && studentEnsembles.rows[0].name === 'School Orchestra',
    JSON.stringify(studentEnsembles.rows));

  // --- The director publishes; the member receives but cannot edit ---------
  await asUser(db, DIRECTOR, `
    insert into public.strokes
      (id, user_id, content_hash, page_number, layer, ensemble_id, tool, color, width, points, created_at, updated_at)
    values (gen_random_uuid(), $1, $2, 1, 'ensemble', $3, 'pen', '#d32020', 0.004,
            array[0.1,0.1,0.2,0.2]::double precision[], 1, 1)`, [DIRECTOR, HASH, orchestra.id]);

  const studentSees = await asUser(db, STUDENT,
    `select layer, ensemble_id from public.strokes`);
  check('a member receives the ensemble layer',
    studentSees.rows.length === 1 && studentSees.rows[0].layer === 'ensemble');

  const memberPublish = await refused(() => asUser(db, STUDENT, `
    insert into public.strokes
      (id, user_id, content_hash, page_number, layer, ensemble_id, tool, color, width, points, created_at, updated_at)
    values (gen_random_uuid(), $1, $2, 1, 'ensemble', $3, 'pen', '#000', 0.004,
            array[0.1,0.1]::double precision[], 1, 1)`, [STUDENT, HASH, orchestra.id]));
  check('a member cannot publish into the ensemble layer', memberPublish);

  const memberEdit = await asUser(db, STUDENT,
    `update public.strokes set color = '#000000' where layer = 'ensemble' returning id`);
  check('a member cannot edit the ensemble layer', memberEdit.rows.length === 0,
    `${memberEdit.rows.length} row(s)`);

  const outsiderSees = await asUser(db, OUTSIDER, `select id from public.strokes`);
  check('an outsider sees no ensemble strokes at all', outsiderSees.rows.length === 0);

  // --- A director must never see a student's personal markings -------------
  await asUser(db, STUDENT, `
    insert into public.strokes
      (id, user_id, content_hash, page_number, layer, tool, color, width, points, created_at, updated_at)
    values (gen_random_uuid(), $1, $2, 2, 'personal', 'pen', '#12903f', 0.004,
            array[0.7,0.7,0.8,0.8]::double precision[], 5, 5)`, [STUDENT, HASH]);

  const directorSees = await asUser(db, DIRECTOR,
    `select layer, user_id from public.strokes order by layer`);
  check("a director cannot see a student's personal annotation layer",
    directorSees.rows.every((r) => !(r.layer === 'personal' && r.user_id === STUDENT)),
    JSON.stringify(directorSees.rows.map((r) => `${r.layer}/${r.user_id.slice(0, 4)}`)));

  // --- A stroke is personal or published, never ambiguous ------------------
  const mislabelled = await refused(() => asUser(db, DIRECTOR, `
    insert into public.strokes
      (id, user_id, content_hash, page_number, layer, ensemble_id, tool, color, width, points, created_at, updated_at)
    values (gen_random_uuid(), $1, $2, 1, 'personal', $3, 'pen', '#000', 0.004,
            array[0.1,0.1]::double precision[], 1, 1)`, [DIRECTOR, HASH, orchestra.id]));
  check('a personal stroke cannot carry an ensemble id', mislabelled);

  // --- Roster visibility ---------------------------------------------------
  const rosterAsDirector = await asUser(db, DIRECTOR,
    `select display_name from public.ensemble_members where ensemble_id = $1 order by display_name`, [orchestra.id]);
  check('a director sees the roster by display name only',
    rosterAsDirector.rows.length === 3, JSON.stringify(rosterAsDirector.rows.map((r) => r.display_name)));

  const rosterAsStudent = await asUser(db, STUDENT, `select display_name from public.ensemble_members`);
  check('a student cannot enumerate their classmates',
    rosterAsStudent.rows.length === 1 && rosterAsStudent.rows[0].display_name === 'Ben R',
    JSON.stringify(rosterAsStudent.rows.map((r) => r.display_name)));

  // The director's view carries no contact details or activity trail.
  const memberColumns = (await db.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='ensemble_members'`)).rows.map((r) => r.column_name);
  check('membership stores no email, device id or last-seen time',
    !memberColumns.some((c) => /email|phone|ip|device|last_seen|login|user_agent|dob|birth/i.test(c)),
    memberColumns.join(','));

  // --- Assignments are one-to-one, not a message board ---------------------
  await asUser(db, DIRECTOR, `
    insert into public.assignments (id, ensemble_id, member_id, title, notes, created_at, updated_at)
    values (gen_random_uuid(), $1, $2, 'Bars 40-56 slowly', 'Watch the shift.', 1, 1)`,
    [orchestra.id, STUDENT]);

  const classmateSees = await asUser(db, CLASSMATE, `select title from public.assignments`);
  check("a student cannot read another student's assignments",
    classmateSees.rows.length === 0, `${classmateSees.rows.length} row(s)`);

  const studentAssignments = await asUser(db, STUDENT, `select id, completed_at from public.assignments`);
  check('a student sees the assignment addressed to them', studentAssignments.rows.length === 1);

  const studentRewrite = await asUser(db, STUDENT,
    `update public.assignments set title = 'nope' returning id`);
  check('a student cannot rewrite an assignment', studentRewrite.rows.length === 0);

  await asUser(db, STUDENT, `select public.set_assignment_done($1, true)`,
    [studentAssignments.rows[0].id]);
  const doneNow = await asUser(db, STUDENT, `select completed_at from public.assignments`);
  check('a student can mark their own assignment done',
    doneNow.rows[0].completed_at !== null);

  const directorSeesStatus = await asUser(db, DIRECTOR,
    `select completed_at from public.assignments where member_id = $1`, [STUDENT]);
  check('the director sees assignment status', directorSeesStatus.rows[0].completed_at !== null);

  // There is no messaging surface anywhere in the schema.
  const tables = (await db.query(`
    select table_name from information_schema.tables where table_schema='public'`))
    .rows.map((r) => r.table_name);
  check('no chat or messaging table exists',
    !tables.some((t) => /message|chat|comment|dm|inbox|post/i.test(t)), tables.join(','));

  // --- Leaving and deleting really delete ----------------------------------
  await asUser(db, STUDENT, `select public.leave_ensemble($1)`, [orchestra.id]);
  const afterLeave = await db.query(`
    select (select count(*) from public.ensemble_members where user_id = $1) as m,
           (select count(*) from public.assignments where member_id = $1) as a`, [STUDENT]);
  check('leaving deletes the membership and the assignments outright',
    Number(afterLeave.rows[0].m) === 0 && Number(afterLeave.rows[0].a) === 0,
    JSON.stringify(afterLeave.rows[0]));

  const personalKept = await db.query(
    `select count(*)::int as n from public.strokes where user_id = $1 and layer = 'personal'`, [STUDENT]);
  check('leaving keeps the student’s own personal markings', personalKept.rows[0].n === 1);

  const notOwner = await refused(() =>
    asUser(db, STUDENT, `select public.delete_ensemble($1)`, [orchestra.id]));
  check('a non-owner cannot delete an ensemble', notOwner);

  await asUser(db, DIRECTOR, `select public.delete_ensemble($1)`, [orchestra.id]);
  const afterDelete = await db.query(`
    select (select count(*) from public.ensembles where id = $1) as e,
           (select count(*) from public.ensemble_members where ensemble_id = $1) as m,
           (select count(*) from public.ensemble_setlists where ensemble_id = $1) as s,
           (select count(*) from public.strokes where ensemble_id = $1) as k`, [orchestra.id]);
  check('deleting an ensemble removes every row belonging to it',
    Object.values(afterDelete.rows[0]).every((v) => Number(v) === 0),
    JSON.stringify(afterDelete.rows[0]));

  const jazzUntouched = await db.query(`select count(*)::int as n from public.ensembles`);
  check('deleting one ensemble leaves the other alone', jazzUntouched.rows[0].n === 1);

  // --- RLS on, everywhere --------------------------------------------------
  const rls = await db.query(`
    select relname, relrowsecurity from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r'`);
  check('row level security is enabled on every table',
    rls.rows.every((r) => r.relrowsecurity === true),
    rls.rows.filter((r) => !r.relrowsecurity).map((r) => r.relname).join(',') || 'all enabled');

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
