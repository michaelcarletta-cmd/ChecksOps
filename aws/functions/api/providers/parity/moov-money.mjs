/**
 * Production money-path Moov functions.
 * Source: supabase/functions/moov-transfer-create, moov-wallet-fund,
 * moov-disburse, moov-transfer-group-create, initiate-wallet-funding,
 * process-funded-payment, cancel-wallet-funding, calculate-payment-funding,
 * wallet-fund-on-clear, moov-tenant-fee-charge.
 */
import {
  facilitatorAccountId,
  moovFetch,
  normalizeTransferStatus,
  pendingCapabilities,
  scopes,
} from './moov-client.mjs';
import { fail, jsonResult } from './caller.mjs';
import {
  canSendPayments,
  existingTransferByKey,
  insertTransferDraft,
  loadConnectedMethod,
  loadMoovAccount,
  logPaymentEvent,
  sanitize,
  updateTransferAfterMoov,
} from './db.mjs';
import { railDecisionMetadata, selectRail } from './rail-router.mjs';
import { resolveDebitSourceMethodId, resolveRails, saveMethodRails, saveStakeholderRails } from './moov-rails.mjs';
import { postTransferLedger, syncWallet, writeLedgerEntry } from './moov-wallet.mjs';
import {
  calculateFunding,
  isTerminalFundingStatus,
  loadFundingSettings,
  loadPaymentContext,
  pulledTodayCents,
} from './wallet-funding.mjs';

const envOf = (ctx) => (ctx?.environment === 'production' ? 'production' : 'sandbox');

const postFacilitatorTransfer = async ({ facilitatorHint, sourceMethodId, destMethodId, amount, description, metadata, idempotencyKey, fetchImpl }) => {
  const facilitatorId = await facilitatorAccountId(facilitatorHint, fetchImpl);
  const created = await moovFetch(`/accounts/${facilitatorId}/transfers`, {
    method: 'POST',
    scopes: scopes.transfersWrite(facilitatorId),
    idempotencyKey,
    fetchImpl,
    body: {
      source: { paymentMethodID: sourceMethodId },
      destination: { paymentMethodID: destMethodId },
      amount: { currency: 'USD', value: amount },
      description: String(description || 'ChecksOps payment').slice(0, 128),
      metadata,
    },
  });
  return { created, facilitatorId };
};

export const transferCreate = {
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const tenantId = ctx.tenantId;
    const amount = Number(body.amount_cents);
    if (!Number.isFinite(amount) || amount <= 0) return fail('Amount must be greater than zero.', 400);
    const recipientTenantId = body.recipient_tenant_id || null;
    const externalRecipientId = body.external_recipient_id || null;
    if (!recipientTenantId && !externalRecipientId) return fail('A recipient is required.', 400);
    if (recipientTenantId && externalRecipientId) return fail('Specify exactly one recipient.', 400);
    if (!(await canSendPayments(client, mapping.application_user_id, tenantId, ctx.memberships))) {
      return fail('You do not have permission to send payments.', 403);
    }
    const environment = envOf(ctx);
    const payer = await loadMoovAccount(client, tenantId, environment);
    if (!payer?.provider_account_id) return fail('Set up your payment account first.', 409);
    if (payer.onboarding_status !== 'active') {
      return fail(`Your payment account is not active yet (${payer.onboarding_status}).`, 409);
    }
    if (!payer.can_send_payments || !payer.can_ach_debit) {
      return fail('Your payment account cannot send payments yet.', 409);
    }
    const source = await loadConnectedMethod(client, {
      tenantId, providerAccountId: payer.provider_account_id, environment,
    });
    if (!source) return fail('Connect an eligible business bank account first.', 409);

    let destinationAccountId = null;
    let destinationMethod = null;
    let destinationLabel = '';
    if (recipientTenantId) {
      const payee = await loadMoovAccount(client, recipientTenantId, environment);
      if (!payee?.provider_account_id) return fail('That organization has not finished payment setup.', 409);
      if (!payee.can_receive_payments) return fail('That organization cannot receive payments yet.', 409);
      destinationAccountId = payee.provider_account_id;
      destinationLabel = payee.display_name ?? 'organization';
      destinationMethod = await loadConnectedMethod(client, {
        tenantId: recipientTenantId, providerAccountId: destinationAccountId,
      });
    } else {
      const recipient = (await client.query(
        `SELECT * FROM public.external_payment_recipients
         WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [externalRecipientId, tenantId],
      )).rows[0];
      if (!recipient) return fail('Recipient not found.', 404);
      if (!recipient.provider_account_id) return fail('Recipient setup is not complete.', 409);
      destinationAccountId = recipient.provider_account_id;
      destinationLabel = recipient.display_name;
      destinationMethod = await loadConnectedMethod(client, { externalRecipientId });
    }
    if (!destinationMethod) {
      return fail('recipient_setup_required', 409, {
        message: 'The recipient has not connected a bank account yet.',
      });
    }

    const legacyDestinationMethodId =
      destinationMethod.provider_payment_method_id ?? destinationMethod.provider_bank_account_id;
    const destinationRails = await resolveRails({
      cached: destinationMethod.rail_payment_method_ids,
      syncedAt: destinationMethod.rails_synced_at,
      accountId: destinationAccountId,
      bankAccountId: destinationMethod.provider_bank_account_id ?? null,
      persist: (rails) => saveMethodRails(client, destinationMethod.id, rails),
      fetchImpl,
    });
    const railDecision = selectRail({
      requestedSpeed: body.speed,
      amountCents: amount,
      railPaymentMethodIds: destinationRails,
      fallbackPaymentMethodId: legacyDestinationMethodId,
    });
    const railMeta = railDecisionMetadata(railDecision);
    const key = body.idempotency_key
      ?? `${tenantId}:${destinationAccountId}:${amount}:${body.check_id ?? body.claim_id ?? 'adhoc'}`;
    const existing = await existingTransferByKey(client, tenantId, key);
    if (existing) return jsonResult({ success: true, duplicate: true, transfer: existing });

    const platformFee = Math.max(0, Number(body.platform_fee_cents) || 0);
    let draft;
    try {
      draft = await insertTransferDraft(client, {
        tenant_id: tenantId,
        idempotency_key: key,
        amount_cents: amount,
        platform_fee_cents: platformFee,
        net_amount_cents: amount - platformFee,
        speed: railDecision.selectedSpeed,
        requested_speed: railDecision.requestedSpeed,
        selected_rail: railDecision.railType,
        rail_downgrade_reason: railDecision.downgraded ? railDecision.reason : null,
        description: body.description ?? null,
        source_tenant_account_id: payer.provider_account_id,
        source_payment_method_id: source.id,
        destination_tenant_id: recipientTenantId,
        destination_recipient_id: externalRecipientId,
        destination_payment_method_id: destinationMethod.id,
        claim_id: body.claim_id ?? null,
        check_id: body.check_id ?? null,
        created_by: mapping.application_user_id,
        environment,
      });
    } catch (e) {
      if (/duplicate/i.test(e.message)) return fail('A matching payment was already submitted.', 409);
      throw e;
    }

    const sourceMethodId = await resolveDebitSourceMethodId(client, source, payer.provider_account_id, fetchImpl);
    if (!sourceMethodId) {
      await updateTransferAfterMoov(client, draft.id, {
        status: 'failed', failure_reason: 'No debit-capable payment method on the funding bank account.',
      });
      return fail('Your funding bank account is not set up to send money yet.', 409);
    }

    let created;
    try {
      ({ created } = await postFacilitatorTransfer({
        facilitatorHint: payer.provider_account_id,
        sourceMethodId,
        destMethodId: railDecision.paymentMethodId ?? legacyDestinationMethodId,
        amount,
        description: (body.description ?? `ChecksOps payment to ${destinationLabel}`),
        metadata: {
          checksops_transfer_id: draft.id,
          checksops_tenant_id: tenantId,
          claim_id: body.claim_id ?? '',
          requested_speed: railDecision.requestedSpeed,
          selected_rail: railDecision.railType ?? 'ach-credit-standard',
        },
        idempotencyKey: `checksops-transfer-${draft.id}`,
        fetchImpl,
      }));
    } catch (e) {
      await updateTransferAfterMoov(client, draft.id, { status: 'failed', failure_reason: e.message });
      await logPaymentEvent(client, {
        tenant_id: tenantId, transfer_id: draft.id, event_type: 'transfer.failed',
        previous_status: 'ready', new_status: 'failed', environment,
        provider_metadata: { reason: e.message },
      });
      return fail(e.message, 502, { liveProviderCalled: true });
    }

    const providerTransferId = created?.transferID ?? created?.transferId ?? null;
    const providerStatus = created?.status ?? 'created';
    const status = normalizeTransferStatus(providerStatus);
    const finalTransfer = await updateTransferAfterMoov(client, draft.id, {
      provider_transfer_id: providerTransferId,
      provider_status: providerStatus,
      status,
      provider_fee_cents: created?.facilitatorFee?.total ?? created?.moovFee ?? null,
      provider_metadata: sanitize({ ...(created ?? {}), rail_decision: railMeta }),
    });
    await logPaymentEvent(client, {
      tenant_id: tenantId, recipient_id: externalRecipientId, transfer_id: draft.id,
      provider_transfer_id: providerTransferId, event_type: 'transfer.created',
      previous_status: 'ready', new_status: status, environment,
      provider_metadata: { provider_status: providerStatus, ...railMeta },
    });
    return jsonResult({ success: true, duplicate: false, transfer: finalTransfer, liveProviderCalled: true });
  },
};

export const walletFund = {
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const tenantId = ctx.tenantId;
    const amount = Number(body.amount_cents);
    const walletType = body.wallet_type || 'operating';
    if (!Number.isFinite(amount) || amount <= 0) return fail('Amount must be greater than zero.', 400);
    if (!['operating', 'trust'].includes(walletType)) return fail("wallet_type must be 'operating' or 'trust'", 400);
    if (!(await canSendPayments(client, mapping.application_user_id, tenantId, ctx.memberships))) {
      return fail('You do not have permission to move funds.', 403);
    }
    const environment = envOf(ctx);
    const account = await loadMoovAccount(client, tenantId, environment);
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    if (account.onboarding_status !== 'active') {
      return fail(`Your payment account is not active yet (${account.onboarding_status}).`, 409);
    }
    if (!account.can_ach_debit) return fail('Your payment account cannot pull funds from your bank yet.', 409);
    const source = await loadConnectedMethod(client, {
      tenantId, providerAccountId: account.provider_account_id, environment,
    });
    if (!source) return fail('Connect an eligible business bank account first.', 409);
    const wallet = await syncWallet(client, {
      tenantId, accountId: account.provider_account_id, environment, walletType, fetchImpl,
    });
    if (!wallet.provider_payment_method_id) {
      return fail('Your balance account is not ready to receive funds yet.', 409);
    }
    const key = body.idempotency_key ?? `wallet-fund:${tenantId}:${walletType}:${amount}`;
    const existing = await existingTransferByKey(client, tenantId, key);
    if (existing) return jsonResult({ success: true, duplicate: true, transfer: existing, wallet });
    const draft = await insertTransferDraft(client, {
      tenant_id: tenantId, idempotency_key: key, amount_cents: amount,
      description: body.description ?? 'Balance funding',
      source_tenant_account_id: account.provider_account_id,
      source_payment_method_id: source.id,
      destination_tenant_id: tenantId,
      wallet_id: wallet.id,
      leg_role: 'wallet_funding',
      created_by: mapping.application_user_id,
      environment,
    });
    const sourceMethodId = await resolveDebitSourceMethodId(client, source, account.provider_account_id, fetchImpl);
    if (!sourceMethodId) {
      await updateTransferAfterMoov(client, draft.id, {
        status: 'failed', failure_reason: 'No ach-debit-fund method on the funding bank account.',
      });
      return fail('Your bank account is not set up to fund your balance yet.', 409);
    }
    let created;
    try {
      ({ created } = await postFacilitatorTransfer({
        facilitatorHint: account.provider_account_id,
        sourceMethodId,
        destMethodId: wallet.provider_payment_method_id,
        amount,
        description: body.description ?? 'ChecksOps balance funding',
        metadata: { checksops_transfer_id: draft.id, checksops_tenant_id: tenantId },
        idempotencyKey: `checksops-wallet-fund-${draft.id}`,
        fetchImpl,
      }));
    } catch (e) {
      await updateTransferAfterMoov(client, draft.id, { status: 'failed', failure_reason: e.message });
      return fail(e.message, 502, { liveProviderCalled: true });
    }
    const providerTransferId = created?.transferID ?? created?.transferId ?? null;
    const status = normalizeTransferStatus(created?.status);
    const finalTransfer = await updateTransferAfterMoov(client, draft.id, {
      provider_transfer_id: providerTransferId,
      provider_status: created?.status ?? null,
      status,
      provider_metadata: sanitize(created ?? {}),
    });
    if (status === 'completed') {
      await writeLedgerEntry(client, {
        wallet_id: wallet.id, tenant_id: tenantId, direction: 'credit', entry_type: 'funding',
        amount_cents: amount, sub_ledger_id: body.sub_ledger_id ?? null, transfer_id: draft.id,
        provider_transfer_id: providerTransferId, reference: `transfer:${draft.id}`,
        memo: body.description ?? 'Balance funding', created_by: mapping.application_user_id,
      });
    }
    await logPaymentEvent(client, {
      tenant_id: tenantId, transfer_id: draft.id, provider_transfer_id: providerTransferId,
      event_type: 'wallet.funding.created', new_status: status, environment,
    });
    const refreshed = await syncWallet(client, {
      tenantId, accountId: account.provider_account_id, environment, walletType, fetchImpl,
    }).catch(() => wallet);
    return jsonResult({ success: true, duplicate: false, transfer: finalTransfer, wallet: refreshed, liveProviderCalled: true });
  },
};

export const disburse = {
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const batchId = body?.batch_id;
    if (!batchId || typeof batchId !== 'string') return fail('batch_id is required', 400);
    const batch = (await client.query(
      `SELECT id, tenant_id, status, delivery_speed, check_intake_item_id
       FROM public.disbursement_batches WHERE id = $1::uuid`,
      [batchId],
    )).rows[0];
    if (!batch) return fail('Disbursement batch not found.', 404);
    if (batch.tenant_id !== ctx.tenantId && !ctx.isAdmin) return fail('Forbidden', 403);
    const tenantId = batch.tenant_id;
    const environment = envOf(ctx);
    if (!(await canSendPayments(client, mapping.application_user_id, tenantId, ctx.memberships))) {
      return fail('You do not have permission to send payments.', 403);
    }
    const splits = (await client.query(
      `SELECT s.id, s.amount, s.status, s.moov_transfer_id, s.stakeholder_account_id, s.recipient_name,
              a.id AS acct_id, a.nickname, a.custname, a.provider, a.provider_environment,
              a.provider_account_id, a.provider_bank_account_id,
              a.moov_rail_payment_method_ids, a.moov_rails_synced_at
       FROM public.disbursement_splits s
       LEFT JOIN public.stakeholder_accounts a ON a.id = s.stakeholder_account_id
       WHERE s.batch_id = $1::uuid`,
      [batchId],
    )).rows;
    const payable = (splits ?? []).filter(
      (s) => !s.moov_transfer_id && !['failed', 'cancelled', 'returned'].includes(String(s.status)),
    );
    if (payable.length === 0) return fail('This batch has nothing left to pay out.', 409);
    const payer = await loadMoovAccount(client, tenantId, environment);
    if (!payer?.provider_account_id) {
      return fail('payer_setup_required', 409, { message: 'Set up your payment account first.' });
    }
    if (payer.onboarding_status !== 'active' || !payer.can_send_payments) {
      return fail('payer_setup_required', 409, {
        message: `Your payment account is not ready to send payments yet (${payer.onboarding_status}).`,
      });
    }
    const accountId = payer.provider_account_id;
    const sourceKind = body?.source_kind === 'wallet' ? 'wallet' : 'auto';
    let sourcePaymentMethodId = null;
    if (sourceKind === 'wallet') {
      const wallet = await syncWallet(client, {
        tenantId, accountId, environment, walletType: 'operating', fetchImpl,
      });
      sourcePaymentMethodId = wallet.provider_payment_method_id;
    } else {
      const source = await loadConnectedMethod(client, { tenantId, providerAccountId: accountId, environment });
      if (!source) return fail('Connect an eligible business bank account first.', 409);
      sourcePaymentMethodId = await resolveDebitSourceMethodId(client, source, accountId, fetchImpl);
    }
    if (!sourcePaymentMethodId) return fail('Your funding source is not ready to send money yet.', 409);

    const requestedSpeed = batch.delivery_speed ?? 'standard';
    const resolved = [];
    const unready = [];
    for (const split of payable) {
      const label = split.nickname ?? split.custname ?? split.recipient_name ?? 'recipient';
      const isMoovLinked = split.provider === 'moov'
        && (!split.provider_environment || split.provider_environment === environment)
        && (split.provider_bank_account_id || split.provider_account_id);
      if (!isMoovLinked) { unready.push(label); continue; }
      const cents = Math.round(Number(split.amount) * 100);
      if (!Number.isFinite(cents) || cents <= 0) return fail(`Invalid payout amount for ${label}.`, 400);
      const legacyMethodId = split.provider_bank_account_id ?? split.provider_account_id;
      const rails = await resolveRails({
        cached: split.moov_rail_payment_method_ids,
        syncedAt: split.moov_rails_synced_at,
        accountId: split.provider_account_id ?? null,
        bankAccountId: split.provider_bank_account_id ?? null,
        persist: (r) => saveStakeholderRails(client, split.acct_id, r),
        fetchImpl,
      });
      const decision = selectRail({
        requestedSpeed, amountCents: cents, railPaymentMethodIds: rails, fallbackPaymentMethodId: legacyMethodId,
      });
      if (!decision.paymentMethodId) { unready.push(label); continue; }
      resolved.push({ split, methodId: decision.paymentMethodId, label, cents, decision });
    }
    if (unready.length) {
      return fail('recipient_setup_required', 409, {
        unready,
        message: 'Every recipient must connect a bank account before this batch can be paid.',
      });
    }

    await client.query(
      `UPDATE public.disbursement_batches SET status = 'submitted', rail = 'moov', submitted_at = now() WHERE id = $1::uuid`,
      [batchId],
    );
    let sent = 0;
    let failed = 0;
    const results = [];
    for (const leg of resolved) {
      try {
        const { created } = await postFacilitatorTransfer({
          facilitatorHint: accountId,
          sourceMethodId: sourcePaymentMethodId,
          destMethodId: leg.methodId,
          amount: leg.cents,
          description: `ChecksOps disbursement to ${leg.label}`,
          metadata: {
            checksops_batch_id: batchId,
            checksops_split_id: leg.split.id,
            checksops_tenant_id: tenantId,
            requested_speed: leg.decision.requestedSpeed,
            selected_rail: leg.decision.railType ?? 'ach-credit-standard',
          },
          idempotencyKey: `checksops-disb-split-${leg.split.id}`,
          fetchImpl,
        });
        const transferId = created?.transferID ?? created?.transferId ?? null;
        const status = normalizeTransferStatus(created?.status);
        await client.query(
          `UPDATE public.disbursement_splits SET
             rail = 'moov', requested_speed = $2, selected_rail = $3, rail_downgrade_reason = $4,
             moov_transfer_id = $5, moov_status = $6, status = $7, submitted_at = now()
           WHERE id = $1::uuid`,
          [
            leg.split.id, leg.decision.requestedSpeed, leg.decision.railType,
            leg.decision.downgraded ? leg.decision.reason : null, transferId, status,
            status === 'failed' ? 'failed' : 'submitted',
          ],
        );
        sent += 1;
        results.push({
          split_id: leg.split.id, ok: true, status,
          requested_speed: leg.decision.requestedSpeed, selected_rail: leg.decision.railType,
          downgrade_reason: leg.decision.downgraded ? leg.decision.reason : null,
        });
      } catch (e) {
        let message = e.message;
        if (/403|forbidden/i.test(message)) {
          const pending = await pendingCapabilities(accountId, fetchImpl).catch(() => []);
          message = pending.length
            ? `Your payment account is not approved to move money yet. Pending approval: ${pending.join(', ')}. Finish the payment onboarding requirements, then retry.`
            : 'Your payment account is not approved to move money yet. Finish the payment onboarding requirements, then retry.';
        }
        await client.query(
          `UPDATE public.disbursement_splits SET
             rail = 'moov', status = 'failed', moov_status = 'failed', moov_failure_reason = $2,
             requested_speed = $3, selected_rail = $4
           WHERE id = $1::uuid`,
          [leg.split.id, message, leg.decision.requestedSpeed, leg.decision.railType],
        );
        failed += 1;
        results.push({ split_id: leg.split.id, ok: false, error: message });
      }
    }
    await logPaymentEvent(client, {
      tenant_id: tenantId, event_type: 'disbursement.submitted', environment,
      provider_metadata: { batch_id: batchId, sent, failed },
    });
    return jsonResult({ success: failed === 0, sent, failed, results, liveProviderCalled: true });
  },
};

export const transferGroupCreate = {
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const tenantId = ctx.tenantId;
    const amount = Number(body.amount_cents);
    if (!Number.isFinite(amount) || amount <= 0) return fail('Amount must be greater than zero.', 400);
    if (!(await canSendPayments(client, mapping.application_user_id, tenantId, ctx.memberships))) {
      return fail('You do not have permission to send payments.', 403);
    }
    const legs = Array.isArray(body.legs) ? body.legs : [];
    if (!legs.length) return fail('At least one payout leg is required.', 400);
    return transferCreate.run({
      client, mapping, body: { ...body, amount_cents: amount }, ctx, fetchImpl,
    });
  },
};

export const calculatePaymentFunding = {
  run: async ({ client, mapping, body, ctx }) => {
    if (!body.payment_id) return fail('tenant_id and payment_id are required', 400);
    if (!(await canSendPayments(client, mapping.application_user_id, ctx.tenantId, ctx.memberships))) {
      return fail('You do not have permission to move funds.', 403);
    }
    const payCtx = await loadPaymentContext(client, body.payment_id);
    if (!payCtx) return fail('Payment not found.', 404);
    if (payCtx.batch.tenant_id !== ctx.tenantId) return fail('Forbidden', 403);
    const environment = envOf(ctx);
    const account = await loadMoovAccount(client, ctx.tenantId, environment);
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const settings = await loadFundingSettings(client, ctx.tenantId);
    const wallet = (await client.query(
      `SELECT * FROM public.payment_wallets
       WHERE tenant_id = $1::uuid AND provider = 'moov' AND environment = $2 AND wallet_type = 'operating'
       LIMIT 1`,
      [ctx.tenantId, environment],
    )).rows[0];
    const funding = calculateFunding({
      paymentCents: payCtx.paymentCents,
      availableCents: wallet?.available_cents ?? 0,
      retainCents: settings.retain_cents ?? 0,
    });
    return jsonResult({ success: true, funding, payment_cents: payCtx.paymentCents, liveProviderCalled: false });
  },
};

export const initiateWalletFunding = {
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const tenantId = ctx.tenantId;
    if (!body.payment_id && !body.manual) return fail('payment_id is required', 400);
    if (!(await canSendPayments(client, mapping.application_user_id, tenantId, ctx.memberships))) {
      return fail('You do not have permission to move funds.', 403);
    }
    const amount = Number(body.amount_cents);
    if (body.manual && (!Number.isFinite(amount) || amount <= 0)) {
      return fail('Amount must be greater than zero.', 400);
    }
    const environment = envOf(ctx);
    const account = await loadMoovAccount(client, tenantId, environment);
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    if (!account.can_ach_debit) return fail('Your payment account cannot pull funds from your bank yet.', 409);
    let shortage = amount;
    if (body.payment_id) {
      const payCtx = await loadPaymentContext(client, body.payment_id);
      if (!payCtx) return fail('Payment not found.', 404);
      const settings = await loadFundingSettings(client, tenantId);
      const wallet = await syncWallet(client, {
        tenantId, accountId: account.provider_account_id, environment, fetchImpl,
      });
      const funding = calculateFunding({
        paymentCents: payCtx.paymentCents,
        availableCents: wallet.available_cents,
        retainCents: settings.retain_cents ?? 0,
      });
      if (funding.fully_funded) {
        return jsonResult({ success: true, already_funded: true, funding, liveProviderCalled: false });
      }
      shortage = funding.shortage_cents;
    }
    return walletFund.run({
      client, mapping,
      body: { amount_cents: shortage, wallet_type: 'operating', idempotency_key: body.idempotency_key ?? `initiate-funding:${tenantId}:${body.payment_id || 'manual'}:${shortage}` },
      ctx, fetchImpl,
    });
  },
};

export const cancelWalletFunding = {
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    if (!body.funding_request_id) return fail('tenant_id and funding_request_id are required', 400);
    if (!(await canSendPayments(client, mapping.application_user_id, ctx.tenantId, ctx.memberships))) {
      return fail('You do not have permission to move funds.', 403);
    }
    const request = (await client.query(
      `SELECT * FROM public.wallet_funding_requests WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [body.funding_request_id, ctx.tenantId],
    )).rows[0];
    if (!request) return fail('Funding request not found.', 404);
    if (isTerminalFundingStatus(request.status)) {
      return jsonResult({ success: true, already_final: true, status: request.status });
    }
    let providerStatus = null;
    if (request.moov_transfer_id && request.moov_account_id) {
      try {
        const facilitatorId = await facilitatorAccountId(request.moov_account_id, fetchImpl);
        const live = await moovFetch(`/accounts/${facilitatorId}/transfers/${request.moov_transfer_id}`, {
          scopes: scopes.transfersRead(facilitatorId), fetchImpl,
        });
        providerStatus = live?.status ?? null;
      } catch { providerStatus = null; }
    }
    const inFlight = providerStatus && !['canceled', 'cancelled', 'failed'].includes(providerStatus);
    if (inFlight) {
      if (request.related_payment_id) {
        await client.query(
          `UPDATE public.disbursement_batches SET auto_send_after_funding = false, funding_status = 'action_required' WHERE id = $1::uuid`,
          [request.related_payment_id],
        );
      }
      await client.query(
        `UPDATE public.wallet_funding_requests SET status = 'action_required', failure_code = 'cancel_not_possible',
           failure_reason = 'The bank transfer is already processing and cannot be cancelled.'
         WHERE id = $1::uuid`,
        [body.funding_request_id],
      );
      return jsonResult({
        success: false, code: 'cancel_not_possible',
        message: 'The bank transfer is already processing. The outgoing payment has been held, but the incoming funds will still arrive.',
        liveProviderCalled: true,
      });
    }
    await client.query(
      `UPDATE public.wallet_funding_requests SET status = 'canceled' WHERE id = $1::uuid`,
      [body.funding_request_id],
    );
    return jsonResult({ success: true, status: 'canceled', liveProviderCalled: Boolean(providerStatus) });
  },
};

export const processFundedPayment = {
  run: async ({ client, mapping, body, ctx, fetchImpl, event }) => {
    const fundingRequestId = body.funding_request_id ?? null;
    const paymentIdInput = body.payment_id ?? null;
    if (!fundingRequestId && !paymentIdInput) return fail('funding_request_id or payment_id is required', 400);
    let request = null;
    if (fundingRequestId) {
      request = (await client.query(
        `SELECT * FROM public.wallet_funding_requests WHERE id = $1::uuid`,
        [fundingRequestId],
      )).rows[0];
      if (!request) return fail('Funding request not found.', 404);
      if (request.status !== 'completed') {
        return jsonResult({ success: false, reason: 'funding_not_complete', status: request.status });
      }
    }
    const paymentId = paymentIdInput ?? request?.related_payment_id ?? null;
    if (!paymentId) return jsonResult({ success: true, reason: 'no_payment_attached' });
    const claimed = (await client.query(
      `UPDATE public.disbursement_batches
       SET funding_status = 'sending'
       WHERE id = $1::uuid AND coalesce(funding_status, '') <> 'sent'
       RETURNING *`,
      [paymentId],
    )).rows[0];
    if (!claimed) return jsonResult({ success: true, duplicate: true, reason: 'already_sending_or_sent' });
    return disburse.run({
      client, mapping, body: { batch_id: paymentId, source_kind: 'wallet' }, ctx, fetchImpl, event,
    });
  },
};

export const walletFundOnClear = {
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    if (!body.check_id && !body.deposit_id) return fail('check_id or deposit_id is required', 400);
    return initiateWalletFunding.run({ client, mapping, body: { ...body, manual: true, amount_cents: body.amount_cents }, ctx, fetchImpl });
  },
};

export const tenantFeeCharge = {
  requireAdmin: true,
  run: async ({ client, mapping, body, ctx, fetchImpl }) => {
    const tenantId = body.tenant_id || ctx.tenantId;
    const lines = Array.isArray(body.line_items) ? body.line_items : [];
    const amount = lines.reduce((s, l) => s + Math.max(0, Number(l.amount_cents) || 0), 0) || Number(body.amount_cents);
    if (!Number.isFinite(amount) || amount <= 0) return fail('Amount must be greater than zero.', 400);
    const environment = envOf(ctx);
    const account = await loadMoovAccount(client, tenantId, environment);
    if (!account?.provider_account_id) return fail('Set up your payment account first.', 409);
    const source = await loadConnectedMethod(client, { tenantId, providerAccountId: account.provider_account_id, environment });
    if (!source) return fail('Connect an eligible business bank account first.', 409);
    const sourceMethodId = await resolveDebitSourceMethodId(client, source, account.provider_account_id, fetchImpl);
    const facilitatorId = await facilitatorAccountId(account.provider_account_id, fetchImpl);
    const methods = await moovFetch(`/accounts/${facilitatorId}/payment-methods`, {
      scopes: scopes.paymentMethodsRead(facilitatorId), fetchImpl,
    }).catch(() => []);
    const dest = (methods ?? []).find((m) => m?.paymentMethodType === 'moov-wallet');
    const destId = dest?.paymentMethodID ?? dest?.paymentMethodId;
    if (!sourceMethodId || !destId) return fail('Platform fee destination is not configured.', 409);
    const key = body.idempotency_key ?? `tenant-fee:${tenantId}:${amount}:${body.period || 'adhoc'}`;
    const existing = await existingTransferByKey(client, tenantId, key);
    if (existing) return jsonResult({ success: true, duplicate: true, transfer: existing });
    const draft = await insertTransferDraft(client, {
      tenant_id: tenantId, idempotency_key: key, amount_cents: amount,
      description: body.description ?? 'ChecksOps platform fee',
      source_tenant_account_id: account.provider_account_id,
      source_payment_method_id: source.id,
      leg_role: 'platform_fee',
      created_by: mapping.application_user_id,
      environment,
    });
    let created;
    try {
      ({ created } = await postFacilitatorTransfer({
        facilitatorHint: account.provider_account_id,
        sourceMethodId, destMethodId: destId, amount,
        description: body.description ?? 'ChecksOps platform fee',
        metadata: { checksops_transfer_id: draft.id, checksops_tenant_id: tenantId, kind: 'platform_fee' },
        idempotencyKey: `checksops-fee-${draft.id}`,
        fetchImpl,
      }));
    } catch (e) {
      await updateTransferAfterMoov(client, draft.id, { status: 'failed', failure_reason: e.message });
      return fail(e.message, 502, { liveProviderCalled: true });
    }
    const finalTransfer = await updateTransferAfterMoov(client, draft.id, {
      provider_transfer_id: created?.transferID ?? created?.transferId ?? null,
      provider_status: created?.status ?? null,
      status: normalizeTransferStatus(created?.status),
      provider_metadata: sanitize(created ?? {}),
    });
    return jsonResult({ success: true, transfer: finalTransfer, liveProviderCalled: true });
  },
};

export { postTransferLedger };
