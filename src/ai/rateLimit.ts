/**
 * Rate-limit helpers (pure, no vscode dependency).
 *
 * The provider/HTTP boundary (see `ai/reasoners.ts`) detects HTTP 429 and
 * captures the raw `Retry-After` header; everything interpretive lives
 * here: parsing the header (delta-seconds or HTTP-date), the single
 * conservative fallback cooldown, and resolving "how long until Send comes
 * back". Rate-limit state is UI/request state — never learner state, never
 * persisted conversation data.
 */

/**
 * Conservative local cooldown used when the provider rate-limits without a
 * usable `Retry-After` header. Single place of definition; the sidebar
 * re-enables Send automatically when it expires.
 */
export const RATE_LIMIT_FALLBACK_COOLDOWN_MS = 60 * 1000;

/**
 * Parse a `Retry-After` header value into a millisecond delay.
 * Accepts delta-seconds (`"42"`) and HTTP-dates. Returns null when the
 * header is missing, blank, or unparseable — callers fall back safely.
 * A past HTTP-date means "already retryable" and yields 0 (no cooldown).
 */
export function parseRetryAfterDelayMs(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = value.trim();
  if (raw.length === 0) {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  // Numeric-looking but non-integer values ('-5', '4.5') are malformed, not
  // dates: IMF-fixdate/RFC850/asctime dates all start with a weekday name.
  if (/^-?\d/.test(raw)) {
    return null;
  }
  const atMs = Date.parse(raw);
  if (Number.isNaN(atMs)) {
    return null;
  }
  return Math.max(0, atMs - nowMs);
}

/**
 * Resolve the Send-disabled cooldown for a confirmed rate-limit outcome.
 * Honors a positive provider-supplied delay; anything else (missing,
 * malformed, non-positive) uses the conservative fallback. Never throws.
 */
export function resolveRateLimitCooldownMs(
  retryAfterMs: number | null | undefined,
): number {
  if (
    typeof retryAfterMs === 'number' &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    return Math.floor(retryAfterMs);
  }
  return RATE_LIMIT_FALLBACK_COOLDOWN_MS;
}
