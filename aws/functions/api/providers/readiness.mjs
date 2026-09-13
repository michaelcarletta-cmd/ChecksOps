/** Port of supabase/functions/_shared/moovReadiness.ts. No network calls. */

export const capabilityFamily = (capability) => String(capability ?? '').split('.')[0];

export const findCapability = (caps, wanted) => {
  const family = capabilityFamily(wanted);
  const list = caps ?? [];
  return list.find((item) => String(item.capability).toLowerCase() === wanted.toLowerCase())
    || list.find((item) => capabilityFamily(String(item.capability)).toLowerCase() === family.toLowerCase())
    || null;
};

/** True when Moov already has this family or dotted id — never re-request (KYC/underwriting is billed). */
export const capabilityAlreadyPresent = (caps, wanted) => Boolean(findCapability(caps, wanted));

export const capabilityEnabled = (caps, wanted) => (
  String(findCapability(caps, wanted)?.status || '').toLowerCase() === 'enabled'
);

/**
 * Capabilities that are truly absent. Family match (`send-funds` satisfies
 * `send-funds.ach`) means do not POST. Presence in any status is enough — a
 * pending/errored family is still an underwriting record; re-POST charges again.
 */
export const capabilitiesStillNeeded = (caps, wantedList = []) => (
  (wantedList || []).filter((wanted) => !capabilityAlreadyPresent(caps, wanted))
);

export const capabilityState = (cap) => {
  if (!cap) return 'not_started';
  switch (String(cap.status ?? '').toLowerCase()) {
    case 'enabled':
      return 'ready';
    case 'pending':
    case 'in-review':
    case 'in_review':
      return 'pending';
    case 'errored':
    case 'disconnected':
    case 'rejected':
      return 'action_required';
    default:
      return 'pending';
  }
};

export const currentlyDue = (caps) => Array.from(new Set(
  (caps ?? [])
    .flatMap((item) => item.requirements?.currentlyDue ?? [])
    .filter((item) => typeof item === 'string' && item.length > 0),
));

export const bankState = (banks) => {
  const list = banks ?? [];
  if (!list.length) return 'not_started';
  const statuses = list.map((bank) => String(
    bank.status ?? bank.verification_status ?? bank.connection_status ?? '',
  ).toLowerCase());
  if (statuses.some((status) => status === 'verified')) return 'ready';
  if (statuses.some((status) => status === 'errored' || status === 'failed' || status === 'disconnected')) {
    return 'action_required';
  }
  return 'pending';
};

export const evaluateReadiness = (input) => {
  const checks = [];
  const caps = input.capabilities ?? [];

  if (!input.accountId) {
    checks.push({
      id: 'account',
      label: 'Payment account created',
      state: 'not_started',
      detail: 'No payment account yet.',
    });
  } else {
    checks.push({ id: 'account', label: 'Payment account created', state: 'ready' });
  }

  checks.push({
    id: 'terms_of_service',
    label: 'Terms of service accepted',
    state: input.termsAccepted ? 'ready' : input.accountId ? 'action_required' : 'not_started',
    detail: input.termsAccepted ? null : 'The account holder must accept the provider terms.',
  });

  const verification = String(input.verificationStatus ?? '').toLowerCase();
  const verificationState = input.disabled
    ? 'action_required'
    : verification === 'verified'
      ? 'ready'
      : verification === 'failed' || verification === 'resubmit' || verification === 'errored'
        ? 'action_required'
        : verification === 'pending' || verification === 'review' || verification === 'in-review'
          ? 'pending'
          : input.accountId
            ? 'pending'
            : 'not_started';

  const due = currentlyDue(caps);
  checks.push({
    id: 'identity_verification',
    label: 'Identity & business verification',
    state: due.length > 0 && verificationState !== 'ready' ? 'action_required' : verificationState === 'ready' ? 'ready' : (input.accountId ? 'pending' : 'not_started'),
    detail: input.disabled
      ? 'The provider disabled this account.'
      : verification === 'verified'
        ? 'Identity confirmed.'
        : 'Standard KYC/KYB identity check.',
    requirements: due,
  });

  const sendFunds = findCapability(caps, 'send-funds.ach');
  checks.push({
    id: 'send_funds_ach',
    label: 'Send funds via ACH',
    state: capabilityState(sendFunds),
    detail: sendFunds ? null : 'Standard ACH capability not requested or not yet returned.',
    requirements: sendFunds?.requirements?.currentlyDue ?? [],
  });

  const sameDaySend = findCapability(caps, 'send-funds.ach.same-day');
  if (sameDaySend) {
    checks.push({
      id: 'send_funds_ach_sameday',
      label: 'Same-day ACH Sending',
      state: capabilityState(sameDaySend),
      detail: sameDaySend.status === 'enabled' ? 'Active' : 'Same-day ACH requires additional review.',
    });
  }

  const collectFunds = findCapability(caps, 'collect-funds.ach');
  checks.push({
    id: 'collect_funds_ach',
    label: 'Collect funds via ACH',
    state: capabilityState(collectFunds),
    detail: collectFunds ? null : 'ACH collection not requested or not yet returned.',
    requirements: collectFunds?.requirements?.currentlyDue ?? [],
  });

  const wallet = findCapability(caps, 'wallet.balance');
  checks.push({
    id: 'wallet_balance',
    label: 'Wallet balance (hold funds)',
    state: capabilityState(wallet),
    detail: wallet ? null : 'Enabled automatically by the provider once the account is approved.',
  });

  const bank = bankState(input.banks);
  checks.push({
    id: 'bank_verified',
    label: 'Settlement bank verified',
    state: bank,
    detail: bank === 'pending'
      ? 'Linked, waiting on the provider to complete verification.'
      : bank === 'not_started'
        ? 'No bank connected yet.'
        : null,
  });

  checks.push({
    id: 'fee_plan',
    label: 'Fee plan assigned',
    state: input.feePlanCode ? 'ready' : 'pending',
    detail: input.feePlanCode
      ? `Plan ${input.feePlanCode}`
      : 'Fee plans are provisioned by the payment provider, not self-serve. Onboarding is not blocked by this.',
  });

  const blocking = checks.filter((item) => item.id !== 'fee_plan');
  const canMoveMoney = blocking
    .filter((item) => item.id !== 'wallet_balance' && item.id !== 'send_funds_ach_sameday')
    .every((item) => item.state === 'ready');

  const overall = canMoveMoney
    ? 'ready'
    : blocking.some((item) => item.state === 'action_required')
      ? 'action_required'
      : blocking.some((item) => item.state === 'not_started') && !input.accountId
        ? 'not_started'
        : 'pending';

  return {
    environment: input.environment,
    isSandbox: String(input.environment).toLowerCase() !== 'production',
    source: 'local_snapshot',
    liveProviderCalled: false,
    canMoveMoney,
    overall,
    checks,
    requirements: Array.from(new Set(due)),
  };
};
