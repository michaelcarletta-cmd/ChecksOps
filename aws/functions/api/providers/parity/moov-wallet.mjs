/**
 * Faithful port of supabase/functions/_shared/moovWallet.ts using RDS SQL.
 */
import { moovFetch } from './moov-client.mjs';

const walletScopes = {
  read: (id) => [`/accounts/${id}/wallets.read`],
  write: (id) => [`/accounts/${id}/wallets.write`],
  methods: (id) => [`/accounts/${id}/payment-methods.read`],
};

async function ensureProviderWallet(accountId, walletType, name, knownWalletId, fetchImpl) {
  let list = [];
  try {
    list = await moovFetch(`/accounts/${accountId}/wallets`, {
      scopes: walletScopes.read(accountId),
      fetchImpl,
    });
  } catch (e) {
    if (e.status !== 403) throw e;
  }

  const pinned = knownWalletId
    ? (list ?? []).find((w) => (w?.walletID ?? w?.walletId) === knownWalletId)
    : null;
  const wanted = pinned
    ?? (list ?? []).find((w) => (
      walletType === 'trust'
        ? String(w?.name ?? w?.metadata?.walletType ?? '').toLowerCase().includes('trust')
        : !String(w?.name ?? '').toLowerCase().includes('trust')
    ))
    ?? (walletType === 'operating' ? (list ?? [])[0] : null);

  let wallet = wanted;
  if (!wallet) {
    wallet = await moovFetch(`/accounts/${accountId}/wallets`, {
      method: 'POST',
      scopes: walletScopes.write(accountId),
      body: { name, description: `ChecksOps ${walletType} wallet` },
      fetchImpl,
    });
  }

  const available = wallet?.availableBalance?.valueDecimal
    ? Math.round(Number(wallet.availableBalance.valueDecimal) * 100)
    : Number(wallet?.availableBalance?.value ?? 0);
  const pending = Number(wallet?.pendingBalance?.value ?? 0);
  return {
    walletID: wallet?.walletID ?? wallet?.walletId,
    availableCents: Number.isFinite(available) ? available : 0,
    pendingCents: Number.isFinite(pending) ? pending : 0,
  };
}

export async function walletPaymentMethodId(accountId, walletId, fetchImpl) {
  const methods = await moovFetch(`/accounts/${accountId}/payment-methods`, {
    scopes: walletScopes.methods(accountId),
    fetchImpl,
  });
  const match = (methods ?? []).find(
    (m) => m?.paymentMethodType === 'moov-wallet'
      && (m?.wallet?.walletID ?? m?.wallet?.walletId) === walletId,
  );
  return match?.paymentMethodID ?? match?.paymentMethodId ?? null;
}

export async function readWallet(client, tenantId, environment, walletType = 'operating') {
  const row = (await client.query(
    `SELECT * FROM public.payment_wallets
     WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2 AND wallet_type = $3
     LIMIT 1`,
    [tenantId, environment, walletType],
  )).rows[0];
  return row || null;
}

export async function syncWallet(client, args) {
  const walletType = args.walletType ?? 'operating';
  const name = walletType === 'trust' ? 'Trust wallet' : 'Operating wallet';
  const existing = await readWallet(client, args.tenantId, args.environment, walletType);
  let providerWalletId = existing?.provider_wallet_id;
  let availableCents = existing?.available_cents ?? 0;
  let pendingCents = existing?.pending_cents ?? 0;

  if (!args.skipProviderFetch || !providerWalletId) {
    const provider = await ensureProviderWallet(
      args.accountId, walletType, name, providerWalletId, args.fetchImpl,
    );
    providerWalletId = provider.walletID;
    availableCents = provider.availableCents;
    pendingCents = provider.pendingCents;
  }

  const pmId = providerWalletId
    ? await walletPaymentMethodId(args.accountId, providerWalletId, args.fetchImpl)
    : null;

  const saved = (await client.query(
    `INSERT INTO public.payment_wallets
      (tenant_id, provider, environment, wallet_type, name, provider_wallet_id,
       provider_account_id, provider_payment_method_id, available_cents, pending_cents,
       status, last_synced_at)
     VALUES ($1::uuid, 'moov', $2, $3, $4, $5, $6, $7, $8, $9, 'active', now())
     ON CONFLICT (tenant_id, provider, environment, wallet_type) DO UPDATE SET
       provider_wallet_id = EXCLUDED.provider_wallet_id,
       provider_account_id = EXCLUDED.provider_account_id,
       provider_payment_method_id = EXCLUDED.provider_payment_method_id,
       available_cents = EXCLUDED.available_cents,
       pending_cents = EXCLUDED.pending_cents,
       status = 'active',
       last_synced_at = now()
     RETURNING *`,
    [args.tenantId, args.environment, walletType, name, providerWalletId ?? null,
      args.accountId, pmId, availableCents, pendingCents],
  )).rows[0];
  return saved;
}

export async function writeLedgerEntry(client, entry) {
  try {
    await client.query(
      `INSERT INTO public.payment_wallet_ledger
        (wallet_id, tenant_id, direction, entry_type, amount_cents, sub_ledger_id,
         transfer_id, transfer_group_id, claim_id, check_id, provider_transfer_id,
         reference, memo, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        entry.wallet_id, entry.tenant_id, entry.direction, entry.entry_type, entry.amount_cents,
        entry.sub_ledger_id ?? null, entry.transfer_id ?? null, entry.transfer_group_id ?? null,
        entry.claim_id ?? null, entry.check_id ?? null, entry.provider_transfer_id ?? null,
        entry.reference ?? null, entry.memo ?? null, entry.created_by ?? null,
      ],
    );
    return { applied: true };
  } catch (error) {
    if (error.code === '23505') return { applied: false };
    return { applied: false, error: error.message };
  }
}

export async function postTransferLedger(client, transfer, status, providerTransferId) {
  if (!transfer.wallet_id) return;
  const amount = Number(transfer.amount_cents || 0);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const incoming = transfer.leg_role === 'wallet_funding' || transfer.leg_role === 'parent';
  if (status === 'completed') {
    await writeLedgerEntry(client, {
      wallet_id: transfer.wallet_id,
      tenant_id: transfer.tenant_id,
      direction: incoming ? 'credit' : 'debit',
      entry_type: incoming ? (transfer.leg_role === 'parent' ? 'settlement_received' : 'funding') : 'payout',
      amount_cents: amount,
      transfer_id: transfer.id,
      transfer_group_id: transfer.transfer_group_id ?? null,
      claim_id: transfer.claim_id ?? null,
      check_id: transfer.check_id ?? null,
      provider_transfer_id: providerTransferId ?? null,
      reference: `transfer:${transfer.id}`,
      memo: transfer.description ?? null,
    });
    return;
  }
  if (['failed', 'returned', 'reversed', 'canceled', 'cancelled'].includes(status)) {
    const posted = (await client.query(
      `SELECT id FROM public.payment_wallet_ledger WHERE reference = $1 LIMIT 1`,
      [`transfer:${transfer.id}`],
    )).rows[0];
    if (!posted) return;
    await writeLedgerEntry(client, {
      wallet_id: transfer.wallet_id,
      tenant_id: transfer.tenant_id,
      direction: incoming ? 'debit' : 'credit',
      entry_type: 'reversal',
      amount_cents: amount,
      transfer_id: transfer.id,
      transfer_group_id: transfer.transfer_group_id ?? null,
      claim_id: transfer.claim_id ?? null,
      check_id: transfer.check_id ?? null,
      provider_transfer_id: providerTransferId ?? null,
      reference: `transfer:${transfer.id}:reversal`,
      memo: `Reversed (${status})${transfer.description ? ` — ${transfer.description}` : ''}`,
    });
  }
}
