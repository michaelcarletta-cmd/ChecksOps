import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { moovFetch, moovConfigured, moovEnvironment } from "../_shared/moovClient.ts";
import { corsHeaders, json, moovGloballyEnabled, serviceClient } from "../_shared/moovGuard.ts";

/**
 * Platform (master merchant) treasury: the ChecksOps facilitator wallet and a
 * platform-wide profit & loss roll-up.
 *
 * Tenants see their own balance and revenue in Payments; this is the same view
 * for the platform itself. Access is restricted to the platform owner login,
 * because it exposes money movement across every organization.
 */

const PLATFORM_OWNER_EMAIL = "checksopsadmin@gmail.com";

type Authed = { userId: string; supabase: ReturnType<typeof serviceClient> };

async function requirePlatformOwner(req: Request): Promise<Authed | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) return json({ error: "Unauthorized" }, 401);

  const email = (data.user.email ?? "").trim().toLowerCase();
  if (email !== PLATFORM_OWNER_EMAIL) {
    return json({ error: "Platform owner access required." }, 403);
  }
  return { userId: data.user.id, supabase: serviceClient() };
}

function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}

function centsFromBalance(b: any): number {
  if (!b) return 0;
  if (b.valueDecimal != null) return Math.round(Number(b.valueDecimal) * 100);
  return Number(b.value ?? 0);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const caller = await requirePlatformOwner(req);
    if (isResponse(caller)) return caller;
    const { supabase } = caller;

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "overview");
    const environment = moovEnvironment();
    const accountId = Deno.env.get("MOOV_PLATFORM_ACCOUNT_ID") ?? null;

    /* ---------------- WALLET ---------------- */
    const walletPayload = async () => {
      const warnings: string[] = [];
      if (!moovGloballyEnabled() || !moovConfigured() || !accountId) {
        return {
          available_cents: 0,
          pending_cents: 0,
          wallet_id: null,
          transactions: [],
          setup_required: true,
          warnings: ["Platform payment account is not configured yet."],
        };
      }

      let wallets: any[] = [];
      try {
        wallets = await moovFetch<any[]>(`/accounts/${accountId}/wallets`, {
          scopes: [`/accounts/${accountId}/wallets.read`],
        });
      } catch (e) {
        warnings.push(`wallets: ${(e as Error).message}`);
      }

      const wallet = (wallets ?? [])[0] ?? null;
      const walletId = wallet?.walletID ?? wallet?.walletId ?? null;

      let transactions: any[] = [];
      if (walletId) {
        try {
          transactions = await moovFetch<any[]>(
            `/accounts/${accountId}/wallets/${walletId}/transactions?count=25`,
            { scopes: [`/accounts/${accountId}/wallets.read`] },
          );
        } catch (e) {
          warnings.push(`transactions: ${(e as Error).message}`);
        }
      }

      return {
        wallet_id: walletId,
        available_cents: centsFromBalance(wallet?.availableBalance),
        pending_cents: centsFromBalance(wallet?.pendingBalance),
        currency: wallet?.availableBalance?.currency ?? "USD",
        setup_required: !walletId,
        transactions: (transactions ?? []).map((t: any) => ({
          id: t.walletTransactionID ?? t.transactionID ?? null,
          type: t.transactionType ?? null,
          status: t.status ?? null,
          amount_cents: Number(t.grossAmount ?? t.netAmount ?? 0),
          available_balance_cents: Number(t.availableBalance ?? 0),
          created_at: t.createdOn ?? t.completedOn ?? null,
          memo: t.memo ?? t.sourceType ?? null,
        })),
        warnings,
      };
    };

    /* ---------------- PROFIT & LOSS ---------------- */
    const pnlPayload = async () => {
      const since = new Date();
      since.setMonth(since.getMonth() - 11);
      since.setDate(1);
      const sinceIso = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1)).toISOString();

      const [{ data: tenants }, { data: fees }, { data: transfers }] = await Promise.all([
        supabase.from("tenants").select("id, name"),
        supabase
          .from("platform_fee_line_items")
          .select("tenant_id, amount_cents, occurred_at, fee_code, status")
          .gte("occurred_at", sinceIso),
        supabase
          .from("payment_transfers")
          .select(
            "tenant_id, amount_cents, provider_fee_cents, platform_fee_cents, status, created_at, leg_role",
          )
          .gte("created_at", sinceIso),
      ]);

      const nameById = new Map((tenants ?? []).map((t: any) => [t.id, t.name]));
      const month = (iso: string | null) => (iso ? String(iso).slice(0, 7) : "unknown");

      type Bucket = {
        fees_cents: number;
        transfer_fees_cents: number;
        provider_cost_cents: number;
        volume_cents: number;
        transfer_count: number;
      };
      const empty = (): Bucket => ({
        fees_cents: 0,
        transfer_fees_cents: 0,
        provider_cost_cents: 0,
        volume_cents: 0,
        transfer_count: 0,
      });

      const byMonth = new Map<string, Bucket>();
      const byTenant = new Map<string, Bucket>();
      const bump = (map: Map<string, Bucket>, key: string) => {
        if (!map.has(key)) map.set(key, empty());
        return map.get(key)!;
      };

      for (const f of fees ?? []) {
        if (String(f.status ?? "").toLowerCase() === "void") continue;
        const amt = Number(f.amount_cents ?? 0);
        bump(byMonth, month(f.occurred_at)).fees_cents += amt;
        bump(byTenant, f.tenant_id ?? "unassigned").fees_cents += amt;
      }

      for (const t of transfers ?? []) {
        const status = String(t.status ?? "").toLowerCase();
        if (["failed", "cancelled", "canceled"].includes(status)) continue;
        const m = bump(byMonth, month(t.created_at));
        const tn = bump(byTenant, t.tenant_id ?? "unassigned");
        for (const b of [m, tn]) {
          b.transfer_fees_cents += Number(t.platform_fee_cents ?? 0);
          b.provider_cost_cents += Number(t.provider_fee_cents ?? 0);
          b.volume_cents += Number(t.amount_cents ?? 0);
          b.transfer_count += 1;
        }
      }

      const shape = (b: Bucket) => {
        const revenue = b.fees_cents + b.transfer_fees_cents;
        return {
          ...b,
          revenue_cents: revenue,
          profit_cents: revenue - b.provider_cost_cents,
        };
      };

      const months = [...byMonth.entries()]
        .filter(([k]) => k !== "unknown")
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([m, b]) => ({ month: m, ...shape(b) }));

      const tenantRows = [...byTenant.entries()]
        .map(([id, b]) => ({
          tenant_id: id,
          tenant_name: nameById.get(id) ?? "Unassigned",
          ...shape(b),
        }))
        .sort((a, b) => b.revenue_cents - a.revenue_cents);

      const totals = shape(
        [...byTenant.values()].reduce((acc, b) => {
          acc.fees_cents += b.fees_cents;
          acc.transfer_fees_cents += b.transfer_fees_cents;
          acc.provider_cost_cents += b.provider_cost_cents;
          acc.volume_cents += b.volume_cents;
          acc.transfer_count += b.transfer_count;
          return acc;
        }, empty()),
      );

      return { since: sinceIso, totals, months, tenants: tenantRows };
    };

    if (action === "wallet") {
      return json({ success: true, environment, platform_account_id: accountId, wallet: await walletPayload() });
    }
    if (action === "pnl") {
      return json({ success: true, environment, pnl: await pnlPayload() });
    }

    const [wallet, pnl] = await Promise.all([walletPayload(), pnlPayload()]);
    return json({ success: true, environment, platform_account_id: accountId, wallet, pnl });
  } catch (e) {
    console.error("[platform-treasury]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
