/**
 * Static platform status notices served from `/status.json`.
 *
 * The owner-run workflow `.github/workflows/spa-status-notice.yml` writes that one
 * object (see scripts/status-notice.mjs). It is read by every visitor, signed in or
 * not, and keeps working when the API is down. Anything that is not a 200 JSON body
 * of the exact expected shape is treated as "no notice". Text is returned as plain
 * strings and must only ever be rendered as React text (never as HTML).
 *
 * Kept free of `@/` imports so node tests can load it directly.
 */

export type AnnouncementSeverity = "info" | "maintenance" | "critical";

export interface PlatformAnnouncement {
  id: string;
  title: string;
  message: string;
  severity: AnnouncementSeverity;
  scheduled_start: string | null;
  scheduled_end: string | null;
  refresh_instructions: string | null;
  is_active: boolean;
  starts_at: string;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export const STATUS_NOTICE_URL = "/status.json";
export const STATUS_NOTICE_LIMITS = Object.freeze({
  title: 120,
  message: 2000,
  refresh_instructions: 500,
  maxNotices: 10,
  maxBytes: 64 * 1024,
});
const SEVERITIES: readonly AnnouncementSeverity[] = ["info", "maintenance", "critical"];
const ALLOWED_KEYS = new Set([
  "id",
  "title",
  "message",
  "severity",
  "starts_at",
  "ends_at",
  "refresh_instructions",
  "updated_at",
]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
// C0/C1 control characters other than tab and newline are never valid notice text.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isIso = (v: unknown): v is string =>
  typeof v === "string" && ISO_TS_RE.test(v) && Number.isFinite(Date.parse(v));

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || t.length > max || CONTROL_RE.test(t)) return null;
  return t;
};

/** Validates one static notice; returns null for anything malformed. */
export function parseStatusNotice(raw: unknown): PlatformAnnouncement | null {
  if (!isPlainObject(raw)) return null;
  for (const key of Object.keys(raw)) if (!ALLOWED_KEYS.has(key)) return null;
  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) return null;
  const title = text(raw.title, STATUS_NOTICE_LIMITS.title);
  const message = text(raw.message, STATUS_NOTICE_LIMITS.message);
  if (!title || !message) return null;
  if (!SEVERITIES.includes(raw.severity as AnnouncementSeverity)) return null;
  if (!isIso(raw.updated_at)) return null;
  for (const key of ["starts_at", "ends_at"] as const) {
    if (raw[key] !== undefined && raw[key] !== null && !isIso(raw[key])) return null;
  }
  let refresh: string | null = null;
  if (raw.refresh_instructions !== undefined && raw.refresh_instructions !== null) {
    refresh = text(raw.refresh_instructions, STATUS_NOTICE_LIMITS.refresh_instructions);
    if (!refresh) return null;
  }
  const startsAt = (raw.starts_at as string | null | undefined) ?? null;
  const endsAt = (raw.ends_at as string | null | undefined) ?? null;
  if (startsAt && endsAt && !(Date.parse(endsAt) > Date.parse(startsAt))) return null;
  return {
    id: raw.id,
    title,
    message,
    severity: raw.severity as AnnouncementSeverity,
    scheduled_start: null,
    scheduled_end: null,
    refresh_instructions: refresh,
    is_active: true,
    starts_at: startsAt ?? raw.updated_at,
    ends_at: endsAt,
    created_at: raw.updated_at,
    updated_at: raw.updated_at,
  };
}

/** Parses the whole `/status.json` document. Bad shape means no notices. */
export function parseStatusDocument(doc: unknown): PlatformAnnouncement[] {
  if (!isPlainObject(doc) || !Array.isArray(doc.announcements)) return [];
  const out: PlatformAnnouncement[] = [];
  const seen = new Set<string>();
  for (const raw of doc.announcements.slice(0, STATUS_NOTICE_LIMITS.maxNotices)) {
    const notice = parseStatusNotice(raw);
    if (notice && !seen.has(notice.id)) {
      seen.add(notice.id);
      out.push(notice);
    }
  }
  return out;
}

/** True while `now` is inside the notice's starts_at/ends_at window. */
export function isAnnouncementLive(a: Pick<PlatformAnnouncement, "starts_at" | "ends_at">, now = Date.now()): boolean {
  if (a.starts_at && Date.parse(a.starts_at) > now) return false;
  if (a.ends_at && !(Date.parse(a.ends_at) > now)) return false;
  return true;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Fetches `/status.json` without caching. Any failure yields []. */
export async function fetchStatusNotices(
  fetchImpl: FetchLike | undefined = typeof fetch === "function" ? fetch : undefined,
  now = Date.now(),
): Promise<PlatformAnnouncement[]> {
  if (!fetchImpl) return [];
  try {
    const res = await fetchImpl(STATUS_NOTICE_URL, { cache: "no-store", credentials: "omit" });
    if (!res || res.status !== 200) return [];
    // CloudFront's SPA fallback answers a missing key with index.html; refuse non-JSON.
    const type = String(res.headers?.get?.("content-type") || "").toLowerCase();
    if (!type.startsWith("application/json")) return [];
    const body = await res.text();
    if (body.length > STATUS_NOTICE_LIMITS.maxBytes) return [];
    return parseStatusDocument(JSON.parse(body)).filter((a) => isAnnouncementLive(a, now));
  } catch {
    return [];
  }
}

/** Database rows first, then static notices whose id is not already present. */
export function mergeAnnouncements(
  dbRows: PlatformAnnouncement[] | null | undefined,
  staticNotices: PlatformAnnouncement[],
): PlatformAnnouncement[] {
  const out: PlatformAnnouncement[] = [];
  const seen = new Set<string>();
  for (const a of [...(dbRows ?? []), ...staticNotices]) {
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

/**
 * Combines the database query result with static notices. A failed or 401 database
 * read (signed-out visitors on AWS, or the API being down) falls back to the static
 * notices alone.
 */
export function combineAnnouncementSources(
  db: { data: unknown; error: unknown } | null,
  staticNotices: PlatformAnnouncement[],
  now = Date.now(),
): PlatformAnnouncement[] {
  if (!db || db.error || !Array.isArray(db.data)) return staticNotices;
  const rows = (db.data as PlatformAnnouncement[]).filter((a) => a && isAnnouncementLive(a, now));
  return mergeAnnouncements(rows, staticNotices);
}
