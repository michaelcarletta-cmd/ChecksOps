/**
 * Funds Released is the population of tenant disbursement_splits with
 * status = settled. Check-stage totals (check_intake_items.check_stage =
 * funds_released) are a different population and must not drive this badge.
 */
export const FUNDS_RELEASED_STATUS = "settled";
export const FUNDS_RELEASED_PAGE_SIZE = 500;

export const FUNDS_RELEASED_SPLIT_SELECT = `
  id, amount, settled_at, recipient_name, method, external_check_number,
  stakeholder_accounts (nickname, custname),
  disbursement_batches (
    id, check_intake_item_id,
    check_intake_items:check_intake_item_id (
      check_number, carrier_name, property_address, funds_type, amount,
      claim_id, detected_claim_number, payee_line,
      claims:claim_id ( claim_number, policyholder_name )
    )
  )
`;

export type FundsReleasedPopulation<T = unknown> = {
  rows: T[];
  total: number;
};

export function fundsReleasedDisplayCount(input: {
  total: number;
  filteredLength: number;
  hasSearch: boolean;
}): number {
  return input.hasSearch ? input.filteredLength : input.total;
}

export type FundsReleasedQueryResult<T = unknown> = {
  data: T[] | null;
  error: { message?: string } | null;
  count?: number | null;
};

export type FundsReleasedTable = {
  select: (columns: string, options?: { count?: "exact"; head?: boolean }) => FundsReleasedTable;
  eq: (column: string, value: string) => FundsReleasedTable;
  order: (column: string, options?: { ascending: boolean }) => FundsReleasedTable;
  range: (from: number, to: number) => Promise<FundsReleasedQueryResult>;
  then: (
    onFulfilled?: (value: FundsReleasedQueryResult) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
};

export async function fetchFundsReleasedPopulation<T = unknown>(
  fromTable: () => FundsReleasedTable,
  tenantId: string,
  pageSize: number = FUNDS_RELEASED_PAGE_SIZE,
): Promise<FundsReleasedPopulation<T>> {
  const countResult = (await fromTable()
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", FUNDS_RELEASED_STATUS)) as FundsReleasedQueryResult;
  if (countResult.error) throw countResult.error;
  const total = Number(countResult.count ?? 0);

  const rows: T[] = [];
  if (total === 0) return { rows, total };

  for (let from = 0; from < total; from += pageSize) {
    const to = Math.min(from + pageSize - 1, total - 1);
    const page = await fromTable()
      .select(FUNDS_RELEASED_SPLIT_SELECT)
      .eq("tenant_id", tenantId)
      .eq("status", FUNDS_RELEASED_STATUS)
      .order("settled_at", { ascending: false })
      .range(from, to);
    if (page.error) throw page.error;
    rows.push(...((page.data ?? []) as T[]));
  }

  return { rows, total };
}
