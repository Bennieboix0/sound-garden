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
| `annotations` | Pen and highlighter strokes, keyed `scoreId:pageNumber` |
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

## Backup

**Settings → Backup** exports the whole library as a zip: every PDF, all
metadata, thumbnails, setlists and settings.

```
manifest.json          scores, setlists, settings, thumbnails, annotations
scores/<id>.pdf        the original PDFs, stored uncompressed
```

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
