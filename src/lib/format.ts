/** Formatting + pagination + time helpers shared by API and dashboard. */

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatDate(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined || ms === "") return "—";
  const t = typeof ms === "number" ? ms : Date.parse(ms);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function daysUntil(ms: number, now = Date.now()): number {
  return Math.ceil((ms - now) / 86_400_000);
}

export type PageMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
};

export function pageMeta(page: number, pageSize: number, total: number): PageMeta {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    page,
    pageSize,
    total,
    totalPages,
    hasMore: page < totalPages,
  };
}

export type Paginated<T> = {
  data: T[];
  pagination: PageMeta;
};

/** Clamp/sanitize pagination params from arbitrary query input. */
export function normalizePage(page?: number | string, pageSize?: number | string) {
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const s = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 20)));
  return { page: p, pageSize: s, offset: (p - 1) * s };
}

export const nowMs = () => Date.now();

export const DAY_MS = 86_400_000;
