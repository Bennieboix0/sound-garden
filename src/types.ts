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

export interface PageAnnotation {
  /** `${scoreId}:${pageNumber}` */
  id: string;
  scoreId: string;
  pageNumber: number;
  strokes: Stroke[];
  updatedAt: number;
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
