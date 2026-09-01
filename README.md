# Sound Garden

A sheet music reader for working musicians. Local-first, offline, and driven by
a Bluetooth foot pedal. Imports PDFs, scans paper copies with the camera, and
lets you mark scores up without touching the original file.

The performance view is the product: full screen, nothing but the score, page
turns that happen the instant the pedal closes. Everything else — the library,
setlists, settings — exists to get you into that view with as little friction
as possible.

No accounts, no cloud, no backend. Every score lives in IndexedDB on the device
you imported it on.

---

## Quick start

Requires **Node 18.17+** (developed and tested on Node 22).

```bash
npm install
npm run dev          # http://localhost:5173
```

The library seeds itself on first run with three public-domain scores, so the
app demos immediately with no setup. See
[`public/seed/CREDITS.md`](public/seed/CREDITS.md).

```bash
npm run build        # typecheck + production bundle into dist/
npm run preview      # serve the built bundle
npm run typecheck    # tsc only
```

### Trying it without a pedal

Every default pedal binding is also a normal keyboard key, so you can drive the
whole thing from a laptop: **Page Down / Down / Right / Space** turn forward,
**Page Up / Up / Left** turn back, **Escape** exits the performance view.

---

## How to add a pedal mapping

Bluetooth page turners (AirTurn, PageFlip, Donner, iRig BlueTurn, Coda) pair as
HID **keyboards**. They do not have a pedal API — they just send key presses.
So mapping a pedal means learning which key it sends.

### As a user

1. Pair the pedal with the device in the OS Bluetooth settings.
2. Open **Settings → Foot pedal**.
3. Press **Press a pedal to map it**.
4. Stomp the pedal. The dialog shows the key it sent.
5. Choose **Next page** or **Previous page**.

The box above the mapping list is a live tester: while you are on the Settings
screen, mapped keys light it up instead of turning pages, so you can confirm
the pedal works before the gig rather than during it.

If a pedal sends a key that is already mapped, the new assignment replaces the
old one.

### As a developer

A binding is just:

```ts
interface PedalBinding {
  code: string;        // KeyboardEvent.code — the physical key
  key: string;         // KeyboardEvent.key — fallback + display
  action: 'next' | 'prev';
}
```

Bindings live in the `settings` record in IndexedDB. To change what ships out
of the box, edit `DEFAULT_SETTINGS.pedalBindings` in
[`src/db/db.ts`](src/db/db.ts):

```ts
pedalBindings: [
  { code: 'PageDown', key: 'PageDown', action: 'next' },
  { code: 'PageUp',   key: 'PageUp',   action: 'prev' },
  // …
],
```

Matching happens in `matchBinding` in [`src/hooks/usePedal.ts`](src/hooks/usePedal.ts).
It prefers `code` over `key`, because `code` is the physical key and stays
stable across keyboard layouts — which matters when a pedal reports itself as,
say, a French keyboard. `key` is only a fallback for the rare device that
reports no usable `code`.

Three details in `usePedal` that are load-bearing:

- **Capture phase.** The listener is registered with `capture: true` so a
  focused button can never swallow a pedal press.
- **`event.repeat` is dropped.** A pedal held down would otherwise machine-gun
  through the score.
- **The debounce is leading-edge.** The first press acts *immediately* and the
  window only suppresses what follows, so debouncing never adds latency to a
  turn. Some pedals bounce and send two events per stomp; the default 350 ms
  window (adjustable in Settings) absorbs that. This is the "one press never
  turns two pages" guarantee.

---

## Architecture

```
src/
  db/          Dexie schema, import, seeding, annotations, zip backup
  pdf/         pdf.js setup, render cache, margin detection
  scan/        camera, page detection, perspective warp, enhancement, PDF writer
  hooks/       pedal, idle UI, wake lock, element size
  state/       settings context, hash router
  components/
    library/       grid + list, search, tags, metadata
    performance/   the full-screen player, crop tool, annotation layer
    scan/          camera capture and corner adjustment
    setlists/      list, editor, drag reorder
    settings/      pedal mapping, display, backup
    ui/            buttons, modal, toggles
```

### Storage

Dexie over IndexedDB, six tables:

| Table | Holds |
| --- | --- |
| `scores` | Metadata: title, artist, key, tempo, tags, page count, crop, date added |
| `files` | The PDF blobs, keyed by score id |
| `thumbs` | First-page thumbnails as data URLs |
| `setlists` | Name + ordered array of score ids |
| `strokes` | One row per pen/highlighter stroke, keyed by content hash |
| `syncQueue` | Local changes waiting to be pushed |
| `settings` | The single settings record |

**PDF bytes are deliberately in their own table.** Listing the library reads
`scores` only, so browsing never drags megabytes of blob through IndexedDB.
Tags use a Dexie multi-entry index (`*tags`), which makes tag filtering cheap.

### Rendering, and why page turns are instant

This is the part that matters most, and it is in
[`src/pdf/render.ts`](src/pdf/render.ts) and
[`src/components/performance/PageSurface.tsx`](src/components/performance/PageSurface.tsx).

`PageRenderer` renders pages onto **detached canvas elements** and keeps them in
a small LRU cache keyed by score, page, fit mode, container size, crop and DPR.
A page turn is then not a render at all — it is a DOM insertion of a canvas
that was painted seconds ago:

1. `PageSurface` looks the requested pages up with `renderer.peek()` — a
   synchronous cache read.
2. On a hit it calls `replaceChildren(...)` inside a **layout effect**, so the
   new page is in the DOM before the browser paints the frame that handled the
   pedal press. There is no delay to perceive.
3. On a miss it keeps the current page on screen and swaps when the render
   resolves, rather than flashing empty. A spinner only appears after 250 ms,
   so an ordinary turn never shows one.

After every turn the view prefetches the next page, the previous page, and —
when you are near the end of a piece in a setlist — **the first page of the
next piece**. That last one is what makes a setlist transition cost no more
than an ordinary page turn.

Canvas backing stores are capped at 5 MP and the cache at 10 entries, so a long
setlist cannot exhaust memory on a phone. Evicted canvases are zeroed to free
their memory immediately, but never while still on screen.

### Cropping

Scanned scores waste enormous screen area on white border. A crop is stored per
score as **fractional insets** (`{left, top, right, bottom}`, each 0–1), so it
is resolution-independent and applies to every page.

Rendering a crop does not clip after the fact. The full-page viewport is
rendered with a translation so the crop's top-left lands at the canvas origin,
and the canvas is sized to the crop — the bounds do the cropping, and no pixels
are rendered that will not be shown:

```ts
const viewport = page.getViewport({ scale: deviceScale });
page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -offsetX, -offsetY] });
```

`detectCrop` in [`src/pdf/analyze.ts`](src/pdf/analyze.ts) finds margins
automatically by rendering pages at ~420 px and scanning for rows and columns
containing ink. It samples the first, middle and last page and keeps the
**smallest** inset on each edge, so a page with wider content never gets
clipped. This runs on import, which is why a scanned score looks right the
first time you open it, and it is always reversible from the crop tool's
**Reset**.

### The performance view

- **Chrome is overlaid, never inlaid.** Showing and hiding the toolbar changes
  opacity only. It never resizes the score container, so it never invalidates
  the render cache or triggers a re-render of the page.
- **Auto-hide ignores page turns.** `useIdleUI` treats mouse movement as
  activity but deliberately *not* pedal presses — the toolbar popping up over
  the score on every turn would be intolerable mid-song.
- **Touch is handled by tap zones, not pointer events**, because every tap
  emits a `pointermove` that would otherwise reveal the toolbar.
- **A screen wake lock is held** while a score is open, so the display never
  dims or sleeps mid-piece. Page turns come from a pedal, so the device can go
  many minutes with no input at all and the OS has no way to know anyone is
  looking at it. See below.
- Fit mode and single/spread are saved **per score**, not globally: a dense
  score wants fit-page, a sparse one fit-width. The Settings screen sets the
  default for scores you have not chosen for.

### Keeping the screen awake

[`src/hooks/useWakeLock.ts`](src/hooks/useWakeLock.ts) holds a
`navigator.wakeLock` screen lock for as long as a score is open, and releases it
on the way out. It is a setting (**Settings → Display → Keep the screen awake**,
on by default).

The lock is **re-acquired rather than assumed to persist**. The platform takes
it away whenever the tab stops being visible — switching apps, locking the
phone, sometimes just a notification — and never gives it back on its own. So
the hook listens both for `visibilitychange` and for the sentinel's own
`release` event, and takes a fresh lock each time it is dropped while the score
is still on screen.

Where it cannot work, Settings says so rather than failing silently:

| Situation | Behaviour |
| --- | --- |
| Chrome, Edge, Safari 16.4+, Firefox 126+ over https or localhost | Works |
| Any plain-http address, e.g. a phone pointed at a dev server on the LAN | The API is hidden entirely outside a secure context. Settings explains this and disables the toggle. |
| Older browsers with no Screen Wake Lock API | Same — named explicitly in Settings. |

There is deliberately **no silent-video fallback** for the last two rows. The
usual trick is to loop a tiny hidden video, which does keep some older devices
awake, but it depends on autoplay policy, costs bundle weight, and only helps
browsers that are years out of date. Saying plainly that the feature is
unavailable is more useful than a hack that may or may not fire. If you need it
on a phone during development, serve over https rather than plain http.

### Routing

A ~90-line hash router ([`src/state/router.ts`](src/state/router.ts)) rather
than a dependency. `#/library`, `#/setlists/:id`, `#/play/:scoreId/:page`,
`#/perform/:setlistId/:index`.

While playing, the current page is written back with `silentReplace`, which
calls `history.replaceState` **without** notifying React. A reload resumes on
the page you were on, and no page turn costs a re-render of the router.

### Offline

`vite-plugin-pwa` (Workbox) precaches the app shell, the seed PDFs and — easy
to miss — the pdf.js worker, which ships as `.mjs`. If `mjs` is absent from
`globPatterns` in [`vite.config.ts`](vite.config.ts) the app still loads
offline but no page will ever render.

Verified by cutting the network entirely and reloading: library intact, pages
render.

The service worker uses `registerType: 'autoUpdate'`, so a redeployed build is
picked up without user action.

---

## Scanning paper scores

**Library → Scan pages** photographs sheet music and turns it into a PDF, all
on the device.

The pipeline is in [`src/scan/`](src/scan/):

1. **Capture.** `useCamera` opens the rear camera at the highest resolution it
   will give. `getUserMedia` requires a secure context, so on plain HTTP over a
   LAN — a phone pointed at a dev server — it reports as unsupported and the
   **Import photos** button takes over. That input carries
   `capture="environment"`, which on a phone opens the camera app directly, so
   there is always a working path.
2. **Find the page** (`detect.ts`). Otsu-thresholds a downscaled frame, takes
   the largest bright connected region, and reads its four corners off the
   extremes of `x+y` and `x−y` — the standard trick for a rotated rectangle,
   and far less code than contour tracing. It refuses a result that is too
   small or too skewed to be a page rather than showing a nonsense quad, and
   falls back to a default rectangle for you to drag.
3. **Straighten it** (`warp.ts`). Solves an eight-unknown homography mapping
   the output rectangle *back* to the photo, then walks every destination pixel
   and samples the source bilinearly — inverse mapping, so no holes. The
   corners are pulled inwards half a percent first: pixels exactly on the page
   boundary blend paper with whatever it is lying on, and sampling them leaves
   a dark rim around every scan.
4. **Clean it up** (`enhance.ts`). Black-and-white mode uses a Bradley–Roth
   adaptive threshold over an integral image. This is the part that matters: a
   single global threshold is useless on a photograph, where any shadow or the
   natural falloff towards a corner turns half the sheet black. Comparing each
   pixel against its own neighbourhood means a shadow shifts the local mean
   with it. Greyscale and colour modes instead stretch the paper up to white
   using histogram percentiles.
5. **Write the PDF** (`pdf.ts`). Hand-rolled, about 150 lines. Black-and-white
   pages are packed to 1 bit per pixel and deflated with fflate (already a
   dependency) as a `FlateDecode` image — sheet music is line art, so this is
   both the smallest and the sharpest option, and a page lands at a few KB.
   Greyscale and colour go in as JPEG via `DCTDecode`. A PDF library was not
   worth several hundred kilobytes in a bundle that has to be precached for
   offline use.

Scanned pages skip the automatic margin trim on import: you already placed the
corners by hand, and a second automatic crop would only fight that decision.

## Annotation

**Annotate** in the performance toolbar turns the score into a drawing surface.
Pen or highlighter, four colours each, three widths, undo, and clear-page.

Design decisions worth knowing:

- **The PDF is never modified.** Strokes live in their own table and are drawn
  on a canvas above the page. Deleting all markings leaves the original file
  byte-for-byte as imported.
- **Coordinates are stored in uncropped page space, 0–1.** Not screen pixels,
  and not relative to the crop. That means re-cropping a score, switching
  between fit-width and fit-page, rotating the device, or opening the same
  score on a bigger screen all move the markings with the music instead of
  sliding them off it.
- **Stroke width is a fraction of the page width**, so a "medium" pen looks the
  same weight relative to the staves at any zoom.
- **Tap zones are suppressed while annotating** — a tap is a pen stroke there,
  not a page turn. The pedal still turns pages, so you can mark up a whole
  piece without leaving the mode.
- **Palm rejection**: once a stylus has been seen, touch input is ignored for
  drawing.
- Markings are visible while playing but only editable in annotate mode, so
  nothing gets scribbled on mid-performance.
- Inversion applies to the score canvas only, so a red pen stays red in dark
  mode rather than turning cyan.

## Sync foundations (Phase 0)

Nothing here talks to a network. This is the local groundwork that makes sync
possible at all, and it stands on its own: the app behaves identically with or
without an account.

### The PDF never leaves the device

**This is a hard constraint, not a preference.** Scores are frequently
copyrighted material that the user is licensed to hold but not to redistribute,
and pushing a file to a server is redistribution regardless of intent. So the
sync design has exactly one thing to say about a PDF: its **SHA-256 hash**.

That hash is what makes cross-device markings possible without the file. A
score's local row `id` is meaningless anywhere else, but the same PDF hashes
identically on a phone and a laptop, so annotations key to
`contentHash + pageNumber` and land in the right place on any device that
happens to hold the same document. A device that does *not* hold it stores the
markings anyway and shows them the moment a matching file is imported.

Nothing else about the file is transmitted — not the bytes, not the filename,
not page images, not extracted text.

### Content addressing

`Score.contentHash` is the SHA-256 of the PDF bytes, computed on import via
`crypto.subtle` ([`src/db/contentHash.ts`](src/db/contentHash.ts)).

Web Crypto is only available in a secure context, and hashing cannot happen
inside an IndexedDB upgrade (see below), so a score can temporarily carry a
provisional `local:<id>` hash instead. Provisional hashes are device-local by
construction and are never sent anywhere.

Two scores with identical bytes share a content hash and therefore share
markings. That is the intended behaviour — it is the same document — but it
does mean importing one PDF twice gives you one set of annotations, not two.

### Strokes are the unit of sync

Markings moved from one row per page holding an array, to **one row per
stroke**:

```ts
interface StrokeRecord extends Stroke {
  id: string;            // client-generated uuid, stable across devices
  contentHash: string;   // the document, not the local score row
  pageNumber: number;
  layer: 'personal' | 'ensemble';
  authorId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;    // tombstone; absent means live
}
```

Per-stroke identity is what makes conflict resolution trivial. Strokes are
small, immutable once drawn, and never contest each other — two people marking
the same bar at the same time produce two strokes, not a disputed one. So
last-write-wins on `updatedAt` per stroke id is sufficient, and no merge
algorithm is needed.

The 0–1 uncropped-page-space coordinates are unchanged. They were already
device-independent, which is exactly what cross-device sync needs.

### Deletes have to travel

Removing a row cannot express a deletion in a distributed system: the other
device still holds it and would push it straight back on its next sync. So
deletion sets `deletedAt` and the row stays. Tombstones are purged locally
after **90 days**, which is generous for a tablet left in a case over a school
holiday.

`deletedAt` is stored as *absent-or-number* rather than null, because
IndexedDB cannot index null. The `deletedAt` index therefore contains exactly
the dead rows, which is precisely what the purge needs to scan.

### Why the migration happens in two stages

The v3 Dexie upgrade restructures annotations and stamps every score with a
provisional hash. It deliberately does **not** compute real hashes, because
awaiting `crypto.subtle` inside an IndexedDB `versionchange` transaction lets
that transaction auto-close, aborting the migration part-way.

Real hashing therefore runs afterwards in
[`src/db/backfill.ts`](src/db/backfill.ts), on ordinary transactions where
awaiting is safe. It is idempotent, resumable, and commits each score together
with its own strokes, so an interrupted backfill simply continues next launch.

Verified against a hand-built v2 database: scores, PDFs, thumbnails, setlists,
tags and crops all survive; strokes migrate with their order, coordinates,
tool and width intact; markings whose score no longer exists are dropped rather
than orphaned; and the resulting hashes match `shasum -a 256` on the same
files.

### The sync queue

`syncQueue` records *references* to changed entities, never payloads — the
drain reads current state at push time. Repeated edits to one stroke therefore
collapse into a single entry, so the queue is bounded by the number of distinct
changed entities rather than by how much the user has drawn. The
auto-incremented `seq` is the monotonic local sequence number.

### Feature flag

`VITE_SYNC_ENABLED=false` compiles the whole feature out. With it off nothing
is queued, and the app is exactly what it was before: local, accountless, and
complete. See [`src/sync/flags.ts`](src/sync/flags.ts).

## Sync (Phase 1: personal devices)

Optional, off until you sign in, and additive: a user who never creates an
account loses nothing, and the first-run experience never mentions accounts at
all. Configuration lives in [`.env.example`](.env.example); with no credentials
set the Supabase client is not even included in the bundle.

### What the server may hold — and what it may never hold

The server stores **annotation strokes, setlist structure, per-score display
preferences, and content hashes**. That is the complete list.

It must **never** hold PDF bytes, filenames, page images, thumbnails, or text
extracted from a score. Scores are usually material the holder is licensed to
read but not to redistribute, and uploading one is redistribution whatever the
intent. This is a legal constraint, not a preference, so it is enforced
structurally rather than by care:

- No table in
  [`supabase/migrations/`](supabase/migrations/0001_personal_sync.sql) has a
  column that could carry a file — no `bytea`, no storage bucket, no blob.
- The wire types in [`src/sync/transport.ts`](src/sync/transport.ts) are the
  entire vocabulary of what can cross the network.
- A test asserts that no column and no wire field is file-shaped, so adding one
  fails the suite rather than shipping.

**A score is identified only by the SHA-256 of its bytes.** That hash is
one-way, is useless without the file, and is what lets markings drawn on a
phone land in the right place on a laptop that happens to hold the same
document.

### Conflict resolution

Last-write-wins on `updatedAt`, **per stroke id**. No merge algorithm, because
none is needed: strokes are small, immutable once drawn, and independent. Two
musicians marking the same bar produce two strokes, not one contested stroke.
The only real conflict is editing *the same stroke* on two offline devices,
which is rare and resolves to the later edit.

Deletions travel as tombstones. Removing a row cannot express a delete in a
distributed system — the peer still holds it and pushes it straight back — so
`deletedAt` is set instead and the row remains until purged after 90 days.

### When sync runs — and when it must not

Triggered on app foreground, on regaining network, five seconds after the last
annotation, and on demand from Settings.

**Never while the performance view is open.** A page turn is the one hard
real-time requirement in this app, and a network round trip contending with it
— for the main thread, for IndexedDB write locks, or simply by causing a
re-render — is not a trade worth making. `useSuspendSyncWhilePlaying` holds
sync off for the whole session and replays any trigger that arrived meanwhile
on the way out, so nothing is lost, only deferred. The sync indicator is
likewise absent from the performance view.

### Markings for scores you do not have

Because files never sync, a second device routinely receives annotations for a
document it has no copy of. Those are stored silently and appear the moment a
PDF with a matching hash is imported. The library says how many there are, so
the state is explicable rather than mysterious.

The same applies inside a setlist: entries the device cannot resolve are kept
with their title, ready to be shown greyed out.

### What does not sync

**Pedal bindings**, deliberately — they describe the physical pedal attached to
one device, not a preference of the user. Crop, fit mode and spread *do* sync:
they are properties of how a document reads, not of the hardware.

Thumbnails do not sync either; they are regenerated locally from the file.

### Testing without a Supabase project

Two suites, both offline (`npm test`):

- `npm run test:rls` runs the real migration SQL against real Postgres
  ([PGlite](https://pglite.dev), Postgres compiled to WASM) with a shim for
  Supabase's `auth.uid()`. It proves a user cannot read, update or delete
  another user's rows, that forging `user_id` on insert is refused, that RLS is
  enabled on every table, and that `delete_my_data` really removes rows.
  Mocking a database would have happily got all of this wrong.
- `npm run test:merge` simulates two devices and a server against the real
  merge functions: a stroke propagates, a delete propagates and is not
  resurrected, concurrent edits converge on the later write, stale rows are
  ignored, and provisional or ensemble strokes are never uploaded.

### Feature flag

`VITE_SYNC_ENABLED=false` removes sync at **build time**, not just at runtime.
Verified: with credentials configured the bundle is 985 kB and contains the
Supabase client; with the flag off it is 756 kB and contains no trace of it.

## Ensembles (Phase 2)

A director publishes markings and setlists to a group. Members receive them,
can never edit them, and keep their own markings private.

### This is used by children, so the schema is the privacy boundary

Every rule below is enforced by Postgres row level security in
[`supabase/migrations/0002_ensembles.sql`](supabase/migrations/0002_ensembles.sql),
not by the interface. A bug in the UI cannot leak anything the policies forbid.

- **A member is a display name.** Students sign in *anonymously* — the
  credential is a refresh token on the device — and pick a name. No email, no
  real name, no date of birth, no phone number, no photo, no bio.
- **There is no messaging table, and there will not be one.** Directors
  communicate through assignments, which are addressed to one person and are
  about a passage of music. A test asserts no chat-shaped table exists.
- **No analytics, telemetry, crash reporting or third-party SDKs.** None were
  added anywhere in this work.
- **A director cannot see a member's personal annotation layer**, email, IP,
  device identifier or login times. Membership rows carry a display name, a
  role and a join time, and a test asserts no column matching
  email/phone/ip/device/last-seen exists.
- **A student cannot enumerate their classmates.** Members see only their own
  membership row; directors see the roster. Nothing in the app needs more.
- **Leaving and deleting really delete.** No soft flags anywhere in the file.

### Why join codes are not readable

There is deliberately **no policy allowing an ensemble to be selected by its
join code**. If there were, anyone could grind codes against the table and walk
into a school's group. Joining goes through `join_ensemble()`, a
`SECURITY DEFINER` function that is the only path which reads a code, and which
returns *nothing* for a bad one rather than an error distinguishing "no such
group" — so it cannot be used as an oracle either.

Codes are six characters from an alphabet with no `0`/`O` or `1`/`I`/`L`,
because they get read aloud off a whiteboard. Directors can rotate a code at
any time.

### The design fix that came first

Phase 0 gave strokes `layer: 'personal' | 'ensemble'` and no more. That is not
enough, and it was worth fixing before building on it: a student in orchestra
*and* jazz band would have had both directors' markings collapsed into one
undifferentiated overlay, with no way to toggle them apart and no way to clean
up when they left one group.

Strokes now carry an `ensembleId`, so each published layer is independently
visible, independently toggleable, and removed exactly when its group is left.
A database constraint enforces that a stroke is either personal *or* published
to exactly one ensemble, never ambiguously both.

### How a published layer looks

A director's markings are drawn beneath a pale keyline, so they read instantly
as "not mine" from a metre away. Dimming or dashing them would have been easier
and worse — these are the markings the director actually wants followed, so
they cannot cost anything in legibility.

Personal markings always draw **on top** of published ones, so your own notes
are never buried under someone else's. Each group gets its own toggle in the
performance toolbar.

### Live page follow

`usePageFollow` subscribes a member's device to the director's current page over
Supabase Realtime. Two rules shape it:

- **The pedal always wins.** Any local page turn drops the device out of follow
  mode until the musician asks to rejoin. A reader who is lost needs to find
  their own place more than they need to agree with the director, and a device
  that fights the person holding it is worse than one that is briefly out of
  step.
- **A dropped connection is not an error.** It shows as "not following" and
  changes nothing else; manual turns work exactly as always.

This is the one part of sync allowed to run during the performance view,
because it is a fire-and-forget broadcast of two numbers rather than a data
sync. The send is never awaited: a director's own page turn cannot wait on a
socket.

## Backup

**Settings → Backup** exports the whole library as a zip: every PDF, all
metadata, thumbnails, setlists and settings.

```
manifest.json          scores, setlists, settings, thumbnails, annotations
scores/<id>.pdf        the original PDFs, stored uncompressed
```

Backup archives are v3. v1 and v2 archives still restore, but their markings
are dropped rather than guessed at: the old format keyed annotations to a local
score id, and re-keying them to a content hash is not possible without the
original file. Strokes restore by content hash, so a backup carries markings
for documents the target device does not have.

PDFs are already compressed, so they are stored at level 0 — re-deflating them
costs time for nothing. Zipping runs on fflate's worker so the UI stays
responsive.

Import offers **merge** (adds to what is there) or **replace all** (wipes first,
behind a confirmation). Restoring also brings the pedal mapping across, which is
the point when you are moving to a new device with the same pedal.

---

## Design notes

The brief was a musician at a stand under stage lighting, so:

- **No thin light-grey text anywhere.** Secondary text is `ink-600`/`ink-300`,
  which clears 4.5:1 on both themes. Placeholders too.
- **Controls are large.** 44 px minimum everywhere, 56 px in the performance
  view. Prev and Next are pinned to the outer edges of the toolbar and never
  wrap, so they stay where the hand expects them at any width.
- **Overlay bars are opaque**, not gradients fading to transparent. A gradient
  looks better over a dark score and becomes unreadable over a white one.
- **Inverted scores** are a straight CSS `invert(1)` on the canvas. Sheet music
  is line art, so inversion is exactly right and costs nothing at render time.
- Portrait A4 on a 13" external monitor is the reference layout. Fit-width
  fills the screen edge to edge with no padding, because staff size is the
  whole point.

---

## Out of scope

Cloud sync, accounts, audio playback, score following, MIDI, sharing and
in-app purchase are not built, and the data model does not anticipate them.

Camera scanning and annotation were out of scope for v1 and were added
afterwards at the owner's request.

## Known limits

- Backup builds the zip in memory. A library of many hundreds of scores may be
  slow on a low-memory phone.
- Two-page spread on a portrait screen is width-constrained by geometry and
  leaves vertical slack — it is meant for landscape displays. Single page is
  the default.
- Page turns during setlist playback assume the next score's first page; there
  is no per-score "start at page N" for a set.
- Page detection assumes a bright sheet on a darker surface. White paper on a
  white table will not be found automatically — the corners still get placed by
  hand.
- The perspective warp runs on the main thread, so a very large photo blocks
  the UI briefly behind a spinner. It has not needed a worker in practice.
- Annotations are stroke-based only: no text boxes, shapes, or erasing part of
  a stroke. Undo and clear-page are the editing tools.
- Keeping the screen awake needs a secure context. Over plain http the browser
  hides the API completely and there is no fallback.
