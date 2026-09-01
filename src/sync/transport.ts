import type {
  Assignment,
  CropInsets,
  Ensemble,
  EnsembleMember,
  FitMode,
  StrokeLayer,
} from '../types';

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
  /** Set only on published ensemble markings; absent on personal ones. */
  ensembleId?: string | null;
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

/** A director's current page, broadcast to whoever is following. */
export interface PagePosition {
  contentHash: string;
  pageNumber: number;
  /** Shown to members so they know which piece is being called. */
  title: string;
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

  // --- Ensembles -----------------------------------------------------------

  /**
   * Signs in with no identifying details at all — the credential is a token
   * held on the device. This is how a student joins: a display name and
   * nothing else.
   */
  signInAnonymously(displayName: string): Promise<AuthUser>;

  listEnsembles(): Promise<{ ensembles: Ensemble[]; members: EnsembleMember[] }>;
  createEnsemble(name: string, directorName: string): Promise<Ensemble>;
  /** Resolves to null for an unknown code, rather than confirming existence. */
  joinEnsemble(code: string, displayName: string): Promise<string | null>;
  rotateJoinCode(ensembleId: string): Promise<string>;
  leaveEnsemble(ensembleId: string): Promise<void>;
  deleteEnsemble(ensembleId: string): Promise<void>;

  publishEnsembleStrokes(ensembleId: string, strokes: WireStroke[]): Promise<void>;
  pullEnsembleStrokes(ensembleId: string, since: number): Promise<WireStroke[]>;

  listAssignments(): Promise<Assignment[]>;
  upsertAssignment(assignment: Assignment): Promise<void>;
  deleteAssignment(id: string): Promise<void>;
  setAssignmentDone(id: string, done: boolean): Promise<void>;

  // --- Live page follow ----------------------------------------------------

  /**
   * Fire-and-forget. Must never be awaited on a page-turn path: the director's
   * own turn cannot wait for a socket.
   */
  broadcastPage(ensembleId: string, position: PagePosition): void;
  /** Returns an unsubscribe function. */
  subscribeToPage(
    ensembleId: string,
    handler: (position: PagePosition) => void,
    onConnectionChange?: (connected: boolean) => void,
  ): () => void;
}
