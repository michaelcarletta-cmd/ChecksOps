import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SIGNUP_INIT = "https://join.actumprocessing.com/Signup/SignupInit.cgi";

export interface AuthentecheckAccount {
  id: string;
  tenant_id: string;
  nickname: string | null;
  custname: string | null;
  verification_status: string;
  verification_recipient_email: string | null;
}

export interface AuthentecheckFallbackIdentity {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
}

export interface InitiateAuthentecheckOptions {
  returnUrl?: string | null;
  actorUserId?: string | null;
  fallbackIdentity?: AuthentecheckFallbackIdentity | null;
}

export type InitiateAuthentecheckResult =
  | { success: true; url: string }
  | { success: false; error: string };

/**
 * Builds and submits the Actum Authentecheck SignupInit request for a
 * stakeholder account, then records the resulting session (or failure).
 * Shared between the authenticated (in-app) and token-based (emailed link)
 * initiation paths so future Actum-side request-format fixes only need to
 * happen in one place.
 */
export async function initiateAuthentecheckSession(
  supabase: ReturnType<typeof createClient>,
  account: AuthentecheckAccount,
  options: InitiateAuthentecheckOptions = {},
): Promise<InitiateAuthentecheckResult> {
  if (account.verification_status === "verified" || account.verification_status === "admin_override") {
    return { success: false, error: "Account is already verified" };
  }

  try {
    const { data: tenantData, error: tenantErr } = await supabase
      .from("tenants")
      .select("actum_environment, actum_parent_id, actum_sub_id, actum_sub_id_ppd, actum_sub_id_ccd, actum_syspass, actum_username, actum_password, actum_test_parent_id, actum_test_sub_id_ppd, actum_test_sub_id_ccd, actum_test_syspass, actum_test_username, actum_test_password")
      .eq("id", account.tenant_id)
      .single();
    if (tenantErr) throw new Error(`Could not load tenant Actum config: ${tenantErr.message}`);

    const env = (tenantData as any)?.actum_environment === "production" ? "production" : "test";
    const isProd = env === "production";
    const syspass = isProd ? tenantData?.actum_syspass : (tenantData as any)?.actum_test_syspass;
    const meruser = isProd ? tenantData?.actum_username : (tenantData as any)?.actum_test_username;
    const merpass = isProd ? tenantData?.actum_password : (tenantData as any)?.actum_test_password;
    const parentId = isProd ? (tenantData as any)?.actum_parent_id : (tenantData as any)?.actum_test_parent_id;
    const subid = isProd
      ? ((tenantData as any)?.actum_sub_id_ppd || (tenantData as any)?.actum_sub_id_ccd || (tenantData as any)?.actum_sub_id)
      : ((tenantData as any)?.actum_test_sub_id_ppd || (tenantData as any)?.actum_test_sub_id_ccd);
    if (!meruser || !merpass || !syspass || !parentId || !subid) {
      throw new Error(`Actum Authentecheck ${env} credentials not configured for this tenant.`);
    }
    console.log(`[authentecheck-init] using ${env} environment for tenant ${account.tenant_id}`);

    // Actum rejects names containing "@" or other non-name chars ("First name
    // foo@bar.com is invalid"). Sanitize each candidate: drop empties, drop
    // anything that looks like an email, strip disallowed characters.
    const cleanNamePart = (s: string) => s.replace(/[^A-Za-z' -]/g, "").trim();
    const isEmailish = (s: string) => /@/.test(s);
    const fallback = options.fallbackIdentity ?? {};
    const nameCandidates: string[] = [];
    if (account.custname && account.custname !== "Pending" && !isEmailish(account.custname)) {
      nameCandidates.push(account.custname);
    }
    const joinedFallback = [fallback.firstName, fallback.lastName].filter(Boolean).join(" ");
    if (joinedFallback && !isEmailish(joinedFallback)) nameCandidates.push(joinedFallback);
    if (fallback.fullName && !isEmailish(fallback.fullName)) nameCandidates.push(fallback.fullName);
    // Last resort: derive from email local-part (e.g. "mcarletta@..." -> "Mcarletta Holder")
    const emailLocal = (fallback.email ?? "").split("@")[0]?.replace(/[._-]+/g, " ").trim();
    if (emailLocal) nameCandidates.push(emailLocal.charAt(0).toUpperCase() + emailLocal.slice(1));
    nameCandidates.push("Account Holder");

    const rawName = nameCandidates.find((n) => cleanNamePart(n).length > 0) ?? "Account Holder";
    const parts = cleanNamePart(rawName).split(/\s+/).filter(Boolean);
    // In test/sandbox mode, Plaid's test institutions (Houndstooth Bank, First
    // Platypus Bank) always return a fixed identity ("Robert A Yakuza"). Actum
    // appears to cross-check the merchant-submitted name against the identity
    // Plaid returns, so submitting a real user's name here causes a mismatch
    // that a real production bank login wouldn't hit. Match Actum's own
    // documented test identity instead of the real name.
    const firstName = isProd ? (parts[0] || "Account").slice(0, 30) : "Bob";
    const lastName = isProd ? (parts.length > 1 ? parts.slice(1).join(" ") : "Holder").slice(0, 30) : "Yakuza";

    const emailCandidate = String(
      account.verification_recipient_email || fallback.email || "",
    ).trim();
    const custEmail = emailCandidate && emailCandidate.length <= 50
      ? emailCandidate
      : `bank-${account.id.slice(0, 8)}@checksops.com`;

    const appBase = Deno.env.get("APP_BASE_URL") ?? "https://checksops.com";
    const acceptUrl = options.returnUrl ?? `${appBase}/verify-account/complete?ok=1&acct=${account.id}`;
    const declineUrl = options.returnUrl ?? `${appBase}/verify-account/complete?ok=0&acct=${account.id}`;
    const postbackUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/actum-authentecheck-postback`;

    // Per Actum's working curl example: the merchant token goes in the URL
    // query string as `?chk:PARENT:SUB=null` (URL-encoded colons), NOT in the
    // POST body. All other fields are standard form-urlencoded body params.
    // Also required: `authdata=1` and `identity=1` to trigger the Plaid-backed
    // Authentecheck flow (bank verification), not a regular signup charge.
    const psDesc = `Bank verification ${(account.nickname ?? "Account").slice(0, 20)}`
      .replace(/[^A-Za-z0-9 ]/g, "")
      .slice(0, 50);

    const params = new URLSearchParams();
    params.append("custemail", custEmail);
    params.append("firstname", firstName);
    params.append("lastname", lastName);
    // Actum: "$0 will return ACH Verification" — Authentecheck is a bank-account
    // verification session, not a real charge, so the initial amount is $0.
    params.append("ps1_init", "0.00");
    params.append("ps1_cycle", "-1");
    params.append("ps1_desc", psDesc);
    params.append("merchantdata", account.id);
    params.append("redirect_accept", acceptUrl);
    params.append("redirect_decline", declineUrl);
    params.append("dynamic_saleurl", postbackUrl);
    params.append("authdata", "1");
    params.append("identity", "1");
    // Actum enabled the "verifiedcons" bypass for this account — without it, a
    // consumer's first transaction is held for two business days and any
    // repeat attempt with the same routing/account (e.g. repeated sandbox
    // testing with the same test bank account) is declined as "Uncleared
    // Transaction" during Transaction Processing.
    params.append("verifiedcons", "1");
    // Per Actum support: their stored/default postback URL is only actually
    // triggered when postback=1 is included in the request, in addition to
    // (or alongside) dynamic_saleurl.
    params.append("postback", "1");
    params.append("meruser", meruser);
    params.append("merpass", merpass);
    params.append("syspass", syspass);

    const parentClean = String(parentId).trim();
    const subClean = String(subid).trim();
    // Encode the colons in the merchant token key (Actum's example uses %3A).
    const merchantTokenParam = `chk%3A${encodeURIComponent(parentClean)}%3A${encodeURIComponent(subClean)}=null`;
    const url = `${SIGNUP_INIT}?${merchantTokenParam}`;

    console.log("[authentecheck-init] initiating session for account", account.id, "url:", url);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const text = await res.text();
    console.log("[authentecheck-init] Actum response:", text);

    // Parse single key=value
    let sessionUrl: string | null = null;
    let actumErr: string | null = null;
    for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 1);
      if (k === "url") sessionUrl = v;
      if (k === "error") actumErr = v;
    }

    if (!sessionUrl) {
      throw new Error(actumErr ?? `Actum did not return a session URL: ${text.slice(0, 200)}`);
    }

    await supabase
      .from("stakeholder_accounts")
      .update({
        verification_status: "pending",
        authentecheck_session_url: sessionUrl,
        authentecheck_initiated_at: new Date().toISOString(),
      })
      .eq("id", account.id);

    await supabase.from("stakeholder_account_verification_log").insert({
      stakeholder_account_id: account.id,
      tenant_id: account.tenant_id,
      event_type: "authentecheck_initiated",
      actor_user_id: options.actorUserId ?? null,
      details: { session_url: sessionUrl },
    });

    return { success: true, url: sessionUrl };
  } catch (err: any) {
    console.error("[authentecheck-init]", err);
    await supabase
      .from("stakeholder_accounts")
      .update({
        is_active: false,
        verification_status: "failed",
        verification_failure_reason: err.message ?? "Authentecheck failed to start",
      })
      .eq("id", account.id);
    return { success: false, error: err.message ?? "Authentecheck failed to start" };
  }
}
