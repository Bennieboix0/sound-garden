/** Fractional insets, 0..1, measured from each edge of the PDF page box. */
export interface CropInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const NO_CROP: CropInsets = { left: 0, top: 0, right: 0, bottom: 0 };

export type FitMode = 'width' | 'page';

/**
 * Score metadata. The PDF bytes live in a separate table so that listing the
 * library never drags megabytes of blob through IndexedDB.
 */
export interface Score {
  id: string;
  /**
   * SHA-256 of the PDF bytes, lowercase hex. This is the identity a score has
   * across devices — the local `id` is meaningless anywhere else. Scores
   * imported before content addressing, or on a device where crypto.subtle is
   * unavailable, carry a provisional `local:<id>` value until backfilled; see
   * PROVISIONAL_HASH_PREFIX.
   */
  contentHash: string;
  title: string;
  artist: string;
  key: string;
  tempo: string;
  tags: string[];
  pageCount: number;
  dateAdded: number;
  fileName: string;
  fileSize: number;
  /** Per-score margin trim, applied in the performance view. */
  crop: CropInsets;
  /** Per-score overrides; fall back to the global defaults when undefined. */
  fitMode?: FitMode;
  spread?: boolean;
}

export interface ScoreFile {
  id: string;
  blob: Blob;
}

export interface Thumbnail {
  id: string;
  /** PNG data URL of page 1, long edge ~320px. */
  dataUrl: string;
}

export interface Setlist {
  id: string;
  name: string;
  scoreIds: string[];
  createdAt: number;
  updatedAt: number;
}

export type PedalAction = 'next' | 'prev';

export interface PedalBinding {
  /** KeyboardEvent.code — stable across layouts, which is what HID pedals emit. */
  code: string;
  /** KeyboardEvent.key, kept for display and as a fallback match. */
  key: string;
  action: PedalAction;
}

export interface Settings {
  id: 'settings';
  pedalBindings: PedalBinding[];
  /** Ignore a second page turn within this window. Stops one press turning two pages. */
  debounceMs: number;
  darkMode: boolean;
  /** Render scores white-on-black. Only sensible with darkMode on. */
  invertScores: boolean;
  pageAnimation: boolean;
  tapZones: boolean;
  defaultFitMode: FitMode;
  defaultSpread: boolean;
  /** Hold a screen wake lock while a score is open. */
  keepScreenAwake: boolean;
  /** Bumped when the bundled demo library changes, so seeding re-runs. */
  seedVersion: number;
}

export type LibraryLayout = 'grid' | 'list';

export type AnnotationTool = 'pen' | 'highlighter';

export interface Stroke {
  tool: AnnotationTool;
  /** CSS colour. Highlighter strokes are drawn with multiply blending. */
  color: string;
  /** Line width as a fraction of the page width, so it survives any zoom. */
  width: number;
  /**
   * Flat [x0, y0, x1, y1, …] in *uncropped* page space, 0–1. Storing against
   * the full page box means re-cropping a score never shifts its markings.
   */
  points: number[];
}

/**
 * Legacy shape: one row per page holding an array of strokes. Kept only so the
 * v3 migration can read it. Nothing writes this any more.
 */
export interface PageAnnotation {
  /** `${scoreId}:${pageNumber}` */
  id: string;
  scoreId: string;
  pageNumber: number;
  strokes: Stroke[];
  updatedAt: number;
}

/**
 * Which layer a stroke belongs to. Personal markings are private to their
 * author; the ensemble layer is published by a director and is read-only to
 * everyone else.
 */
export type StrokeLayer = 'personal' | 'ensemble';

/**
 * A stroke as an independently addressable record.
 *
 * Strokes are the unit of sync, not pages. They are small, immutable once
 * drawn, and never overlap in meaning, so last-write-wins per stroke id makes
 * genuine conflicts vanishingly rare — two people drawing on the same page at
 * once produces two strokes, not a contested one.
 */
export interface StrokeRecord extends Stroke {
  /** Client-generated uuid. Stable across devices. */
  id: string;
  /** Identifies the *document*, not the local score row. */
  contentHash: string;
  pageNumber: number;
  layer: StrokeLayer;
  /** Server user id once signed in; null for purely local markings. */
  authorId: string | null;
  createdAt: number;
  updatedAt: number;
  /**
   * Soft delete. Absent means live. A hard delete would be undone the moment
   * another device re-synced the row it still has, so deletions have to travel
   * as data. Purged locally after TOMBSTONE_TTL_MS.
   *
   * Stored as absent-or-number rather than null because IndexedDB cannot index
   * null: the `deletedAt` index therefore contains exactly the dead rows, which
   * is what the purge wants to scan.
   */
  deletedAt?: number;
}

/** What a queued change refers to. */
export type SyncEntity = 'stroke' | 'setlist' | 'scorePrefs';

/**
 * A local change waiting to be pushed. Holds only a reference: the drain reads
 * the entity's current state, so repeated edits collapse into one entry and the
 * queue stays bounded by the number of distinct entities, not the edit count.
 */
export interface SyncQueueEntry {
  /** Auto-incremented by Dexie; the monotonic local sequence number. */
  seq?: number;
  entity: SyncEntity;
  entityId: string;
  queuedAt: number;
}

export function annotationId(scoreId: string, pageNumber: number): string {
  return `${scoreId}:${pageNumber}`;
}

/** How a scanned page is processed before it becomes a PDF. */
export type ScanMode = 'bw' | 'grey' | 'colour';

/** The four corners of a page in a photo, clockwise from top-left, 0–1. */
export interface Quad {
  topLeft: [number, number];
  topRight: [number, number];
  bottomRight: [number, number];
  bottomLeft: [number, number];
}
