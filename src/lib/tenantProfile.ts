import { supabase } from "@/integrations/supabase/client";
import { isAwsStaging } from "@/lib/awsStaging";

/**
 * Company details the ChecksOps platform owner edits from Tenant Management.
 * On AWS the save goes through tenant-billing-admin `profile-update`
 * (is_platform_owner(), SQL 102 setter, audited). The slug and partner code
 * are permanent and never sent; the server derives moov_environment from
 * is_test_account.
 */
export interface TenantProfilePatch {
  name?: string;
  custom_domain?: string | null;
  subscription_status?: string;
  max_checks_per_month?: number;
  is_test_account?: boolean;
  kyc_status?: string;
  kyc_notes?: string | null;
  internal_notes?: string | null;
}

export const TENANT_PROFILE_KEYS: ReadonlyArray<keyof TenantProfilePatch> = [
  "name",
  "custom_domain",
  "subscription_status",
  "max_checks_per_month",
  "is_test_account",
  "kyc_status",
  "kyc_notes",
  "internal_notes",
];

type FunctionReply = { ok?: boolean; error?: string; message?: string } | null;

/**
 * The readable sentence for a refused function call: the server's `message`
 * first, then the error text, then the fallback. Null when the call succeeded.
 */
export function functionRefusalMessage(data: unknown, error: unknown, fallback: string): string | null {
  const body = (data && typeof data === "object" ? data : null) as FunctionReply;
  const refused = !!error || body?.ok === false;
  if (!refused) return null;
  const message = typeof body?.message === "string" && body.message.trim() ? body.message : null;
  const errorText = (error as { message?: string } | null)?.message;
  return message || errorText || (typeof body?.error === "string" ? body.error : null) || fallback;
}

export async function saveTenantProfile<T extends Record<string, unknown> = Record<string, unknown>>(
  tenantId: string,
  patch: TenantProfilePatch,
): Promise<T | null> {
  const profile: Record<string, unknown> = {};
  for (const key of TENANT_PROFILE_KEYS) {
    if (patch[key] !== undefined) profile[key] = patch[key];
  }
  if (Object.keys(profile).length === 0) return null;
  if (isAwsStaging()) {
    const { data, error } = await supabase.functions.invoke("tenant-billing-admin", {
      body: { action: "profile-update", tenant_id: tenantId, ...profile },
    });
    const refusal = functionRefusalMessage(data, error, "Company details were not saved");
    if (refusal) throw new Error(refusal);
    return ((data as { tenant?: T } | null)?.tenant ?? null) as T | null;
  }
  const legacy: Record<string, unknown> = { ...profile };
  if (typeof profile.is_test_account === "boolean") {
    legacy.moov_environment = profile.is_test_account ? "sandbox" : "production";
  }
  const { data, error } = await supabase
    .from("tenants")
    .update(legacy as never)
    .eq("id", tenantId)
    .select()
    .single();
  if (error) throw new Error(error.message || "Company details were not saved");
  return (data ?? null) as unknown as T | null;
}

/** Platform owner only: remove a login from a tenant (the account is kept). */
export async function removeTenantMember(tenantId: string, userId: string): Promise<void> {
  if (isAwsStaging()) {
    const { data, error } = await supabase.functions.invoke("tenant-billing-admin", {
      body: { action: "member-remove", tenant_id: tenantId, user_id: userId },
    });
    const refusal = functionRefusalMessage(data, error, "The user was not removed");
    if (refusal) throw new Error(refusal);
    return;
  }
  const { error } = await supabase
    .from("tenant_users")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("user_id", userId);
  if (error) throw new Error(error.message || "The user was not removed");
}

export interface TenantInviteResendResult {
  invite_sent: boolean;
  invite_error: string | null;
}

/** Platform owner only: send a member's tenant invite email again (AWS). */
export async function resendTenantInvite(tenantId: string, email: string): Promise<TenantInviteResendResult> {
  const { data, error } = await supabase.functions.invoke("tenant-invite-resend", {
    body: { tenant_id: tenantId, email },
  });
  const refusal = functionRefusalMessage(data, error, "The invite was not sent");
  if (refusal) throw new Error(refusal);
  const body = (data ?? {}) as { invite_sent?: boolean; invite_error?: string | null };
  return { invite_sent: body.invite_sent !== false, invite_error: body.invite_error ?? null };
}
