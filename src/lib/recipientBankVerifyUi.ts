export type BankVerifyView =
  | 'loading'
  | 'hidden'
  | 'unavailable'
  | 'initiate'
  | 'pending_confirm'
  | 'verified'
  | 'complete';

type SessionLike = {
  onboarding?: {
    terms_accepted?: boolean;
    verification_status?: string;
    identity_requirements_outstanding?: string[];
    identity_requirements_known?: boolean;
    bank_verified?: boolean;
    bank_can_confirm?: boolean;
    bank_should_initiate?: boolean;
    bank_micro_deposits_initiated?: boolean;
    bank_verify_available?: boolean;
    complete?: boolean;
  } | null;
} | null;

export function bankVerifyView(
  session: SessionLike,
  { loading = false }: { loading?: boolean } = {},
): BankVerifyView {
  if (loading) return 'loading';
  if (!session) return 'hidden';
  if (session.onboarding?.complete === true) return 'complete';
  const verified = session.onboarding?.verification_status === 'verified';
  const termsAccepted = Boolean(session.onboarding?.terms_accepted);
  const identityOutstanding = session.onboarding?.identity_requirements_outstanding ?? [];
  const identityKnown = session.onboarding?.identity_requirements_known === true;
  const needsIdentity = identityKnown ? identityOutstanding.length > 0 : !verified;
  if (needsIdentity || !termsAccepted) return 'hidden';
  if (session.onboarding?.bank_verified === true) return 'verified';
  if (session.onboarding?.bank_verify_available !== true) return 'unavailable';
  const canConfirm = session.onboarding?.bank_can_confirm === true
    || session.onboarding?.bank_micro_deposits_initiated === true;
  if (canConfirm) return 'pending_confirm';
  if (session.onboarding?.bank_should_initiate === true) return 'initiate';
  return 'unavailable';
}

export function bankVerifyInitiateEnabled(view: BankVerifyView, saving = false): boolean {
  return view === 'initiate' && !saving;
}

export function bankVerifyConfirmEnabled(view: BankVerifyView, saving = false, codeLength = 0): boolean {
  return view === 'pending_confirm' && !saving && codeLength === 4;
}

export function mapRecipientPublicError(error?: string | null, message?: string | null): string {
  const code = String(error || '').trim();
  if (code === 'recipient_bank_verify_writes_blocked') {
    return 'Bank verification is not available yet.';
  }
  if (code === 'max_attempts_exceeded') {
    return 'Too many incorrect attempts. Wait and restart verification to receive a new deposit code.';
  }
  if (code === 'recipient_token_rate_limited') {
    return 'Too many attempts. Try again later.';
  }
  if (code === 'verification_failed' || code === 'invalid_code') {
    return message || 'That code did not match. Check the $0.01 deposit descriptor and try again.';
  }
  if (code === 'initiate_uncertain') {
    return message || 'The payment provider did not confirm initiation. Verification was not retried.';
  }
  if (code === 'provider_execution_blocked') {
    return 'Transfers and other money movement stay blocked.';
  }
  return String(message || error || 'Request failed');
}
