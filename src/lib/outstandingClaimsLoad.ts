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
  type OutstandingShareInput,
} from "./outstandingClaims.ts";

/** The claim-linked check columns, with the payee line and payees an insured name can come from (as the Checks lanes read them). */
export const OUTSTANDING_CHECK_COLUMNS = "id, claim_id, check_number, amount, carrier_name, issue_date, status, check_stage, created_at, payee_line, check_payees(payee_name, payee_type)";
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
  /** False when the partner shares or names could not be read: rows then list no partners. */
  partnersLoaded: boolean;
}

type ShareRow = OutstandingShareInput & { id: string };

/**
 * The partners this company's checks are actively shared with (shared_checks it is the source of, not revoked)
 * and their names (tenants_public). Best effort: a failed read leaves the list without partners, not broken.
 */
async function loadPartnerShares(client: OutstandingClient, tenantId: string): Promise<{ shares: ShareRow[]; partnerNames: Array<{ id: string; name?: string | null }>; ok: boolean }> {
  try {
    const shares = await fetchQueueList<ShareRow>((from, to) => client
      .from("shared_checks")
      .select("id, check_id, target_tenant_id", { count: "exact" })
      .eq("source_tenant_id", tenantId)
      .is("revoked_at", null)
      .order("id", { ascending: true })
      .range(from, to) as PromiseLike<QueuePage<ShareRow>>);
    if (shares.error) return { shares: [], partnerNames: [], ok: false };
    const partnerIds = [...new Set(shares.rows.map((share) => String(share.target_tenant_id || "")).filter(Boolean))];
    const partnerNames = await readInChunks<{ id: string; name?: string | null }>(partnerIds, (chunk) => client.from("tenants_public").select("id, name").in("id", chunk));
    return { shares: shares.rows, partnerNames, ok: !shares.incomplete };
  } catch {
    return { shares: [], partnerNames: [], ok: false };
  }
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

export async function loadOutstandingClaims(
  client: OutstandingClient,
  tenantId: string,
  opts: { insuredNameFromPayeeLine?: (payeeLine: string | null | undefined) => string | null } = {},
): Promise<OutstandingClaimsResult> {
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
  const [claims, settlements, partners] = await Promise.all([
    readInChunks<OutstandingClaimInput>(claimIds, (chunk) => client.from("claims").select(OUTSTANDING_CLAIM_COLUMNS).in("id", chunk)),
    readInChunks<OutstandingSettlementInput>(claimIds, (chunk) => client.from("claim_settlements").select("*").in("claim_id", chunk)),
    loadPartnerShares(client, tenantId),
  ]);
  return {
    rows: buildOutstandingClaimRows({
      claims, settlements, checks: checks.rows, insuredNameFromPayeeLine: opts.insuredNameFromPayeeLine,
      shares: partners.shares, partnerNames: partners.partnerNames,
    }),
    incomplete: checks.incomplete,
    checkCount: checks.rows.length,
    claimCount: claimIds.length,
    partnersLoaded: partners.ok,
  };
}
