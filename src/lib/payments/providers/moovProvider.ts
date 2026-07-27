import {
  PaymentProviderUnsupported,
  type ConnectBankInput,
  type ConnectBankResult,
  type CreateTenantAccountInput,
  type PaymentAccount,
  type PaymentHistoryQuery,
  type PaymentProvider,
  type PaymentResult,
  type SendPaymentInput,
} from "../types";
import { readTenantPaymentAccount } from "./tenantAccount";

/**
 * Moov adapter — the future default rail.
 *
 * ChecksOps runs as a Moov platform: every tenant gets its own connected
 * account, its own bank connection, its own capabilities, and its own payment
 * history. Funds never sit with ChecksOps — they stay in the tenant's own bank
 * account until that tenant initiates a payment.
 *
 * The live API calls are intentionally not wired yet. Each method below is the
 * exact seam where the Moov call goes; enabling `USE_MOOV` plus filling these
 * in is all that a future release should require.
 */
export const moovProvider: PaymentProvider = {
  id: "moov",
  label: "Moov",

  async createTenantAccount(_input: CreateTenantAccountInput): Promise<PaymentAccount> {
    // TODO(moov): POST /accounts — business account + KYB requirements.
    throw new PaymentProviderUnsupported("moov", "createTenantAccount");
  },

  async connectBank(_input: ConnectBankInput): Promise<ConnectBankResult> {
    // TODO(moov): POST /accounts/{id}/bank-accounts (or Moov Drops / Plaid token).
    throw new PaymentProviderUnsupported("moov", "connectBank");
  },

  async verifyAccount(_tenantId: string): Promise<PaymentAccount> {
    // TODO(moov): GET /accounts/{id} — map capability + verification state.
    throw new PaymentProviderUnsupported("moov", "verifyAccount");
  },

  async getAccount(tenantId: string): Promise<PaymentAccount> {
    // Reads the cached provider-neutral snapshot until the live sync exists.
    return readTenantPaymentAccount(tenantId, "moov");
  },

  async sendPayment(_input: SendPaymentInput): Promise<PaymentResult> {
    // TODO(moov): POST /transfers — source = tenant bank, destination = recipient.
    throw new PaymentProviderUnsupported("moov", "sendPayment");
  },

  async receivePayment(_input: SendPaymentInput): Promise<PaymentResult> {
    // TODO(moov): POST /transfers — destination = tenant bank.
    throw new PaymentProviderUnsupported("moov", "receivePayment");
  },

  async listPayments(_query: PaymentHistoryQuery): Promise<PaymentResult[]> {
    // TODO(moov): GET /accounts/{id}/transfers.
    throw new PaymentProviderUnsupported("moov", "listPayments");
  },
};
