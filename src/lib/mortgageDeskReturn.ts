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
