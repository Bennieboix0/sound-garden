/**
 * Content addressing for scores.
 *
 * A score's local row id is meaningless on any other device. Its *content* is
 * not: the same PDF imported on a phone and a laptop hashes identically, which
 * is what lets markings drawn on one appear on the other — without the file
 * itself ever being transmitted. The hash is the only thing about a PDF that
 * ever leaves the device.
 */

/**
 * Marks a score whose bytes have not been hashed yet. Applied by the v3
 * migration and replaced by `backfillContentHashes`. Provisional hashes are
 * device-local by construction and must never be sent to a server.
 */
export const PROVISIONAL_HASH_PREFIX = 'local:';

export function provisionalHash(scoreId: string): string {
  return `${PROVISIONAL_HASH_PREFIX}${scoreId}`;
}

export function isProvisionalHash(hash: string): boolean {
  return hash.startsWith(PROVISIONAL_HASH_PREFIX);
}

/** True when this browser can actually compute content hashes. */
export function canHash(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function';
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * SHA-256 of a blob's bytes, lowercase hex.
 *
 * Throws where Web Crypto is unavailable — notably outside a secure context,
 * which is the same restriction that hides the camera and the wake lock. The
 * caller keeps the provisional hash in that case and the app carries on
 * working locally.
 */
export async function sha256(blob: Blob): Promise<string> {
  if (!canHash()) throw new Error('Web Crypto is unavailable in this context');
  const buffer = await blob.arrayBuffer();
  return toHex(await crypto.subtle.digest('SHA-256', buffer));
}
