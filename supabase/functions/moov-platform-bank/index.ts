import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  MoovError,
  moovFetch,
  moovConfigured,
  moovEnvironment,
  safeLastFour,
  scopes,
} from "../_shared/moovClient.ts";
import {
  corsHeaders,
  json,
  logPaymentEvent,
  moovGloballyEnabled,
  sanitize,
  serviceClient,
} from "../_shared/moovGuard.ts";

/**
 * Platform (master merchant) bank account management.
 *
 * Tenant bank accounts are attached to each tenant's own connected account via
 * `moov-bank-account-add`. This function is the PLATFORM equivalent: it links
 * and verifies the settlement bank on the ChecksOps facilitator account
 * (MOOV_PLATFORM_ACCOUNT_ID) so Tenant Management can pull funds from and send
 * funds to tenant accounts when needed.
 *
 * Access is restricted to the platform owner login only — never to tenant
 * admins — because every action here moves money on the platform account.
 *
 * Platform bank metadata is stored in payment_provider_methods with
 * tenant_id = NULL (the platform belongs to no organization). Micro-deposit
 * attempt state lives in that row's provider_metadata so no tenant-scoped
 * table is touched. Full account/routing numbers are never stored or logged.
 */

const PLATFORM_OWNER_EMAIL = "checksopsadmin@gmail.com";
const MAX_CODE_ATTEMPTS = 3;
const DIGITS = /^\d+$/;

type Authed = { userId: string; supabase: ReturnType<typeof serviceClient> };

async function requirePlatformOwner(req: Request): Promise<Authed | Response> {
  if (!moovGloballyEnabled()) {
    return json({ error: "This payment provider is not enabled." }, 403);
  }
  if (!moovConfigured()) {
    return json({ error: "Payment provider credentials are not configured." }, 503);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

  const email = (userData.user.email ?? "").trim().toLowerCase();
  if (email !== PLATFORM_OWNER_EMAIL) {
    return json({ error: "Platform owner access required." }, 403);
  }

  return { userId: userData.user.id, supabase: serviceClient() };
}

function platformAccountId(): string {
  const id = Deno.env.get("MOOV_PLATFORM_ACCOUNT_ID");
  if (!id) throw new Error("Platform payment account is not configured.");
  return id;
}

function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}

/** Local platform bank rows (tenant_id IS NULL) for this environment. */
async function localMethods(supabase: ReturnType<typeof serviceClient>, environment: string, accountId: string) {
  const { data } = await supabase
    .from("payment_provider_methods")
    .select("*")
    .eq("provider", "moov")
    .eq("environment", environment)
    .eq("provider_account_id", accountId)
    .eq("is_platform", true)
    .is("tenant_id", null)
    .is("external_recipient_id", null)
    .order("created_at", { ascending: false });
  return data ?? [];
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const caller = await requirePlatformOwner(req);
    if (isResponse(caller)) return caller;
    const { supabase, userId } = caller;

    const environment = moovEnvironment();
    const accountId = platformAccountId();

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "status");

    /* ---------------- STATUS ---------------- */
    if (action === "status") {
      let profile: any = null;
      let capabilities: any[] = [];
      let providerBanks: any[] = [];
      const warnings: string[] = [];

      try {
        profile = await moovFetch<any>(`/accounts/${accountId}`, {
          scopes: scopes.accountRead(accountId),
        });
      } catch (e) {
        warnings.push(`profile: ${(e as Error).message}`);
      }
      try {
        capabilities = await moovFetch<any[]>(`/accounts/${accountId}/capabilities`, {
          scopes: scopes.capabilitiesRead(accountId),
        });
      } catch (e) {
        warnings.push(`capabilities: ${(e as Error).message}`);
      }
      try {
        providerBanks = await moovFetch<any[]>(`/accounts/${accountId}/bank-accounts`, {
          scopes: scopes.bankAccountsRead(accountId),
        });
      } catch (e) {
        warnings.push(`bank-accounts: ${(e as Error).message}`);
      }

      const methods = await localMethods(supabase, environment, accountId);

      return json({
        success: true,
        environment,
        platform_account_id: accountId,
        profile: sanitize({
          displayName: profile?.profile?.business?.name ?? profile?.displayName ?? null,
          accountType: profile?.accountType ?? null,
          verificationStatus: profile?.verificationStatus ?? profile?.verification?.status ?? null,
        }),
        capabilities: (capabilities ?? []).map((c: any) => ({
          capability: c.capability,
          status: c.status,
        })),
        provider_bank_accounts: (providerBanks ?? []).map((b: any) => ({
          bank_account_id: b.bankAccountID,
          bank_name: b.bankName ?? null,
          last_four: b.lastFourAccountNumber ?? null,
          bank_account_type: b.bankAccountType ?? null,
          holder_name: b.holderName ?? null,
          status: b.status ?? null,
        })),
        methods: methods.map((m: any) => ({
          id: m.id,
          bank_account_id: m.provider_bank_account_id,
          bank_name: m.bank_name,
          last_four: m.last_four,
          account_type: m.account_type,
          holder_name: m.holder_name,
          verification_status: m.verification_status,
          connection_status: m.connection_status,
          is_default: m.is_default,
          connected_at: m.connected_at,
          micro_deposit: (m.provider_metadata as any)?.micro_deposit ?? null,
        })),
        warnings,
      });
    }

    /* ---------------- ADD BANK ACCOUNT ---------------- */
    if (action === "add") {
      const holderName = String(body?.holder_name ?? "").trim();
      const holderType = body?.holder_type === "individual" ? "individual" : "business";
      const bankAccountType = body?.bank_account_type === "savings" ? "savings" : "checking";
      const routingNumber = String(body?.routing_number ?? "").replace(/\D/g, "");
      const accountNumber = String(body?.account_number ?? "").replace(/\D/g, "");

      if (holderName.length < 2 || holderName.length > 128) {
        return json({ error: "Enter the account holder name as it appears at the bank." }, 400);
      }
      if (!DIGITS.test(routingNumber) || routingNumber.length !== 9) {
        return json({ error: "Routing number must be exactly 9 digits." }, 400);
      }
      if (!DIGITS.test(accountNumber) || accountNumber.length < 4 || accountNumber.length > 17) {
        return json({ error: "Account number must be between 4 and 17 digits." }, 400);
      }

      let created: any;
      try {
        created = await moovFetch<any>(`/accounts/${accountId}/bank-accounts`, {
          method: "POST",
          scopes: scopes.bankAccountsWrite(accountId),
          body: {
            account: {
              holderName,
              holderType,
              accountNumber,
              routingNumber,
              bankAccountType,
            },
          },
        });
      } catch (e) {
        console.error("[moov-platform-bank] attach failed", (e as Error).message);
        return json({ error: (e as Error).message }, 502);
      }

      const bankAccountId = created?.bankAccountID ?? created?.bankAccountId ?? null;
      if (!bankAccountId) return json({ error: "The provider did not return a bank account id." }, 502);

      const bankName = created?.bankName ?? null;
      const lastFour = created?.lastFourAccountNumber ?? safeLastFour(accountNumber);
      const status = String(created?.status ?? "new").toLowerCase();

      const { data: method, error: methodErr } = await supabase
        .from("payment_provider_methods")
        .upsert(
          {
            tenant_id: null,
            external_recipient_id: null,
            is_platform: true,
            provider: "moov",
            environment,
            provider_account_id: accountId,
            provider_bank_account_id: bankAccountId,
            bank_name: bankName,
            account_type: bankAccountType,
            last_four: lastFour,
            holder_name: holderName,
            verification_status: status === "verified" ? "verified" : "unverified",
            connection_status: "connected",
            can_send: true,
            can_receive: true,
            is_default: true,
            connected_at: new Date().toISOString(),
            provider_metadata: sanitize({ status, source: "platform_manual_entry", scope: "platform" }),
          },
          { onConflict: "provider,environment,provider_bank_account_id" },
        )
        .select()
        .maybeSingle();

      if (methodErr) {
        console.error("[moov-platform-bank] persist failed", methodErr.message);
        return json({ error: methodErr.message }, 500);
      }

      await logPaymentEvent(supabase, {
        tenant_id: null,
        event_type: "platform_bank_account.connected",
        new_status: status,
        environment,
        provider_metadata: sanitize({ bankName, lastFour, source: "platform_manual_entry", by: userId }),
      });

      return json({
        success: true,
        payment_method_id: method?.id ?? null,
        bank_account_id: bankAccountId,
        bank_name: bankName,
        last_four: lastFour,
        status,
      });
    }

    /* ---------------- INITIATE MICRO-DEPOSIT ---------------- */
    if (action === "initiate_micro_deposit") {
      const methodId = String(body?.payment_method_id ?? "");
      if (!methodId) return json({ error: "payment_method_id is required" }, 400);

      const { data: method } = await supabase
        .from("payment_provider_methods")
        .select("*")
        .eq("id", methodId)
        .eq("provider", "moov")
        .eq("environment", environment)
        .eq("is_platform", true)
        .is("tenant_id", null)
        .maybeSingle();
      if (!method) return json({ error: "Platform bank account not found." }, 404);
      if (method.provider_account_id !== accountId) return json({ error: "Forbidden" }, 403);

      const bankAccountId = method.provider_bank_account_id as string;



      // Provider is the authority on whether this bank is already verified.
      try {
        const bank = await moovFetch<any>(
          `/accounts/${accountId}/bank-accounts/${bankAccountId}`,
          { scopes: scopes.bankAccountsRead(accountId) },
        );
        if (String(bank?.status ?? "").toLowerCase() === "verified") {
          await supabase
            .from("payment_provider_methods")
            .update({ verification_status: "verified", connection_status: "connected" })
            .eq("id", method.id);
          return json({ success: true, already_verified: true, environment });
        }
      } catch {
        /* the initiate call below is authoritative */
      }

      try {
        await moovFetch<any>(
          `/accounts/${accountId}/bank-accounts/${bankAccountId}/verify`,
          { method: "POST", scopes: scopes.bankAccountsWrite(accountId) },
        );
      } catch (e) {
        console.error("[moov-platform-bank] initiate failed", (e as Error).message);
        return json({
          error: "initiate_failed",
          message: "Could not start bank verification with the payment provider. Reconnect the bank account and try again.",
        }, 502);
      }

      const meta = (method.provider_metadata as Record<string, unknown>) ?? {};
      await supabase
        .from("payment_provider_methods")
        .update({
          verification_status: "pending_micro_deposit",
          provider_metadata: sanitize({
            ...meta,
            micro_deposit: {
              status: "pending",
              attempts: 0,
              initiated_at: new Date().toISOString(),
              initiated_by: userId,
            },
          }),
        })
        .eq("id", method.id);

      await logPaymentEvent(supabase, {
        tenant_id: null,
        event_type: "platform_bank_account.micro_deposit.initiated",
        new_status: "pending",
        environment,
        provider_metadata: sanitize({ bank_account: bankAccountId }),
      });

      return json({ success: true, payment_method_id: method.id, environment });
    }

    /* ---------------- CONFIRM MICRO-DEPOSIT ---------------- */
    if (action === "confirm_micro_deposit") {
      const methodId = String(body?.payment_method_id ?? "");
      const code = String(body?.code ?? "");
      if (!methodId) return json({ error: "payment_method_id is required" }, 400);
      if (!/^\d{4}$/.test(code)) {
        return json({ error: "Enter the 4-digit verification code." }, 400);
      }

      const { data: method } = await supabase
        .from("payment_provider_methods")
        .select("*")
        .eq("id", methodId)
        .eq("provider", "moov")
        .eq("environment", environment)
        .eq("is_platform", true)
        .is("tenant_id", null)
        .maybeSingle();
      if (!method) return json({ error: "Platform bank account not found." }, 404);
      if (method.provider_account_id !== accountId) return json({ error: "Forbidden" }, 403);

      const bankAccountId = method.provider_bank_account_id as string;
      const meta = (method.provider_metadata as Record<string, unknown>) ?? {};
      const micro = (meta.micro_deposit as any) ?? { status: "pending", attempts: 0 };

      if (micro.status !== "pending") {
        return json({
          error: "verification_not_open",
          message: "No open verification for this bank account. Restart verification.",
        }, 409);
      }
      if ((micro.attempts ?? 0) >= MAX_CODE_ATTEMPTS) {
        return json({
          error: "max_attempts_exceeded",
          requires_restart: true,
          message: "Too many incorrect attempts. Restart verification to receive a new deposit code.",
        }, 409);
      }

      const attempts = (micro.attempts ?? 0) + 1;

      try {
        await moovFetch<any>(
          `/accounts/${accountId}/bank-accounts/${bankAccountId}/verify`,
          {
            method: "PUT",
            scopes: scopes.bankAccountsWrite(accountId),
            body: { code: `MV${code}` },
          },
        );
      } catch (e) {
        const err = e as MoovError;
        const raw = `${err?.message ?? ""}`.toLowerCase();
        const exhausted =
          attempts >= MAX_CODE_ATTEMPTS ||
          (raw.includes("max") && raw.includes("attempt")) ||
          raw.includes("expired");

        await supabase
          .from("payment_provider_methods")
          .update({
            provider_metadata: sanitize({
              ...meta,
              micro_deposit: {
                ...micro,
                attempts,
                status: exhausted ? "max_attempts_exceeded" : "pending",
              },
            }),
          })
          .eq("id", method.id);

        return json({
          error: exhausted ? "max_attempts_exceeded" : "verification_failed",
          requires_restart: exhausted,
          message: exhausted
            ? "Too many incorrect attempts. Restart verification to receive a new deposit code."
            : "That code did not match. Check the $0.01 deposit descriptor and try again.",
          attempts_remaining: Math.max(0, MAX_CODE_ATTEMPTS - attempts),
        }, 409);
      }

      // Re-read the provider so the cached row mirrors it, never overrides it.
      let confirmedStatus = "verified";
      try {
        const bank = await moovFetch<any>(
          `/accounts/${accountId}/bank-accounts/${bankAccountId}`,
          { scopes: scopes.bankAccountsRead(accountId) },
        );
        confirmedStatus = String(bank?.status ?? "verified").toLowerCase();
      } catch {
        /* keep optimistic value */
      }

      await supabase
        .from("payment_provider_methods")
        .update({
          verification_status: confirmedStatus === "verified" ? "verified" : confirmedStatus,
          connection_status: confirmedStatus === "verified" ? "connected" : "pending",
          provider_metadata: sanitize({
            ...meta,
            micro_deposit: { ...micro, attempts, status: "verified", verified_at: new Date().toISOString() },
          }),
        })
        .eq("id", method.id);

      await logPaymentEvent(supabase, {
        tenant_id: null,
        event_type: "platform_bank_account.micro_deposit.verified",
        previous_status: "pending",
        new_status: confirmedStatus,
        environment,
      });

      return json({ success: true, provider_status: confirmedStatus, environment });
    }

    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    console.error("[moov-platform-bank]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
