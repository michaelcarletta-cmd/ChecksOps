/**
 * Reads what the Checks "Outstanding" tab lists (outstandingClaims.ts), website only: the company's
 * checks that are linked to a claim (page by page: the data API returns at most 500 rows a read),
 * then those claims and their settlements in id chunks. The same tables and columns the Claim Ledger
 * card reads; nothing is written.
 *
 * No "@/" imports: aws/tests load this file with --experimental-strip-types.
 */
import { fetchQueueList, type QueuePage } from "./mortgageOpsQueuePaging.ts";
import {
  buildOutstandingClaimRows,
  type OutstandingCheckInput,
  type OutstandingClaimInput,
  type OutstandingClaimRow,
  type OutstandingSettlementInput,
} from "./outstandingClaims.ts";

export const OUTSTANDING_CHECK_COLUMNS = "id, claim_id, check_number, amount, carrier_name, issue_date, status, check_stage, created_at";
export const OUTSTANDING_CLAIM_COLUMNS = "id, claim_number, policyholder_name, policyholder_address";
/** React Query key of the Outstanding list (with the tenant id). */
export const OUTSTANDING_CLAIMS_QUERY_KEY = "outstanding-claims";
/** Claim ids per read of claims / claim_settlements. */
export const OUTSTANDING_ID_CHUNK = 50;
/** Chunk reads in flight at once. */
export const OUTSTANDING_CHUNK_CONCURRENCY = 4;

/** The part of the Supabase client this loader uses. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Supabase query builder
export type OutstandingClient = { from: (table: string) => any };

export interface OutstandingClaimsResult {
  rows: OutstandingClaimRow[];
  /** True when the company has more linked checks than were loaded: balances may be overstated. */
  incomplete: boolean;
  checkCount: number;
  claimCount: number;
}

const chunksOf = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function readInChunks<T>(ids: string[], read: (chunk: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const chunks = chunksOf(ids, OUTSTANDING_ID_CHUNK);
  const rows: T[] = [];
  for (let i = 0; i < chunks.length; i += OUTSTANDING_CHUNK_CONCURRENCY) {
    const results = await Promise.all(chunks.slice(i, i + OUTSTANDING_CHUNK_CONCURRENCY).map((chunk) => read(chunk)));
    for (const result of results) {
      if (result.error) throw result.error;
      rows.push(...(result.data ?? []));
    }
  }
  return rows;
}

export async function loadOutstandingClaims(client: OutstandingClient, tenantId: string): Promise<OutstandingClaimsResult> {
  const checks = await fetchQueueList<OutstandingCheckInput>((from, to) => client
    .from("check_intake_items")
    .select(OUTSTANDING_CHECK_COLUMNS, { count: "exact" })
    .eq("tenant_id", tenantId)
    .not("claim_id", "is", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to) as PromiseLike<QueuePage<OutstandingCheckInput>>);
  if (checks.error) throw checks.error;

  const claimIds = [...new Set(checks.rows.map((check) => String(check.claim_id || "")).filter(Boolean))];
  const [claims, settlements] = await Promise.all([
    readInChunks<OutstandingClaimInput>(claimIds, (chunk) => client.from("claims").select(OUTSTANDING_CLAIM_COLUMNS).in("id", chunk)),
    readInChunks<OutstandingSettlementInput>(claimIds, (chunk) => client.from("claim_settlements").select("*").in("claim_id", chunk)),
  ]);
  return {
    rows: buildOutstandingClaimRows({ claims, settlements, checks: checks.rows }),
    incomplete: checks.incomplete,
    checkCount: checks.rows.length,
    claimCount: claimIds.length,
  };
}
