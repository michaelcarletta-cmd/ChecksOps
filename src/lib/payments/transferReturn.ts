/**
 * How a bounced Moov transfer reads in the UI. The webhook write-back (SQL 109,
 * aws/functions/api/providers/moov-transfer-webhook.mjs) sets the ChecksOps status to failed,
 * returned or canceled and records the ACH return or NOC in provider_metadata; Moov's own
 * status (provider_status) can still read "completed" after a return, so a bounced status wins.
 */
export type TransferReturnRow = {
  status?: string | null;
  provider_status?: string | null;
  provider_metadata?: Record<string, unknown> | null;
};

const BOUNCED = new Set(["failed", "returned", "canceled"]);

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const str = (value: unknown): string | null => {
  const s = typeof value === "string" ? value.trim() : "";
  return s ? s : null;
};

export function isBouncedTransferStatus(status: string | null | undefined): boolean {
  return BOUNCED.has(String(status || "").toLowerCase());
}

/** The status to show: a bounced ChecksOps status, else Moov's, else ChecksOps'. */
export function transferDisplayStatus(row: TransferReturnRow): string | null {
  if (isBouncedTransferStatus(row.status)) return String(row.status);
  return row.provider_status || row.status || null;
}

/** One line explaining a return, failure or bank notification of change, or null. */
export function transferIssueText(row: TransferReturnRow): string | null {
  const meta = record(row.provider_metadata) ?? {};
  const ret = record(meta.moov_return);
  const correction = record(meta.moov_correction);
  const code = str(ret?.code);
  if (code && isBouncedTransferStatus(row.status)) {
    const reason = str(ret?.reason);
    return `Returned by the bank (${code}${reason ? `: ${reason}` : ""}). Check the bank details and send again if needed.`;
  }
  // Only what Moov reported after the transfer was created (the webhook record); a send's own
  // refusals and unsent legs keep the existing display.
  if (isBouncedTransferStatus(row.status) && record(meta.moov_last_webhook)) {
    const status = String(row.status).toLowerCase();
    return status === "canceled"
      ? "Moov canceled this transfer. Send again if needed."
      : `Moov reported this transfer ${status}. Check the bank details and send again if needed.`;
  }
  const correctionCode = str(correction?.code);
  if (correctionCode) {
    return `The bank sent a notification of change (${correctionCode}). Update the bank details before the next payment.`;
  }
  return null;
}
