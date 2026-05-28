/**
 * Embed mode context: ChecksOps is loaded inside Freedom CRM (or other partner)
 * via `?embed=1&partner=XXXXXXXX&freedom_claim_id=<uuid>&claim_number=...
 * &carrier=...&insured_name=...&user_email=...`.
 *
 * This hook reads those params once on first mount, persists them to
 * sessionStorage (so they survive route changes inside the iframe), and exposes
 * the context to anywhere that needs to prefill or tag a check.
 */

const KEY = "checksops_embed_context_v1";

export interface EmbedContext {
  embed: boolean;
  partnerCode: string | null;
  freedomClaimId: string | null;
  claimNumber: string | null;
  carrier: string | null;
  insuredName: string | null;
  userEmail: string | null;
}

const EMPTY: EmbedContext = {
  embed: false,
  partnerCode: null,
  freedomClaimId: null,
  claimNumber: null,
  carrier: null,
  insuredName: null,
  userEmail: null,
};

function readFromUrl(): EmbedContext | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("embed") !== "1") return null;
  return {
    embed: true,
    partnerCode: (params.get("partner") || "").trim().toUpperCase() || null,
    freedomClaimId: params.get("freedom_claim_id") || null,
    claimNumber: params.get("claim_number") || null,
    carrier: params.get("carrier") || null,
    insuredName: params.get("insured_name") || null,
    userEmail: params.get("user_email") || null,
  };
}

function readFromStorage(): EmbedContext | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as EmbedContext;
  } catch {
    return null;
  }
}

/** Capture URL params on app bootstrap. Call once from App.tsx. */
export function bootstrapEmbedContext(): EmbedContext {
  const fromUrl = readFromUrl();
  if (fromUrl) {
    try { sessionStorage.setItem(KEY, JSON.stringify(fromUrl)); } catch { /* ignore */ }
    return fromUrl;
  }
  return readFromStorage() ?? EMPTY;
}

export function getEmbedContext(): EmbedContext {
  return readFromStorage() ?? EMPTY;
}

export function clearEmbedContext() {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
}
