import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, isResponse, json, logPaymentEvent, requireMoovCaller, sanitize } from "../_shared/moovGuard.ts";
import { readWallet, syncWallet } from "../_shared/moovWallet.ts";
import {
  createSweepConfig,
  getSweepConfig,
  listSweepConfigs,
  listSweeps,
  normalizeSweepConfig,
  updateSweepConfig,
} from "../_shared/moovSweeps.ts";
import {
  availablePushRails,
  normalizeStatementDescriptor,
  parseMinimumBalanceCents,
  selectSweepPullMethod,
  selectSweepPushMethod,
  SWEEP_PULL_RAIL,
} from "../_shared/sweepRules.ts";

/**
 * Moov-native Treasury & Sweeps.
 *
 * Moov owns the schedule: once a sweep config is enabled it executes daily,
 * pushing available wallet funds above the retained minimum balance to the
 * organization's settlement bank, and pulling via `ach-debit-fund` to
 * remediate a negative balance. This function only reads and writes that
 * config — it never moves money itself.
 *
 * Actions: get | create | update | disable | sweeps
 */

type Action = "get" | "create" | "update" | "disable" | "sweeps";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "get") as Action;
    const tenantId = body?.tenant_id as string | undefined;
    const walletType = (body?.wallet_type ?? "operating") as "operating" | "trust";

    if (!tenantId) return json({ error: "tenant_id is required" }, 400);
    if (!["operating", "trust"].includes(walletType)) {
      return json({ error: "wallet_type must be 'operating' or 'trust'" }, 400);
    }
    if (!["get", "create", "update", "disable", "sweeps"].includes(action)) {
      return json({ error: "Unknown action" }, 400);
    }

    // Reads are open to tenant members; anything that changes money movement
    // is administrator-only.
    const isWrite = action !== "get" && action !== "sweeps";
    const caller = await requireMoovCaller(req, tenantId, { requireAdmin: isWrite });
    if (isResponse(caller)) return caller;
    const { supabase, environment, userId } = caller;

    const { data: account } = await supabase
      .from("payment_provider_accounts")
      .select("provider_account_id")
      .eq("tenant_id", tenantId)
      .eq("provider", "moov")
      .eq("environment", environment)
      .maybeSingle();

    const accountId = account?.provider_account_id as string | undefined;
    if (!accountId) return json({ error: "Set up your payment account first." }, 409);

    // Wallet — refresh from Moov, fall back to the last known local row.
    let wallet = await syncWallet(supabase, {
      tenantId,
      accountId,
      environment,
      walletType,
    }).catch(async () => await readWallet(supabase, tenantId, environment, walletType));

    if (!wallet?.provider_wallet_id) {
      return json({ error: "Your balance is not ready to receive funds yet." }, 409);
    }

    // Settlement bank method + Phase 1 rail eligibility for this tenant.
    const { data: methods } = await supabase
      .from("payment_provider_methods")
      .select(
        "id, provider_payment_method_id, provider_bank_account_id, bank_name, last_four, is_default, connection_status, supported_rails, rail_payment_method_ids, rails_synced_at",
      )
      .eq("tenant_id", tenantId)
      .eq("provider", "moov")
      .eq("environment", environment)
      .is("external_recipient_id", null)
      .order("is_default", { ascending: false });

    const method = (methods ?? [])[0] ?? null;
    const railSource = {
      railPaymentMethodIds: (method?.rail_payment_method_ids ?? {}) as Record<string, string>,
      supportedRails: (method?.supported_rails ?? []) as string[],
    };
    const pushRails = availablePushRails(railSource);
    const pullMethodId = selectSweepPullMethod(railSource);

    const localRow = async () => {
      const { data } = await supabase
        .from("payment_sweep_configs")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("provider", "moov")
        .eq("environment", environment)
        .eq("provider_wallet_id", wallet!.provider_wallet_id)
        .maybeSingle();
      return data ?? null;
    };

    const persist = async (cfg: ReturnType<typeof normalizeSweepConfig>, pushRail: string | null) => {
      const payload = {
        tenant_id: tenantId,
        provider: "moov",
        environment,
        wallet_id: wallet!.id,
        provider_account_id: accountId,
        push_rail: pushRail,
        pull_rail: cfg.pull_payment_method_id ? SWEEP_PULL_RAIL : null,
        last_synced_at: new Date().toISOString(),
        last_error: null,
        ...cfg,
      };
      const { data, error } = await supabase
        .from("payment_sweep_configs")
        .upsert(payload, { onConflict: "tenant_id,provider,environment,provider_wallet_id" })
        .select()
        .maybeSingle();
      if (error) {
        // Never fail a money-configuration call because of a cache write.
        console.error("[moov-sweep-config] persist failed", error.message);
        return payload;
      }
      return data;
    };

    const respond = async (row: unknown, extra: Record<string, unknown> = {}) =>
      json({
        success: true,
        wallet: {
          id: wallet!.id,
          available_cents: wallet!.available_cents,
          pending_cents: wallet!.pending_cents,
          status: wallet!.status,
          wallet_type: walletType,
        },
        settlement_method: method
          ? {
            id: method.id,
            bank_name: method.bank_name,
            last_four: method.last_four,
            connection_status: method.connection_status,
          }
          : null,
        available_push_rails: pushRails,
        pull_available: !!pullMethodId,
        sweep_config: row,
        ...extra,
      });

    /* ----------------------------- read ----------------------------- */
    if (action === "get") {
      const remote = await listSweepConfigs(accountId).catch((e) => {
        console.warn("[moov-sweep-config] list failed", (e as Error).message);
        return null;
      });

      if (remote) {
        const match = remote.find((c) => c.walletID === wallet!.provider_wallet_id) ?? null;
        if (match) {
          const normalized = normalizeSweepConfig(match);
          const pushRail = railTypeFor(railSource, normalized.push_payment_method_id);
          return await respond(await persist(normalized, pushRail));
        }
        // Moov has no config for this wallet — clear a stale local row.
        const existing = await localRow();
        if (existing) {
          await supabase
            .from("payment_sweep_configs")
            .update({ status: "disabled", last_synced_at: new Date().toISOString() })
            .eq("id", existing.id);
        }
        return await respond(existing ? { ...existing, status: "disabled" } : null);
      }

      return await respond(await localRow(), { stale: true });
    }

    if (action === "sweeps") {
      const sweeps = await listSweeps(accountId, wallet.provider_wallet_id, 20);
      return json({ success: true, sweeps: sanitize(sweeps) });
    }

    /* ----------------------------- writes ---------------------------- */
    const existing = await localRow();

    if (action === "disable") {
      const configId = existing?.provider_sweep_config_id;
      if (!configId) return json({ error: "There is no sweep to turn off." }, 404);

      const updated = await updateSweepConfig(accountId, configId, { status: "disabled" });
      const row = await persist(
        normalizeSweepConfig(updated),
        existing?.push_rail ?? null,
      );
      await logPaymentEvent(supabase, {
        tenant_id: tenantId,
        event_type: "sweep_config.disabled",
        environment,
        provider_metadata: { sweep_config_id: configId, actor: userId },
      });
      return await respond(row);
    }

    // create / update share the same validated input.
    let minimumBalanceCents: number;
    let statementDescriptor: string | null;
    try {
      minimumBalanceCents = parseMinimumBalanceCents(
        body?.minimum_balance_cents !== undefined
          ? Number(body.minimum_balance_cents) / 100
          : body?.minimum_balance,
      );
      statementDescriptor = normalizeStatementDescriptor(body?.statement_descriptor);
    } catch (e) {
      return json({ error: (e as Error).message }, 400);
    }

    const push = selectSweepPushMethod(railSource, body?.push_rail ?? null);
    if (!push.paymentMethodId || !push.railType) {
      return json(
        {
          error:
            push.reason === "no_push_rail_available"
              ? "Connect and verify a settlement bank account before turning on sweeps."
              : "That payout speed is not available on your settlement bank account.",
          reason: push.reason,
          available_push_rails: pushRails,
        },
        400,
      );
    }

    const input = {
      walletId: wallet.provider_wallet_id,
      pushPaymentMethodId: push.paymentMethodId,
      pullPaymentMethodId: body?.enable_pull === false ? null : pullMethodId,
      minimumBalanceCents,
      statementDescriptor,
      status: (body?.status === "disabled" ? "disabled" : "enabled") as "enabled" | "disabled",
    };

    let result;
    if (action === "create") {
      // Idempotent: if Moov already has a config for this wallet, patch it
      // rather than creating a duplicate.
      const remote = await listSweepConfigs(accountId).catch(() => [] as any[]);
      const match = remote.find((c: any) => c.walletID === wallet!.provider_wallet_id);
      result = match
        ? await updateSweepConfig(accountId, match.sweepConfigID, input)
        : await createSweepConfig(
          accountId,
          input,
          `sweep-${tenantId}-${wallet.provider_wallet_id}`,
        );
    } else {
      const configId = existing?.provider_sweep_config_id;
      if (!configId) return json({ error: "No sweep is configured yet." }, 404);
      result = await updateSweepConfig(accountId, configId, input);
    }

    const row = await persist(normalizeSweepConfig(result), push.railType);
    await logPaymentEvent(supabase, {
      tenant_id: tenantId,
      event_type: `sweep_config.${action}d`,
      environment,
      provider_metadata: {
        sweep_config_id: (result as any)?.sweepConfigID ?? null,
        push_rail: push.railType,
        minimum_balance_cents: minimumBalanceCents,
        pull_configured: !!input.pullPaymentMethodId,
        actor: userId,
      },
    });

    return await respond(row);
  } catch (e) {
    const message = (e as Error).message ?? "Sweep configuration failed";
    console.error("[moov-sweep-config]", message);
    return json({ error: message }, 500);
  }
});

/** Reverse-maps a Moov paymentMethodID back to its rail type, when known. */
function railTypeFor(
  src: { railPaymentMethodIds?: Record<string, string> | null },
  paymentMethodId: string | null,
): string | null {
  if (!paymentMethodId) return null;
  for (const [rail, id] of Object.entries(src.railPaymentMethodIds ?? {})) {
    if (id === paymentMethodId) return rail;
  }
  return null;
}
