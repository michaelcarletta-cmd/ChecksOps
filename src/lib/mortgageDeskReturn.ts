/**
 * Additive Mortgage Desk return-to-tenant attention helpers.
 *
 * Reuses existing check_messages rows. Does not change mortgage request
 * status, billing, claim/check/Loss Draft workflow fields, or RLS.
 *
 * Return attention is true only when:
 *   completed mortgage_handling_request
 *   + MORTGAGE_DESK_RETURN:<requestId> message
 *   + no MORTGAGE_DESK_RETURN_ACK:<requestId> message
 *
 * Opening a record is not an acknowledgement.
 */

export const MORTGAGE_DESK_RETURN_PREFIX = "MORTGAGE_DESK_RETURN:";
export const MORTGAGE_DESK_RETURN_ACK_PREFIX = "MORTGAGE_DESK_RETURN_ACK:";
export const MORTGAGE_DESK_RETURN_MESSAGE =
  "Mortgage Desk completed work on this check. Review the returned documents and continue processing.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MortgageDeskReturnRequest = {
  id: string;
  check_intake_item_id?: string | null;
  status: string;
  completed_at?: string | null;
};

export type MortgageDeskReturnMessage = {
  id?: string;
  check_id?: string | null;
  body: string;
  created_at?: string | null;
  is_deleted?: boolean | null;
};

export type MortgageDeskReturnState = {
  actionRequired: boolean;
  requestId: string | null;
  completedAt: string | null;
  returnedAt: string | null;
  unackedRequestIds: string[];
};

/**
 * The existing human-readable completion note posted to the tenant thread.
 * Unchanged wording (including notes); the return marker is posted in
 * addition to it, never instead of it.
 */
export function buildMortgageDeskCompletedMessage(
  mortgageCompany: string | null | undefined,
  notes: string | null | undefined,
): string {
  return `✅ ChecksOps Mortgage Desk completed work with ${mortgageCompany || "the mortgage company"}.${notes ? ` Notes: ${notes}` : ""}`;
}

/**
 * Whether the Mortgage Desk client posts the completed-work note and the
 * return marker itself after completing a request. On the AWS backend the
 * database does it (SQL 99 trigger, as the assigned agent; agents have no
 * check_messages write policy there). The Supabase backend keeps the
 * client-side posts.
 */
export function mortgageDeskCompletionPostedByClient(usesAwsBackend: boolean): boolean {
  return !usesAwsBackend;
}

export function buildReturnMessage(requestId: string): string {
  return `${MORTGAGE_DESK_RETURN_PREFIX}${requestId} ${MORTGAGE_DESK_RETURN_MESSAGE}`;
}

export function buildReturnAckMessage(requestId: string): string {
  return `${MORTGAGE_DESK_RETURN_ACK_PREFIX}${requestId}`;
}

export function returnMessageLookupPattern(requestId: string): string {
  return `${MORTGAGE_DESK_RETURN_PREFIX}${requestId}%`;
}

export function returnAckLookupPattern(requestId: string): string {
  return `${MORTGAGE_DESK_RETURN_ACK_PREFIX}${requestId}%`;
}

export function isReturnMessage(body: string | null | undefined): boolean {
  return typeof body === "string" && body.startsWith(MORTGAGE_DESK_RETURN_PREFIX);
}

export function isReturnAckMessage(body: string | null | undefined): boolean {
  return typeof body === "string" && body.startsWith(MORTGAGE_DESK_RETURN_ACK_PREFIX);
}

export function parsePrefixedRequestId(body: string | null | undefined, prefix: string): string | null {
  if (!body || !body.startsWith(prefix)) return null;
  const rest = body.slice(prefix.length).trim();
  const token = rest.split(/\s+/, 1)[0] || "";
  return UUID_RE.test(token) ? token : null;
}

export function parseReturnRequestId(body: string | null | undefined): string | null {
  return parsePrefixedRequestId(body, MORTGAGE_DESK_RETURN_PREFIX);
}

export function parseReturnAckRequestId(body: string | null | undefined): string | null {
  return parsePrefixedRequestId(body, MORTGAGE_DESK_RETURN_ACK_PREFIX);
}

export function displayCheckMessageBody(body: string | null | undefined): string {
  if (!body) return "";
  if (isReturnAckMessage(body)) return "Acknowledged Mortgage Desk return.";
  if (isReturnMessage(body)) {
    const requestId = parseReturnRequestId(body);
    if (requestId) {
      const remainder = body.slice(MORTGAGE_DESK_RETURN_PREFIX.length + requestId.length).trim();
      return remainder || MORTGAGE_DESK_RETURN_MESSAGE;
    }
    return MORTGAGE_DESK_RETURN_MESSAGE;
  }
  return body;
}

export function emptyMortgageDeskReturnState(): MortgageDeskReturnState {
  return {
    actionRequired: false,
    requestId: null,
    completedAt: null,
    returnedAt: null,
    unackedRequestIds: [],
  };
}

export function deriveMortgageDeskReturnState(
  requests: MortgageDeskReturnRequest[] | null | undefined,
  messages: MortgageDeskReturnMessage[] | null | undefined,
): MortgageDeskReturnState {
  const completed = (requests || []).filter((r) => r.status === "completed" && r.id);
  const liveMessages = (messages || []).filter((m) => !m.is_deleted && typeof m.body === "string");

  const returnByRequest = new Map<string, MortgageDeskReturnMessage>();
  const acked = new Set<string>();
  for (const message of liveMessages) {
    const ackId = parseReturnAckRequestId(message.body);
    if (ackId) {
      acked.add(ackId);
      continue;
    }
    const returnId = parseReturnRequestId(message.body);
    if (returnId && !returnByRequest.has(returnId)) {
      returnByRequest.set(returnId, message);
    }
  }

  const unacked = completed.filter((r) => returnByRequest.has(r.id) && !acked.has(r.id));
  unacked.sort((a, b) => {
    const aT = new Date(a.completed_at || returnByRequest.get(a.id)?.created_at || 0).getTime();
    const bT = new Date(b.completed_at || returnByRequest.get(b.id)?.created_at || 0).getTime();
    return bT - aT;
  });

  const latest = unacked[0] || null;
  const latestReturn = latest ? returnByRequest.get(latest.id) : null;
  const latestCompleted = completed
    .slice()
    .sort((a, b) => new Date(b.completed_at || 0).getTime() - new Date(a.completed_at || 0).getTime())[0];

  return {
    actionRequired: unacked.length > 0,
    requestId: latest?.id ?? latestCompleted?.id ?? null,
    completedAt: latest?.completed_at ?? latestCompleted?.completed_at ?? null,
    returnedAt: latestReturn?.created_at ?? latest?.completed_at ?? null,
    unackedRequestIds: unacked.map((r) => r.id),
  };
}

export function compareLossDraftReturnPriority(
  aRequired: boolean,
  bRequired: boolean,
): number {
  if (aRequired === bRequired) return 0;
  return aRequired ? -1 : 1;
}

type ReturnReadResult = PromiseLike<{
  data: Array<Record<string, unknown>> | null;
  error: { message?: string } | null;
}>;

/**
 * Minimal structural view of the data client (Supabase or the AWS adapter)
 * used to read return state, so tests can pass a fake client.
 */
export type MortgageDeskReturnReadChain = ReturnReadResult & {
  select: (columns: string) => MortgageDeskReturnReadChain;
  in: (column: string, values: string[]) => MortgageDeskReturnReadChain;
  eq: (column: string, value: unknown) => MortgageDeskReturnReadChain;
  like: (column: string, pattern: string) => MortgageDeskReturnReadChain;
  order: (column: string, options?: { ascending?: boolean }) => MortgageDeskReturnReadChain;
  range: (from: number, to: number) => MortgageDeskReturnReadChain;
};

export type MortgageDeskReturnReadClient = {
  from: (table: string) => { select: (columns: string) => MortgageDeskReturnReadChain };
};

/**
 * The data API applies LIMIT 200 when no limit is sent (and clamps to 500)
 * with no implicit ORDER BY. Return-state reads therefore chunk the check
 * ids, order by created_at, and page with explicit ranges until a short page
 * comes back, so a tenant with many returned checks never silently loses a
 * return row (hidden return) or an ack row (stale banner).
 */
export const MORTGAGE_DESK_RETURN_ID_CHUNK = 25;
export const MORTGAGE_DESK_RETURN_PAGE_SIZE = 200;
export const MORTGAGE_DESK_RETURN_MAX_PAGES = 50;

export function chunkMortgageDeskReturnIds(ids: string[], size: number = MORTGAGE_DESK_RETURN_ID_CHUNK): string[][] {
  const unique = [...new Set(ids.filter(Boolean))];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += size) chunks.push(unique.slice(i, i + size));
  return chunks;
}

export async function fetchAllMortgageDeskReturnPages(
  runPage: (from: number, to: number) => ReturnReadResult,
  pageSize: number = MORTGAGE_DESK_RETURN_PAGE_SIZE,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 0; page < MORTGAGE_DESK_RETURN_MAX_PAGES; page += 1) {
    const from = page * pageSize;
    const { data, error } = await runPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message || "mortgage_desk_return_load_failed");
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error("mortgage_desk_return_page_limit_exceeded");
}

function dedupeRowsById(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    if (row.id != null) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(row);
  }
  return out;
}

export async function loadMortgageDeskReturnStates(
  client: MortgageDeskReturnReadClient,
  checkIds: string[],
  options: { chunkSize?: number; pageSize?: number } = {},
): Promise<Record<string, MortgageDeskReturnState>> {
  const chunks = chunkMortgageDeskReturnIds(checkIds, options.chunkSize);
  const result: Record<string, MortgageDeskReturnState> = {};
  for (const chunk of chunks) for (const id of chunk) result[id] = emptyMortgageDeskReturnState();
  if (chunks.length === 0) return result;

  const [requestPages, messagePages] = await Promise.all([
    Promise.all(
      chunks.map((chunk) =>
        fetchAllMortgageDeskReturnPages(
          (from, to) =>
            client
              .from("mortgage_handling_requests")
              .select("id, check_intake_item_id, status, completed_at, created_at")
              .in("check_intake_item_id", chunk)
              .eq("status", "completed")
              .order("created_at", { ascending: true })
              .range(from, to),
          options.pageSize,
        ),
      ),
    ),
    Promise.all(
      chunks.map((chunk) =>
        fetchAllMortgageDeskReturnPages(
          (from, to) =>
            client
              .from("check_messages")
              .select("id, check_id, body, created_at, is_deleted")
              .in("check_id", chunk)
              .like("body", "MORTGAGE_DESK_RETURN%")
              .eq("is_deleted", false)
              .order("created_at", { ascending: true })
              .range(from, to),
          options.pageSize,
        ),
      ),
    ),
  ]);

  const requests = dedupeRowsById(requestPages.flat()) as unknown as MortgageDeskReturnRequest[];
  const messages = dedupeRowsById(messagePages.flat()) as unknown as MortgageDeskReturnMessage[];

  for (const checkId of Object.keys(result)) {
    result[checkId] = deriveMortgageDeskReturnState(
      requests.filter((r) => r.check_intake_item_id === checkId),
      messages.filter((m) => m.check_id === checkId),
    );
  }
  return result;
}

/**
 * Everything the Mortgage Desk wrote on a check thread, for the tenant's
 * "Returned from Mortgage Desk" view: messages sent by an agent assigned to one
 * of the check's Desk requests (updates, upload notices, mid-work notes, the
 * completed-work note), plus Desk-prefixed messages from any sender (the
 * Supabase-era client posts). The return marker and its acknowledgement are
 * bookkeeping, not notes, and are left out. Oldest first.
 */
export const MORTGAGE_DESK_MESSAGE_PREFIXES = [
  "✅ ChecksOps Mortgage Desk",
  "📝 ChecksOps Mortgage Desk note:",
  "📎 Mortgage Ops",
  "📄 Mortgage Ops",
  "🏷️ Mortgage Ops",
] as const;

export function selectMortgageDeskNotes<T extends MortgageDeskReturnMessage & { sender_id?: string | null }>(
  messages: T[] | null | undefined,
  agentIds: Array<string | null | undefined>,
): T[] {
  const agents = new Set(agentIds.filter(Boolean).map((id) => String(id).toLowerCase()));
  return (messages || [])
    .filter((m) => !m.is_deleted && typeof m.body === "string" && m.body.trim() !== "")
    .filter((m) => !isReturnMessage(m.body) && !isReturnAckMessage(m.body))
    .filter((m) => (
      (m.sender_id && agents.has(String(m.sender_id).toLowerCase()))
      || MORTGAGE_DESK_MESSAGE_PREFIXES.some((prefix) => m.body.startsWith(prefix))
    ))
    .slice()
    .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
}

/** DOM id of the tenant's returned-work section for a check (the banner's Review target). */
export function mortgageDeskReturnedWorkAnchorId(checkId: string): string {
  return `mortgage-desk-returned-work-${checkId}`;
}

/** Scroll the tenant's returned-work section into view (banner "Review Returned File"). */
export function scrollToMortgageDeskReturnedWork(checkId: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.getElementById(mortgageDeskReturnedWorkAnchorId(checkId));
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}
