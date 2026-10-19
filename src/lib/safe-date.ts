/**
 * Safe date helpers: never throw on missing/invalid timestamps.
 * Production RTDB may contain legacy or corrupted records with missing
 * timestamps (undefined, null, empty string, invalid). Direct
 * `new Date(undefined).toISOString()` throws RangeError and surfaces as
 * INTERNAL ("An internal error occurred.") — these helpers prevent that.
 *
 * IMPORTANT: Do NOT silently substitute `Date.now()` for missing historical
 * timestamps — that would make corrupted old records appear as \"just now\",
 * misleading operators. Return `null` and let the caller / UI show \"—\".
 * Only explicitly generated timestamps (e.g. `generatedAt`) should use now.
 */

export function safeISOString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return null;
  }
  if (typeof value === "string" && value) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
    return null;
  }
  return null;
}

// Alias kept for backwards compatibility — identical to safeISOString now.
export const safeISOStringNullable = safeISOString;
