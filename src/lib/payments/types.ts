/**
 * Provider-agnostic payment domain model.
 *
 * Nothing in here knows about Actum, Plaid, or Moov. Providers implement the
 * `PaymentProvider` interface below; business logic and UI only ever talk to
 * the interface and these types.
 */

export type PaymentProviderId = "actum" | "plaid" | "moov";

/** Lifecycle of a tenant's connected payment account. */
export type PaymentAccountStatus =
  | "not_connected"
  | "pending_verification"
  | "verification_required"
  | "active"
  | "suspended";

/** Lifecycle of the tenant's connected business bank account. */
export type BankConnectionStatus =
  | "not_connected"
  | "pending"
  | "connected"
  | "failed";

/** KYB/KYC state. Placeholder until a provider actually reports it. */
export type VerificationStatus =
  | "not_started"
  | "business_pending"
  | "owner_pending"
  | "verified"
  | "rejected";

export type PaymentSpeed = "standard" | "same_day" | "instant";

export type PaymentStatus =
  | "draft"
  | "submitted"
  | "pending"
  | "settled"
  | "failed"
  | "returned"
  | "cancelled";

/** A recipient that is itself an organization on (or known to) the platform. */
export interface BusinessRecipient {
  kind: "business";
  id: string;
  /** Set when the business is a ChecksOps tenant. */
  tenantId?: string | null;
  name: string;
  email?: string | null;
  phone?: string | null;
  role?: "tenant" | "contractor" | "vendor";
  /** Provider-agnostic reference to the recipient's stored bank account. */
  bankAccountId?: string | null;
}

/** A recipient outside the platform — homeowner, one-time payee, etc. */
export interface ExternalRecipient {
  kind: "external";
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  relationship?: "homeowner" | "one_time" | "other";
  bankAccountId?: string | null;
}

export type Recipient = BusinessRecipient | ExternalRecipient;

export interface PaymentAccount {
  tenantId: string;
  provider: PaymentProviderId;
  /** Provider-side account identifier, when one exists. */
  externalAccountId: string | null;
  status: PaymentAccountStatus;
  verificationStatus: VerificationStatus;
  bankConnectionStatus: BankConnectionStatus;
  bankName: string | null;
  bankLastFour: string | null;
  lastSync: string | null;
}

export interface SendPaymentInput {
  tenantId: string;
  recipient: Recipient;
  amountCents: number;
  speed: PaymentSpeed;
  description?: string;
  /** Optional linkage back to the claim/check that funded this payment. */
  checkId?: string | null;
  claimId?: string | null;
  idempotencyKey?: string;
}

export interface PaymentResult {
  id: string;
  provider: PaymentProviderId;
  status: PaymentStatus;
  amountCents: number;
  speed: PaymentSpeed;
  /** Provider-side transfer/transaction id. */
  externalId?: string | null;
  error?: string | null;
}

export interface PaymentHistoryQuery {
  tenantId: string;
  limit?: number;
  since?: string;
  recipientId?: string;
}

export interface ConnectBankInput {
  tenantId: string;
  /** Provider-agnostic account row the connection should attach to. */
  bankAccountId?: string | null;
  /** Where the provider should return the user after a hosted flow. */
  returnUrl?: string;
}

export interface ConnectBankResult {
  /** Hosted link to open, when the provider uses a redirect/widget flow. */
  url?: string | null;
  /** Short-lived token for an embedded widget flow. */
  token?: string | null;
  status: BankConnectionStatus;
}

export interface CreateTenantAccountInput {
  tenantId: string;
  legalName: string;
  email?: string | null;
  phone?: string | null;
}

/**
 * Every payment rail implements this. Unsupported operations should throw
 * `PaymentProviderUnsupported` rather than silently succeeding.
 */
export interface PaymentProvider {
  readonly id: PaymentProviderId;
  /** Human label used in logs only — the UI stays provider-neutral. */
  readonly label: string;

  createTenantAccount(input: CreateTenantAccountInput): Promise<PaymentAccount>;
  connectBank(input: ConnectBankInput): Promise<ConnectBankResult>;
  verifyAccount(tenantId: string): Promise<PaymentAccount>;
  getAccount(tenantId: string): Promise<PaymentAccount>;
  sendPayment(input: SendPaymentInput): Promise<PaymentResult>;
  receivePayment(input: SendPaymentInput): Promise<PaymentResult>;
  listPayments(query: PaymentHistoryQuery): Promise<PaymentResult[]>;
}

export class PaymentProviderUnsupported extends Error {
  constructor(provider: PaymentProviderId, operation: string) {
    super(`Operation "${operation}" is not supported by the ${provider} rail yet.`);
    this.name = "PaymentProviderUnsupported";
  }
}

export const PAYMENT_STATUS_LABEL: Record<PaymentAccountStatus, string> = {
  not_connected: "Not connected",
  pending_verification: "Pending verification",
  verification_required: "Verification required",
  active: "Active",
  suspended: "Suspended",
};

export const BANK_STATUS_LABEL: Record<BankConnectionStatus, string> = {
  not_connected: "No bank connected",
  pending: "Connection pending",
  connected: "Bank connected",
  failed: "Connection failed",
};

export const VERIFICATION_STATUS_LABEL: Record<VerificationStatus, string> = {
  not_started: "Not started",
  business_pending: "Business verification pending",
  owner_pending: "Owner verification pending",
  verified: "Verified",
  rejected: "Rejected",
};
