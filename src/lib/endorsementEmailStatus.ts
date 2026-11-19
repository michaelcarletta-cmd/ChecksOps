// What happened to a payee's endorsement request email, for the line under the request in the Endorsements card
// (owner 2026-11-19: "Is there anyway for tenants to see if an email has been delivered and opened? For this to show
// up near the payee signature request", then "Yeah build 1 and 2": delivered or bounced from Resend's delivery
// reports, and when the payee opened the signing link).
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
  return {
    tracked,
    delivery,
    deliveredAt,
    bouncedAt,
    bounceReason: row?.email_bounce_reason ? String(row.email_bounce_reason).slice(0, 160) : null,
    complainedAt,
    linkOpenedAt,
    linkOpenCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : linkOpenedAt ? 1 : 0,
  };
};
