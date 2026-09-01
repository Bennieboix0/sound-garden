/**
 * The decision layer for live page follow, as pure functions.
 *
 * All the rules that are easy to get subtly wrong live here rather than tangled
 * into a React effect: sequence ordering, and — the one that matters most —
 * that a local page turn beats an inbound message no matter which of the two
 * the network happens to deliver first.
 */

/** Bumped if the payload shape ever changes incompatibly. */
export const FOLLOW_PROTOCOL_VERSION = 1;

/**
 * Where the director is.
 *
 * Deliberately *state, not a delta*: a member joining halfway through a
 * rehearsal is correct from the next message onward, and a dropped message
 * self-corrects on the following one, with no resynchronisation protocol.
 *
 * `page` is today's coordinate. A later version can carry a rehearsal mark or a
 * bar number instead, so receivers resolve through `resolvePage` rather than
 * reading `page` directly — nothing downstream assumes pages are the only way
 * to name a place in a score.
 */
export interface FollowPosition {
  v: number;
  contentHash: string;
  /** The director's own title for the score, so a member without the file can still be told what it is. */
  title: string;
  /** Monotonic per session. Receivers discard anything not newer. */
  seq: number;
  sentAt: number;
  page?: number;
  /** Reserved for a future protocol version; ignored by this one. */
  mark?: string;
  bar?: number;
}

export function isFollowPosition(value: unknown): value is FollowPosition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<FollowPosition>;
  return (
    typeof candidate.v === 'number' &&
    typeof candidate.contentHash === 'string' &&
    typeof candidate.seq === 'number' &&
    typeof candidate.title === 'string'
  );
}

/**
 * Turns a position into a page number for this client, or null if it names a
 * place this version cannot resolve. Future coordinates degrade to "ignored"
 * rather than to a wrong page.
 */
export function resolvePage(position: FollowPosition): number | null {
  if (typeof position.page === 'number' && Number.isFinite(position.page) && position.page >= 1) {
    return Math.floor(position.page);
  }
  // A newer director sending only a rehearsal mark: we cannot place it, so we
  // hold still rather than guess.
  return null;
}

export interface FollowGate {
  /** Highest sequence number already applied. */
  lastSeq: number;
  /** True once the musician has taken manual control. */
  released: boolean;
}

export function newGate(): FollowGate {
  return { lastSeq: 0, released: false };
}

export type GateDecision =
  | { apply: true; page: number; gate: FollowGate }
  | { apply: false; reason: 'released' | 'stale' | 'unresolvable' | 'wrong-version'; gate: FollowGate };

/**
 * Decides whether an inbound position should move this device.
 *
 * The ordering rule is the point of this function. Once `released` is set, no
 * message moves the score again until the musician explicitly resumes —
 * including messages that were already in flight when they pressed the pedal.
 * That is what makes the race safe in both directions: a press before the
 * message is rejected here, and a press after the message has already been
 * applied leaves the device on the locally chosen page because nothing further
 * arrives to overwrite it.
 */
export function receive(gate: FollowGate, position: FollowPosition): GateDecision {
  if (position.v !== FOLLOW_PROTOCOL_VERSION) {
    return { apply: false, reason: 'wrong-version', gate };
  }
  if (gate.released) {
    // Still note the sequence, so resuming does not replay old messages.
    const advanced = position.seq > gate.lastSeq ? { ...gate, lastSeq: position.seq } : gate;
    return { apply: false, reason: 'released', gate: advanced };
  }
  if (position.seq <= gate.lastSeq) {
    // Out-of-order or duplicate delivery must never walk the score backwards.
    return { apply: false, reason: 'stale', gate };
  }

  const page = resolvePage(position);
  if (page === null) {
    return { apply: false, reason: 'unresolvable', gate: { ...gate, lastSeq: position.seq } };
  }
  return { apply: true, page, gate: { ...gate, lastSeq: position.seq } };
}

/** A local page turn. Idempotent, and instant — there is nothing to await. */
export function takeControl(gate: FollowGate): FollowGate {
  return gate.released ? gate : { ...gate, released: true };
}

/** Re-arms following. The next message moves us, whatever its sequence. */
export function resume(gate: FollowGate): FollowGate {
  return { ...gate, released: false };
}

/**
 * Director-side sequence source. Monotonic within a session, so a receiver can
 * order messages without trusting clocks.
 */
export function nextSeq(previous: number): number {
  return previous + 1;
}
