/**
 * X9 / CheckAlt return reason codes (edge runtime copy).
 * Keep in sync with src/lib/checkReturnCodes.ts.
 */
export type CheckReturnCode = {
  code: string;
  label: string;
  checkaltCodes: string[];
};

export const CHECK_RETURN_CODES: CheckReturnCode[] = [
  { code: "A", label: "NSF — Insufficient funds", checkaltCodes: ["A", "01", "R01"] },
  { code: "B", label: "Uncollected funds hold", checkaltCodes: ["B", "02"] },
  { code: "C", label: "Stop payment", checkaltCodes: ["C", "03", "R08"] },
  { code: "D", label: "Closed account", checkaltCodes: ["D", "04", "R02"] },
  { code: "E", label: "Unable to locate account", checkaltCodes: ["E", "05", "R03"] },
  { code: "F", label: "Frozen / blocked account", checkaltCodes: ["F", "06", "R16"] },
  { code: "G", label: "Stale dated", checkaltCodes: ["G", "07"] },
  { code: "H", label: "Post dated", checkaltCodes: ["H", "08"] },
  { code: "I", label: "Endorsement missing", checkaltCodes: ["I", "09"] },
  { code: "J", label: "Endorsement irregular", checkaltCodes: ["J", "10"] },
  { code: "K", label: "Signature(s) missing", checkaltCodes: ["K", "11"] },
  { code: "L", label: "Signature(s) irregular / suspected forgery", checkaltCodes: ["L", "12"] },
  { code: "M", label: "Non-cash item", checkaltCodes: ["M", "13"] },
  { code: "N", label: "Altered / fictitious item", checkaltCodes: ["N", "14"] },
  { code: "O", label: "Unable to process", checkaltCodes: ["O", "15"] },
  { code: "P", label: "Item exceeds dollar limit", checkaltCodes: ["P", "16"] },
  { code: "Q", label: "Not authorized", checkaltCodes: ["Q", "17"] },
  { code: "S", label: "Refer to sender / refer to maker", checkaltCodes: ["S", "18", "R23", "refer to sender", "refer to maker"] },
  { code: "T", label: "Stop payment suspect", checkaltCodes: ["T", "19"] },
  { code: "U", label: "Unusable image", checkaltCodes: ["U", "20"] },
  { code: "W", label: "Cannot determine amount", checkaltCodes: ["W", "21"] },
  { code: "Y", label: "Duplicate presentment", checkaltCodes: ["Y", "22"] },
  { code: "Z", label: "Forgery", checkaltCodes: ["Z", "23"] },
];

const LOOKUP = new Map<string, CheckReturnCode>();
for (const entry of CHECK_RETURN_CODES) {
  LOOKUP.set(entry.code.toLowerCase(), entry);
  for (const alias of entry.checkaltCodes) LOOKUP.set(alias.toLowerCase(), entry);
}

export function resolveReturnCode(raw?: string | null): CheckReturnCode | null {
  if (raw === null || raw === undefined) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;
  return LOOKUP.get(key) ?? LOOKUP.get(key.replace(/[^a-z0-9]/g, "")) ?? null;
}

/**
 * Pull a return code + human reason out of an arbitrary CheckAlt payload.
 * CheckAlt has used several field names across endpoint versions, so we probe
 * all of them rather than assuming one shape.
 */
export function extractReturnInfo(payload: any): { code: string | null; reason: string | null } {
  const candidates = [
    payload?.returnReasonCode,
    payload?.returnCode,
    payload?.returnReason,
    payload?.reasonCode,
    payload?.rejectCode,
    payload?.statusReason,
    payload?.historyFallback?.returnReasonCode,
    payload?.historyFallback?.returnReason,
    payload?.historyFallback?.reasonCode,
  ].filter((v) => v !== null && v !== undefined && String(v).trim() !== "");

  for (const candidate of candidates) {
    const match = resolveReturnCode(candidate);
    if (match) return { code: match.code, reason: match.label };
  }

  const rawReason = candidates.length > 0 ? String(candidates[0]) : null;
  return { code: rawReason ? "OTHER" : null, reason: rawReason };
}
