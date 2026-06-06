// US ABA routing number checksum (mod 10).
// Returns true if the 9-digit routing number passes the checksum.
export function isValidRoutingNumber(aba: string): boolean {
  const clean = (aba ?? "").replace(/\D/g, "");
  if (clean.length !== 9) return false;
  const d = clean.split("").map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) +
    7 * (d[1] + d[4] + d[7]) +
    1 * (d[2] + d[5] + d[8]);
  return sum > 0 && sum % 10 === 0;
}

export function isValidAccountNumber(acct: string): boolean {
  const clean = (acct ?? "").replace(/\D/g, "");
  return clean.length >= 4 && clean.length <= 17;
}

export type VerificationStatus =
  | "unverified"
  | "pending"
  | "verified"
  | "failed"
  | "locked"
  | "admin_override";

export const VERIFICATION_LABEL: Record<VerificationStatus, string> = {
  unverified: "Not verified",
  pending: "Awaiting micro-deposit confirmation",
  verified: "Verified",
  failed: "Verification failed",
  locked: "Locked — too many wrong attempts",
  admin_override: "Admin override",
};

export const VERIFICATION_BADGE_CLASS: Record<VerificationStatus, string> = {
  unverified: "bg-muted text-muted-foreground border-border",
  pending: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  verified: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30",
  failed: "bg-rose-500/10 text-rose-700 border-rose-500/30",
  locked: "bg-rose-500/10 text-rose-700 border-rose-500/30",
  admin_override: "bg-purple-500/10 text-purple-700 border-purple-500/30",
};
