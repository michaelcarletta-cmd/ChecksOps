/**
 * Shared passkey list presentation helpers (AWS Cognito + Supabase).
 * Never treat authenticatorAttachment ("platform") as a user-facing name.
 * Never convert missing/invalid timestamps into an epoch date.
 */

const ATTACHMENT_LABELS = new Set(["platform", "cross-platform"]);

export type PasskeyDisplayInput = {
  friendlyName?: string | null;
  authenticatorAttachment?: string | null;
  device_name?: string | null;
  createdAt?: string | number | null;
  created_at?: string | number | null;
  lastUsedAt?: string | number | null;
  last_used_at?: string | number | null;
};

/** Prefer Cognito FriendlyCredentialName / device_name; never fall back to "platform". */
export function passkeyDisplayName(row: PasskeyDisplayInput): string {
  const candidates = [row.friendlyName, row.device_name];
  for (const raw of candidates) {
    const name = String(raw || "").trim();
    if (!name) continue;
    if (ATTACHMENT_LABELS.has(name.toLowerCase())) continue;
    return name;
  }
  return "Passkey";
}

/**
 * Parse CreatedAt safely. Cognito returns UNIX epoch seconds; JS Date(number)
 * treats numbers as milliseconds, which produced "1/21/1970" in the UI.
 * Rejects missing/invalid values and dates before 2000 so we never show epoch.
 */
export function passkeyCreatedAtIso(
  value: string | number | null | undefined,
): string | null {
  if (value == null || value === "") return null;
  let date: Date | null = null;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    date = new Date(ms);
  } else {
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) return null;
      const ms = numeric > 1e12 ? numeric : numeric * 1000;
      date = new Date(ms);
    } else {
      date = new Date(trimmed);
    }
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  // Guard against epoch / nonsense (e.g. seconds misread as ms).
  if (date.getUTCFullYear() < 2000) return null;
  return date.toISOString();
}

export function formatPasskeyAddedLabel(
  value: string | number | null | undefined,
): string | null {
  const iso = passkeyCreatedAtIso(value);
  if (!iso) return null;
  return `Added ${new Date(iso).toLocaleDateString()}`;
}

export function formatPasskeyLastUsedLabel(
  value: string | number | null | undefined,
): string | null {
  const iso = passkeyCreatedAtIso(value);
  if (!iso) return null;
  return `Last used ${new Date(iso).toLocaleDateString()}`;
}

/** Subtitle under the passkey name. Omits last-used when Cognito/API has none. */
export function formatPasskeyMetaLine(row: PasskeyDisplayInput): string {
  const added = formatPasskeyAddedLabel(row.createdAt ?? row.created_at);
  const used = formatPasskeyLastUsedLabel(row.lastUsedAt ?? row.last_used_at);
  return [added, used].filter(Boolean).join(" · ");
}
