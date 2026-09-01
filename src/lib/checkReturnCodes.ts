/**
 * X9 / CheckAlt (Clearingworks FinCapture) check return reason codes.
 *
 * These are the codes the bank of first deposit passes back when an item is
 * returned after it was presented — including late returns that land days or
 * weeks after the deposit already showed as cleared.
 *
 * `code` is the single-letter X9 return reason; `checkaltCodes` are the
 * numeric/string values CheckAlt has been observed to send for the same
 * reason so we can map a provider payload onto our canonical list.
 */
export type CheckReturnCode = {
  code: string;
  label: string;
  description: string;
  /** Values CheckAlt may report for this reason. */
  checkaltCodes: string[];
  /** True when the item can typically be re-presented / redeposited. */
  redepositable: boolean;
};

export const CHECK_RETURN_CODES: CheckReturnCode[] = [
  { code: "A", label: "NSF — Insufficient funds", description: "Maker's account did not have enough funds.", checkaltCodes: ["A", "01", "R01"], redepositable: true },
  { code: "B", label: "Uncollected funds hold", description: "Funds in the maker's account are not yet available.", checkaltCodes: ["B", "02"], redepositable: true },
  { code: "C", label: "Stop payment", description: "Maker placed a stop payment on the item.", checkaltCodes: ["C", "03", "R08"], redepositable: false },
  { code: "D", label: "Closed account", description: "The maker's account is closed.", checkaltCodes: ["D", "04", "R02"], redepositable: false },
  { code: "E", label: "Unable to locate account", description: "Account number could not be located at the paying bank.", checkaltCodes: ["E", "05", "R03"], redepositable: false },
  { code: "F", label: "Frozen / blocked account", description: "Paying bank has restricted the account.", checkaltCodes: ["F", "06", "R16"], redepositable: false },
  { code: "G", label: "Stale dated", description: "Item was presented past its validity window.", checkaltCodes: ["G", "07"], redepositable: false },
  { code: "H", label: "Post dated", description: "Item was presented before its issue date.", checkaltCodes: ["H", "08"], redepositable: true },
  { code: "I", label: "Endorsement missing", description: "A required endorsement was not present.", checkaltCodes: ["I", "09"], redepositable: true },
  { code: "J", label: "Endorsement irregular", description: "An endorsement was present but not acceptable.", checkaltCodes: ["J", "10"], redepositable: true },
  { code: "K", label: "Signature(s) missing", description: "Maker signature missing.", checkaltCodes: ["K", "11"], redepositable: false },
  { code: "L", label: "Signature(s) irregular / suspected forgery", description: "Maker signature does not match or is suspect.", checkaltCodes: ["L", "12"], redepositable: false },
  { code: "M", label: "Non-cash item", description: "Item is not eligible for cash settlement.", checkaltCodes: ["M", "13"], redepositable: false },
  { code: "N", label: "Altered / fictitious item", description: "Item appears altered or fabricated.", checkaltCodes: ["N", "14"], redepositable: false },
  { code: "O", label: "Unable to process", description: "Paying bank could not process the item.", checkaltCodes: ["O", "15"], redepositable: true },
  { code: "P", label: "Item exceeds dollar limit", description: "Amount exceeds an account or product limit.", checkaltCodes: ["P", "16"], redepositable: false },
  { code: "Q", label: "Not authorized", description: "Presentment was not authorized.", checkaltCodes: ["Q", "17"], redepositable: false },
  { code: "S", label: "Refer to sender / refer to maker", description: "Paying bank will not pay — contact the issuer (carrier) directly.", checkaltCodes: ["S", "18", "R23", "refer to sender", "refer to maker"], redepositable: false },
  { code: "T", label: "Stop payment suspect", description: "Possible stop payment, verify with maker.", checkaltCodes: ["T", "19"], redepositable: false },
  { code: "U", label: "Unusable image", description: "Image quality was not acceptable.", checkaltCodes: ["U", "20"], redepositable: true },
  { code: "W", label: "Cannot determine amount", description: "Amount could not be read from the item.", checkaltCodes: ["W", "21"], redepositable: true },
  { code: "Y", label: "Duplicate presentment", description: "Item was already presented and paid.", checkaltCodes: ["Y", "22"], redepositable: false },
  { code: "Z", label: "Forgery", description: "Confirmed forgery on the item.", checkaltCodes: ["Z", "23"], redepositable: false },
  { code: "OTHER", label: "Other / unspecified", description: "Return reason supplied by the bank does not map to a standard code.", checkaltCodes: [], redepositable: false },
];

const LOOKUP = new Map<string, CheckReturnCode>();
for (const entry of CHECK_RETURN_CODES) {
  LOOKUP.set(entry.code.toLowerCase(), entry);
  for (const alias of entry.checkaltCodes) LOOKUP.set(alias.toLowerCase(), entry);
}

/** Resolve a raw CheckAlt code/reason string onto a canonical return code. */
export function resolveReturnCode(raw?: string | null): CheckReturnCode | null {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  return LOOKUP.get(key) ?? LOOKUP.get(key.replace(/[^a-z0-9]/g, "")) ?? null;
}

/** Human label for a stored return code, falling back to the raw value. */
export function returnCodeLabel(code?: string | null, reason?: string | null): string {
  const match = resolveReturnCode(code);
  if (match && match.code !== "OTHER") return `${match.code} — ${match.label}`;
  return reason || code || "Returned";
}
