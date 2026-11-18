// Builds the address part of mailto: and tel: links from values a homeowner
// typed into a public form. Encoding keeps the value inside the address: a
// "?" or "&" in it cannot add cc, bcc or body fields to the draft.

/** Percent-encodes an email address for a mailto: link, keeping "@" readable. */
export function mailtoAddress(email: string | null | undefined): string {
  return encodeURIComponent(String(email ?? "").trim()).replace(/%40/g, "@");
}

/** Reduces a phone number to the characters a tel: link may carry. */
export function telNumber(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/[^0-9+*#,;]/g, "");
}
