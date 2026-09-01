import type { CropInsets, FitMode, StrokeLayer } from '../types';

/**
 * Wire shapes.
 *
 * These are the *complete* set of things that may cross the network. There is
 * deliberately no field here that could carry a PDF, a filename, a page image,
 * or text extracted from a score — see supabase/migrations/0001_personal_sync.sql
 * for why. If a change to this file seems to need one, the change is wrong.
 */

export interface WireStroke {
  id: string;
  contentHash: string;
  pageNumber: number;
  layer: StrokeLayer;
  tool: 'pen' | 'highlighter';
  color: string;
  width: number;
  points: number[];
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface WireSetlistItem {
  contentHash: string;
  /** The owner's own title, so a device without the file can name the gap. */
  title: string;
}

export interface WireSetlist {
  id: string;
  name: string;
  items: WireSetlistItem[];
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface WireScorePrefs {
  contentHash: string;
  title: string | null;
  artist: string | null;
  crop: CropInsets | null;
  fitMode: FitMode | null;
  spread: boolean | null;
  updatedAt: number;
}

export interface PullResult {
  strokes: WireStroke[];
  setlists: WireSetlist[];
  scorePrefs: WireScorePrefs[];
  /** Highest updatedAt seen, for the next incremental pull. */
  cursor: number;
}

export interface PushPayload {
  strokes: WireStroke[];
  setlists: WireSetlist[];
  scorePrefs: WireScorePrefs[];
}

export interface AuthUser {
  id: string;
  /**
   * Present for email sign-ups only. Never displayed to anyone else, and never
   * exposed to a director in Phase 2.
   */
  email: string | null;
  displayName: string;
}

/**
 * Everything the app is allowed to ask a server to do.
 *
 * The whole backend sits behind this interface so it can be replaced without
 * touching the app. Nothing outside src/sync/ imports a Supabase symbol.
 */
export interface SyncTransport {
  readonly name: string;

  currentUser(): Promise<AuthUser | null>;
  onAuthChange(listener: (user: AuthUser | null) => void): () => void;

  signUp(email: string, password: string, displayName: string): Promise<AuthUser>;
  signIn(email: string, password: string): Promise<AuthUser>;
  signOut(): Promise<void>;

  /** Everything changed at or after `since`. */
  pull(since: number): Promise<PullResult>;
  push(payload: PushPayload): Promise<void>;

  /** Everything the server holds about this user, for the export button. */
  exportMyData(): Promise<unknown>;
  /** Hard-deletes the user's content. Not a soft flag. */
  deleteMyData(): Promise<void>;
}
