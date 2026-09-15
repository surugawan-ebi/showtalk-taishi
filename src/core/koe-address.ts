export const MAX_KOE_ID_LENGTH = 128;
export const MAX_KOE_CALL_NAME_LENGTH = 80;

/** Canonical comparison form for operator-facing Koe names and IDs. */
export function normalizeKoeAddress(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}
