// What happened to a payee's endorsement request email, for the line under the request in the Endorsements card
// (owner 2026-11-19: "Is there anyway for tenants to see if an email has been delivered and opened? For this to show
// up near the payee signature request", then "Yeah build 1 and 2": delivered or bounced from Resend's delivery
// reports, and when the payee opened the signing link).
//
// Opened and clicked (owner 2026-11-23: "Yes build opened and clicked", then "Build the opened and clicked display on the
// website") are SQL 172's columns, written by the API from Resend's email.opened and email.clicked events. Resend reports
// "opened" from a tracking pixel, so a mail client that preloads images can count as opened. Each is shown only when its
// latest report is newer than the latest send. The counts are not reset by a resend, so a count is shown only when the
// first report is also newer than the latest send (every report then belongs to the current request).
//
// The fields are SQL 170's columns on check_endorsements. Before SQL 170 is applied they are absent (undefined): then
// `tracked` is false and the card shows exactly what it showed before ("Last sent ...").

export interface EndorsementEmailFields {
  request_sent_at?: string | null;
  email_message_id?: string | null;
  email_delivered_at?: string | null;
  email_bounced_at?: string | null;
  email_bounce_reason?: string | null;
  email_complained_at?: string | null;
  link_first_opened_at?: string | null;
  link_last_opened_at?: string | null;
  link_open_count?: number | null;
  email_first_opened_at?: string | null;
  email_last_opened_at?: string | null;
  email_open_count?: number | null;
  email_first_clicked_at?: string | null;
  email_last_clicked_at?: string | null;
  email_click_count?: number | null;
}

export type EndorsementDeliveryState = "pending" | "delivered" | "bounced" | "complained";

export interface EndorsementEmailStatus {
  /** False until SQL 170's columns come back on the row. */
  tracked: boolean;
  delivery: EndorsementDeliveryState | null;
  deliveredAt: string | null;
  bouncedAt: string | null;
  bounceReason: string | null;
  complainedAt: string | null;
  linkOpenedAt: string | null;
  linkOpenCount: number;
  /** Latest Resend "opened" report for the current request (SQL 172), or null. */
  emailOpenedAt: string | null;
  /** Opened reports for the current request; 0 when unknown (reports from an earlier send are mixed in). */
  emailOpenCount: number;
  /** Latest Resend "clicked" report for the current request (SQL 172), or null. */
  emailClickedAt: string | null;
  emailClickCount: number;
}

const TRACKED_KEYS: (keyof EndorsementEmailFields)[] = [
  "email_message_id",
  "email_delivered_at",
  "email_bounced_at",
  "email_complained_at",
  "link_first_opened_at",
  "link_last_opened_at",
  "link_open_count",
];

const when = (value: string | null | undefined): string | null => {
  if (!value) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
};

const ms = (value: string | null): number => (value ? new Date(value).getTime() : NaN);

/** The latest report and its count, kept only when the latest report is not older than the latest send. */
const sinceSend = (
  sentAt: string | null,
  first: string | null | undefined,
  last: string | null | undefined,
  count: number | null | undefined,
): { at: string | null; count: number } => {
  const lastAt = when(last) || when(first);
  if (!lastAt) return { at: null, count: 0 };
  const sent = ms(sentAt);
  if (Number.isFinite(sent) && ms(lastAt) < sent) return { at: null, count: 0 };
  const firstAt = when(first);
  const n = Number(count || 0);
  const whole = !Number.isFinite(sent) || (firstAt !== null && ms(firstAt) >= sent);
  return { at: lastAt, count: whole && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 };
};

export const endorsementEmailStatus = (row: EndorsementEmailFields | null | undefined): EndorsementEmailStatus => {
  const tracked = Boolean(row) && TRACKED_KEYS.some((key) => (row as EndorsementEmailFields)[key] !== undefined);
  const deliveredAt = when(row?.email_delivered_at);
  const bouncedAt = when(row?.email_bounced_at);
  const complainedAt = when(row?.email_complained_at);
  const linkOpenedAt = when(row?.link_last_opened_at) || when(row?.link_first_opened_at);
  const count = Number(row?.link_open_count || 0);
  let delivery: EndorsementDeliveryState | null = null;
  if (tracked && when(row?.request_sent_at)) {
    // A bounce or a spam complaint outranks delivery: the request did not reach the payee, or the payee flagged it.
    if (bouncedAt) delivery = "bounced";
    else if (complainedAt) delivery = "complained";
    else if (deliveredAt) delivery = "delivered";
    else delivery = "pending";
  }
  const sentAt = when(row?.request_sent_at);
  const opened = sinceSend(sentAt, row?.email_first_opened_at, row?.email_last_opened_at, row?.email_open_count);
  const clicked = sinceSend(sentAt, row?.email_first_clicked_at, row?.email_last_clicked_at, row?.email_click_count);
  return {
    tracked,
    delivery,
    deliveredAt,
    bouncedAt,
    bounceReason: row?.email_bounce_reason ? String(row.email_bounce_reason).slice(0, 160) : null,
    complainedAt,
    linkOpenedAt,
    linkOpenCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : linkOpenedAt ? 1 : 0,
    emailOpenedAt: tracked ? opened.at : null,
    emailOpenCount: tracked ? opened.count : 0,
    emailClickedAt: tracked ? clicked.at : null,
    emailClickCount: tracked ? clicked.count : 0,
  };
};
