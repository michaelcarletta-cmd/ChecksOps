/**
 * Moov-native sweep-config client.
 *
 * Sweep configs are an account-level resource tied to a wallet:
 *   POST   /accounts/{accountID}/sweep-configs
 *   GET    /accounts/{accountID}/sweep-configs
 *   GET    /accounts/{accountID}/sweep-configs/{sweepConfigID}
 *   PATCH  /accounts/{accountID}/sweep-configs/{sweepConfigID}
 *   GET    /accounts/{accountID}/sweeps            (executed sweeps)
 *
 * All of these require the wallets scopes. Moov executes the sweeps daily —
 * ChecksOps never schedules transfers for this itself.
 */

import { moovFetch } from "./moovClient.ts";
import { centsToDecimalString, minimumBalanceToCents, type SweepStatus } from "./sweepRules.ts";

/**
 * Pinned Moov API version for sweep endpoints. Overridable per-environment so
 * we can move forward deliberately instead of inheriting Moov's old default.
 */
export function moovApiVersion(): string {
  return Deno.env.get("MOOV_API_VERSION") ?? "v2024.01.00";
}

export const sweepScopes = {
  read: (id: string) => [`/accounts/${id}/wallets.read`],
  write: (id: string) => [`/accounts/${id}/wallets.write`],
};

export interface MoovSweepConfig {
  sweepConfigID: string;
  walletID: string;
  status: SweepStatus;
  pushPaymentMethodID?: string | null;
  pullPaymentMethodID?: string | null;
  minimumBalance?: unknown;
  statementDescriptor?: string | null;
  createdOn?: string | null;
  updatedOn?: string | null;
}

export interface MoovSweep {
  sweepID: string;
  status?: string | null;
  accruedAmount?: unknown;
  pushPaymentMethodID?: string | null;
  pullPaymentMethodID?: string | null;
  createdOn?: string | null;
  completedOn?: string | null;
  statementDescriptor?: string | null;
}

export interface SweepConfigInput {
  walletId: string;
  pushPaymentMethodId: string;
  pullPaymentMethodId?: string | null;
  minimumBalanceCents: number;
  statementDescriptor?: string | null;
  status: SweepStatus;
}

function body(input: Partial<SweepConfigInput> & { walletId?: string }) {
  const out: Record<string, unknown> = {};
  if (input.walletId) out.walletID = input.walletId;
  if (input.status) out.status = input.status;
  if (input.pushPaymentMethodId) out.pushPaymentMethodID = input.pushPaymentMethodId;
  if (input.pullPaymentMethodId !== undefined) {
    out.pullPaymentMethodID = input.pullPaymentMethodId ?? null;
  }
  if (input.minimumBalanceCents !== undefined) {
    out.minimumBalance = centsToDecimalString(input.minimumBalanceCents);
  }
  if (input.statementDescriptor !== undefined) {
    out.statementDescriptor = input.statementDescriptor ?? null;
  }
  return out;
}

export async function listSweepConfigs(accountId: string): Promise<MoovSweepConfig[]> {
  const res = await moovFetch<MoovSweepConfig[]>(`/accounts/${accountId}/sweep-configs`, {
    scopes: sweepScopes.read(accountId),
    apiVersion: moovApiVersion(),
  });
  return Array.isArray(res) ? res : [];
}

export async function getSweepConfig(
  accountId: string,
  sweepConfigId: string,
): Promise<MoovSweepConfig> {
  return moovFetch<MoovSweepConfig>(
    `/accounts/${accountId}/sweep-configs/${sweepConfigId}`,
    { scopes: sweepScopes.read(accountId), apiVersion: moovApiVersion() },
  );
}

export async function createSweepConfig(
  accountId: string,
  input: SweepConfigInput,
  idempotencyKey?: string,
): Promise<MoovSweepConfig> {
  return moovFetch<MoovSweepConfig>(`/accounts/${accountId}/sweep-configs`, {
    method: "POST",
    scopes: sweepScopes.write(accountId),
    apiVersion: moovApiVersion(),
    idempotencyKey,
    body: body(input),
  });
}

export async function updateSweepConfig(
  accountId: string,
  sweepConfigId: string,
  patch: Partial<SweepConfigInput>,
): Promise<MoovSweepConfig> {
  return moovFetch<MoovSweepConfig>(
    `/accounts/${accountId}/sweep-configs/${sweepConfigId}`,
    {
      method: "PATCH",
      scopes: sweepScopes.write(accountId),
      apiVersion: moovApiVersion(),
      body: body(patch),
    },
  );
}

/**
 * Recent executed sweeps for a wallet. Never throws — sweep history is a
 * reconciliation nicety and must not break the settings screen.
 */
export async function listSweeps(
  accountId: string,
  walletId: string,
  limit = 20,
): Promise<MoovSweep[]> {
  const res = await moovFetch<MoovSweep[]>(
    `/accounts/${accountId}/sweeps?walletID=${encodeURIComponent(walletId)}&count=${limit}`,
    { scopes: sweepScopes.read(accountId), apiVersion: moovApiVersion() },
  ).catch((e) => {
    console.warn("[moovSweeps] sweep history unavailable", (e as Error).message);
    return [] as MoovSweep[];
  });
  return Array.isArray(res) ? res : [];
}

/** Normalizes a Moov config into the shape ChecksOps stores/renders. */
export function normalizeSweepConfig(cfg: MoovSweepConfig) {
  return {
    provider_sweep_config_id: cfg.sweepConfigID,
    provider_wallet_id: cfg.walletID,
    status: String(cfg.status ?? "disabled").toLowerCase() === "enabled" ? "enabled" : "disabled",
    push_payment_method_id: cfg.pushPaymentMethodID ?? null,
    pull_payment_method_id: cfg.pullPaymentMethodID ?? null,
    minimum_balance_cents: minimumBalanceToCents(cfg.minimumBalance),
    statement_descriptor: cfg.statementDescriptor ?? null,
    provider_created_at: cfg.createdOn ?? null,
    provider_updated_at: cfg.updatedOn ?? null,
  };
}
