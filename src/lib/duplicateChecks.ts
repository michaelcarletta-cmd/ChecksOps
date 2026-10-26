/**
 * Duplicate check detection (owner, 2026-10-26): a check uploaded twice must be flagged before
 * anyone deposits it again.
 *
 * Two checks in the same tenant are duplicates when their check numbers match (ignoring spaces,
 * dashes and leading zeros) and their amounts are the same to the cent. When both carry a carrier
 * name and the names differ, they are different checks that happen to share a number.
 *
 * The flag is computed from the rows themselves, so it appears as soon as the check number and
 * amount are known (AI read or manual entry) and goes away when either is corrected or the other
 * check is deleted.
 *
 * Pure module (no "@/" imports) so aws/tests can import it directly.
 */

export type DuplicateCandidate = {
  id: string;
  check_number?: string | null;
  amount?: number | string | null;
  carrier_name?: string | null;
  status?: string | null;
  check_stage?: string | null;
  created_at?: string | null;
  deposited_at?: string | null;
};

/** "00-1234 5" and "123 45" compare equal; letters are kept, case-insensitive. */
export function normalizeCheckNumber(value: unknown): string {
  const compact = String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  return compact.replace(/^0+(?=.)/, "");
}

export function amountCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

const carrierKey = (value: unknown) =>
  String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");

export function isDuplicatePair(a: DuplicateCandidate, b: DuplicateCandidate): boolean {
  if (!a || !b || a.id === b.id) return false;
  const na = normalizeCheckNumber(a.check_number);
  if (!na || na !== normalizeCheckNumber(b.check_number)) return false;
  const ca = amountCents(a.amount);
  if (ca === null || ca !== amountCents(b.amount)) return false;
  const pa = carrierKey(a.carrier_name);
  const pb = carrierKey(b.carrier_name);
  return !(pa && pb && pa !== pb);
}

/** For every row that has a duplicate, the other rows it duplicates (oldest first). */
export function findDuplicateChecks<T extends DuplicateCandidate>(rows: T[]): Map<string, T[]> {
  const byNumber = new Map<string, T[]>();
  for (const row of rows || []) {
    const key = normalizeCheckNumber(row?.check_number);
    if (!key) continue;
    const list = byNumber.get(key);
    if (list) {
      if (!list.some((r) => r.id === row.id)) list.push(row);
    } else byNumber.set(key, [row]);
  }
  const out = new Map<string, T[]>();
  for (const group of byNumber.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      const others = group
        .filter((other) => isDuplicatePair(row, other))
        .sort((x, y) => String(x.created_at ?? "").localeCompare(String(y.created_at ?? "")));
      if (others.length) out.set(row.id, others);
    }
  }
  return out;
}

/**
 * Values to query with `.in("check_number", …)`: each number as stored plus its normalized form,
 * so "001234" on screen also finds a stored "1234". Formatting variants beyond that (dashes,
 * spaces) are caught once both rows are on screen together.
 */
export function checkNumberQueryValues(numbers: Array<string | null | undefined>): string[] {
  const values = new Set<string>();
  for (const n of numbers) {
    const raw = String(n ?? "").trim();
    if (!raw) continue;
    values.add(raw);
    const norm = normalizeCheckNumber(raw);
    if (norm) values.add(norm);
  }
  return [...values].sort();
}

/** One line for a flagged check: "Check #1234 · $5,000.00 · uploaded 10/26/2026 · Deposited". */
export function describeDuplicate(row: DuplicateCandidate): string {
  const cents = amountCents(row.amount);
  const money = cents === null
    ? ""
    : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const day = String(row.created_at ?? "").slice(0, 10);
  const [y, m, d] = day.split("-");
  const uploaded = y && m && d ? `uploaded ${m}/${d}/${y}` : "";
  const state = row.deposited_at ? "Deposited" : prettyState(row.check_stage || row.status);
  return [`Check #${row.check_number ?? "—"}`, money, uploaded, state].filter(Boolean).join(" · ");
}

function prettyState(value: unknown): string {
  const s = String(value ?? "").trim();
  if (!s) return "";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
