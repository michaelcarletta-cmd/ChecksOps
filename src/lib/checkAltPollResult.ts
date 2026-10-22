/**
 * Plain-words summary of a Check Alt Poll Now answer
 * (the status refresh with an empty body).
 * The API returns one line per deposit; an unresolved line carries a
 * message that says why the status was left unchanged.
 */

export type CheckAltPollDeposit = {
  deposit_id?: string | null;
  checkalt_reference?: string | null;
  status?: string | null;
  previous_status?: string | null;
  reconciled?: boolean;
  message?: string | null;
};

export type CheckAltPollAnswer = {
  polled?: number;
  updated?: number;
  errors?: number;
  deposits?: CheckAltPollDeposit[];
};

const STATUS_WORDS: Record<string, string> = {
  pending_approval: "waiting in Check Alt",
  submitted: "approved, not yet deposited",
  cleared: "deposited",
  rejected: "rejected",
  returned: "returned",
};

const statusWords = (status: string | null | undefined): string =>
  (status && STATUS_WORDS[status]) || String(status || "unknown");

const refLabel = (row: CheckAltPollDeposit): string =>
  row.checkalt_reference ? `Ref ${row.checkalt_reference}` : "A deposit";

export function checkAltPollSummary(answer: CheckAltPollAnswer | null | undefined): {
  title: string;
  description: string;
} {
  const polled = Number(answer?.polled ?? 0);
  const deposits = Array.isArray(answer?.deposits) ? answer!.deposits! : [];
  if (polled === 0 && deposits.length === 0) {
    return { title: "Nothing to refresh", description: "No deposits are waiting on Check Alt." };
  }
  const lines: string[] = [];
  for (const row of deposits) {
    if (row.reconciled) {
      if (row.status && row.status !== row.previous_status) {
        lines.push(`${refLabel(row)}: now ${statusWords(row.status)}.`);
      } else {
        lines.push(`${refLabel(row)}: still ${statusWords(row.status)}.`);
      }
    } else {
      lines.push(`${refLabel(row)}: ${row.message || "Check Alt did not return a status. Left unchanged."}`);
    }
  }
  const changed = deposits.filter((row) => row.reconciled && row.status !== row.previous_status).length;
  const unresolved = deposits.filter((row) => !row.reconciled).length;
  const title = unresolved
    ? `Checked ${polled} deposit${polled === 1 ? "" : "s"}; ${unresolved} not resolved`
    : `Checked ${polled} deposit${polled === 1 ? "" : "s"}; ${changed} changed`;
  return { title, description: lines.join(" ") || `Checked ${polled}.` };
}

const ERROR_WORDS: Array<[RegExp, string]> = [
  [/checkalt_config_unreadable|checkalt_config_missing/i, "ChecksOps could not read its Check Alt settings, so nothing was checked."],
  [/production_secret_missing|production_host_refused/i, "The Check Alt connection is not configured on the server, so nothing was checked."],
  [/checkalt_status_reconcile_disabled/i, "Check Alt status refresh is turned off on the server."],
  [/provider_egress_failed|FunctionsHttpError/i, "ChecksOps could not reach Check Alt. Try again in a few minutes."],
  [/not_authenticated|session_expired/i, "Your session expired. Sign in again and retry."],
  [/financial_unauthorized|cross_tenant_denied/i, "You do not have permission to refresh these deposits."],
];

/** Plain words for a Poll Now failure code; unknown codes pass through. */
export function checkAltPollErrorText(message: string | null | undefined): string {
  const text = String(message || "");
  for (const [pattern, words] of ERROR_WORDS) {
    if (pattern.test(text)) return words;
  }
  return text || "Poll Now failed.";
}
