import { supabase } from "@/integrations/aws/client";

/**
 * Client access to Moov-native treasury sweeps.
 *
 * The provider runs the sweep daily: available balance above the retained
 * minimum is paid out to the settlement bank, and a negative balance is
 * remediated by an ACH debit when a funding method is connected. Nothing is
 * scheduled here — the client only reads and edits the configuration.
 */

export type SweepStatus = "enabled" | "disabled";

export type SweepPushRail =
  | "instant-bank-credit"
  | "rtp-credit"
  | "ach-credit-same-day"
  | "ach-credit-standard";

export const SWEEP_RAIL_LABEL: Record<string, string> = {
  "instant-bank-credit": "Instant (RTP / FedNow)",
  "rtp-credit": "Instant (RTP)",
  "ach-credit-same-day": "Same-day ACH",
  "ach-credit-standard": "Standard ACH",
};

export const SWEEP_RAIL_HINT: Record<string, string> = {
  "instant-bank-credit":
    "Sent over RTP or FedNow when the receiving bank supports it, otherwise standard ACH.",
  "rtp-credit": "Sent over RTP when the receiving bank supports it.",
  "ach-credit-same-day": "Arrives the same banking day when sent before the afternoon cutoff.",
  "ach-credit-standard": "Arrives in one to two banking days.",
};

export interface SweepConfigRow {
  id: string;
  tenant_id: string;
  status: SweepStatus;
  provider_sweep_config_id: string | null;
  provider_wallet_id: string | null;
  push_payment_method_id: string | null;
  push_rail: string | null;
  pull_payment_method_id: string | null;
  minimum_balance_cents: number;
  statement_descriptor: string | null;
  last_synced_at: string | null;
  provider_updated_at: string | null;
}

export interface SweepSnapshot {
  wallet: {
    id: string;
    available_cents: number;
    pending_cents: number;
    status: string;
    wallet_type: string;
  } | null;
  settlement_method: {
    id: string;
    bank_name: string | null;
    last_four: string | null;
    connection_status: string | null;
  } | null;
  available_push_rails: SweepPushRail[];
  pull_available: boolean;
  sweep_config: SweepConfigRow | null;
  /** True when the provider could not be reached and local state is shown. */
  stale?: boolean;
}

export interface SweepExecution {
  sweepID: string;
  status?: string | null;
  accruedAmount?: unknown;
  createdOn?: string | null;
  completedOn?: string | null;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("moov-sweep-config", { body });
  if (error) {
    let message = error.message ?? "Sweep request failed";
    try {
      const parsed = await (error as any).context?.json?.();
      if (parsed?.error) message = parsed.error;
      else if (parsed?.message) message = parsed.message;
    } catch {
      /* keep the original message */
    }
    throw new Error(message);
  }
  if ((data as any)?.error) throw new Error((data as any).error);
  return data as T;
}

export const getSweepSnapshot = (
  tenantId: string,
  walletType = "operating",
  opts?: { force?: boolean },
) =>
  invoke<SweepSnapshot>({
    action: "get",
    tenant_id: tenantId,
    wallet_type: walletType,
    force: !!opts?.force,
  });

export const listRecentSweeps = (tenantId: string, walletType = "operating") =>
  invoke<{ sweeps: SweepExecution[] }>({
    action: "sweeps",
    tenant_id: tenantId,
    wallet_type: walletType,
  });

export interface SweepWriteInput {
  tenantId: string;
  walletType?: string;
  pushRail: SweepPushRail;
  minimumBalanceCents: number;
  statementDescriptor?: string | null;
  status?: SweepStatus;
  enablePull?: boolean;
}

const writeBody = (input: SweepWriteInput, action: string) => ({
  action,
  tenant_id: input.tenantId,
  wallet_type: input.walletType ?? "operating",
  push_rail: input.pushRail,
  minimum_balance_cents: input.minimumBalanceCents,
  statement_descriptor: input.statementDescriptor ?? null,
  status: input.status ?? "enabled",
  enable_pull: input.enablePull ?? true,
});

export const createSweep = (input: SweepWriteInput) =>
  invoke<SweepSnapshot>(writeBody(input, "create"));

export const updateSweep = (input: SweepWriteInput) =>
  invoke<SweepSnapshot>(writeBody(input, "update"));

export const disableSweep = (tenantId: string, walletType = "operating") =>
  invoke<SweepSnapshot>({ action: "disable", tenant_id: tenantId, wallet_type: walletType });

/** Cents from a dollar string typed by a person. Throws on bad input. */
export function dollarsToCents(input: string): number {
  const raw = input.trim().replace(/[$,\s]/g, "");
  if (raw === "") return 0;
  if (!/^\d*(\.\d{0,2})?$/.test(raw)) {
    throw new Error("Enter dollars with at most two decimals.");
  }
  return Math.round(Number(raw) * 100);
}
