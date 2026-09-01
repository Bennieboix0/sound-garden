/**
 * Two-device sync simulation.
 *
 * Exercises the real merge rules from src/sync/engine.ts against two
 * independent local stores and an in-memory server, so the conflict behaviour
 * is proven without needing a Supabase project. What this covers is the part
 * that is actually easy to get wrong: last-write-wins ordering, tombstone
 * propagation, and the rules about what may be uploaded at all.
 *
 * Run with:  npm run test:merge
 */
import {
  mergeStrokes,
  pushableStrokes,
  strokeFromWire,
  isSyncableHash,
} from '../../dist-test/engine.mjs';

const results = [];
const check = (name, passed, detail = '') => results.push({ name, passed, detail });

const HASH = 'a'.repeat(64);
const stroke = (over = {}) => ({
  id: 'stroke-1',
  contentHash: HASH,
  pageNumber: 1,
  layer: 'personal',
  authorId: null,
  tool: 'pen',
  color: '#d32020',
  width: 0.004,
  points: [0.1, 0.1, 0.2, 0.2],
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

/** A device: a local store plus the cursor it has pulled up to. */
class Device {
  constructor(name) {
    this.name = name;
    this.rows = new Map();
    this.cursor = 0;
  }
  put(record) {
    this.rows.set(record.id, record);
  }
  get(id) {
    return this.rows.get(id);
  }
  live() {
    return [...this.rows.values()].filter((r) => r.deletedAt === undefined);
  }
  push(server) {
    for (const wire of pushableStrokes([...this.rows.values()])) server.upsert(wire);
  }
  pull(server) {
    const incoming = server.since(this.cursor);
    const { toWrite } = mergeStrokes(this.rows, incoming, null);
    for (const row of toWrite) this.put(row);
    this.cursor = server.cursor();
  }
}

class FakeServer {
  constructor() {
    this.rows = new Map();
  }
  upsert(wire) {
    const existing = this.rows.get(wire.id);
    // The server keeps the newer version, exactly as an upsert would.
    if (!existing || wire.updatedAt >= existing.updatedAt) this.rows.set(wire.id, wire);
  }
  since(cursor) {
    return [...this.rows.values()].filter((r) => r.updatedAt >= cursor);
  }
  cursor() {
    return Math.max(0, ...[...this.rows.values()].map((r) => r.updatedAt));
  }
}

// --- A drawn stroke reaches the other device --------------------------------
{
  const server = new FakeServer();
  const a = new Device('A');
  const b = new Device('B');
  a.put(stroke());
  a.push(server);
  b.pull(server);
  check('a stroke drawn on one device appears on the other',
    b.live().length === 1 && b.get('stroke-1').color === '#d32020');
  check('geometry survives the round trip',
    JSON.stringify(b.get('stroke-1').points) === '[0.1,0.1,0.2,0.2]');
}

// --- A delete propagates and is not resurrected -----------------------------
{
  const server = new FakeServer();
  const a = new Device('A');
  const b = new Device('B');
  a.put(stroke());
  a.push(server);
  b.pull(server);

  // B erases it.
  b.put({ ...b.get('stroke-1'), deletedAt: 2000, updatedAt: 2000 });
  b.push(server);
  a.pull(server);
  check('a delete on one device removes it on the other',
    a.live().length === 0 && a.get('stroke-1').deletedAt === 2000);

  // A, still holding the row, syncs again. A hard delete would reappear here.
  a.push(server);
  b.pull(server);
  check('the deleted stroke is not resurrected by the next sync',
    b.live().length === 0, JSON.stringify(b.live()));
}

// --- Concurrent edits resolve by updatedAt ----------------------------------
{
  const server = new FakeServer();
  const a = new Device('A');
  const b = new Device('B');
  a.put(stroke());
  a.push(server);
  b.pull(server);

  // Both devices edit the same stroke while offline; B's edit is later.
  a.put({ ...a.get('stroke-1'), color: '#111111', updatedAt: 3000 });
  b.put({ ...b.get('stroke-1'), color: '#12903f', updatedAt: 4000 });
  a.push(server);
  b.push(server);
  a.pull(server);
  b.pull(server);
  check('the later write wins on both devices',
    a.get('stroke-1').color === '#12903f' && b.get('stroke-1').color === '#12903f',
    `A=${a.get('stroke-1').color} B=${b.get('stroke-1').color}`);
  check('both devices converge to the same value',
    a.get('stroke-1').updatedAt === b.get('stroke-1').updatedAt);
}

// --- An older incoming row never overwrites a newer local one ---------------
{
  const local = new Map([['stroke-1', stroke({ color: '#111111', updatedAt: 5000 })]]);
  const { toWrite, summary } = mergeStrokes(local, [
    { ...stroke({ color: '#d32020', updatedAt: 4000 }), deletedAt: null },
  ], null);
  check('a stale remote row is ignored', toWrite.length === 0 && summary.skippedOlder === 1);
}

// --- What may leave the device ---------------------------------------------
{
  check('a real content hash is syncable', isSyncableHash(HASH));
  check('a provisional local: hash is not', !isSyncableHash('local:abc123'));
  check('a malformed hash is not', !isSyncableHash('nothex'));

  const mixed = [
    stroke({ id: 's1' }),
    stroke({ id: 's2', contentHash: 'local:not-hashed-yet' }),
    stroke({ id: 's3', layer: 'ensemble' }),
  ];
  const out = pushableStrokes(mixed);
  check('strokes on unhashed scores are never uploaded',
    !out.some((s) => s.id === 's2'), JSON.stringify(out.map((s) => s.id)));
  check("a member never pushes the director's ensemble layer back up",
    !out.some((s) => s.id === 's3'), JSON.stringify(out.map((s) => s.id)));
  check('ordinary personal strokes are uploaded', out.some((s) => s.id === 's1'));

  // The wire shape is the whole contract: nothing file-shaped may appear in it.
  const wire = out[0];
  const forbidden = Object.keys(wire).filter((k) =>
    /blob|file|pdf|bytes|data|thumb|image|text/i.test(k),
  );
  check('no field on the wire could carry a file', forbidden.length === 0,
    JSON.stringify(forbidden));
}

// --- Tombstones survive the wire's null/absent boundary ---------------------
{
  const live = strokeFromWire({ ...stroke(), deletedAt: null }, null);
  check('a live stroke has no deletedAt key at all',
    !Object.prototype.hasOwnProperty.call(live, 'deletedAt'));
  const dead = strokeFromWire({ ...stroke(), deletedAt: 9000 }, null);
  check('a tombstone keeps its timestamp', dead.deletedAt === 9000);
}

const failed = results.filter((r) => !r.passed);
console.log(`PASS (${results.length - failed.length})`);
for (const r of results.filter((x) => x.passed)) console.log('  ✓ ' + r.name);
if (failed.length) {
  console.log(`FAIL (${failed.length})`);
  for (const r of failed) console.log(`  ✗ ${r.name}${r.detail ? ': ' + r.detail : ''}`);
}
process.exit(failed.length ? 1 : 0);
