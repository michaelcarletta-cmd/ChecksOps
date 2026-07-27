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
 * Plaid adapter.
 *
 * Plaid Link verification and `plaid-disburse` payouts continue to run through
 * their existing components and edge functions. Long term Plaid becomes an
 * optional instant bank-verification provider behind the same interface.
 */
export const plaidProvider: PaymentProvider = {
  id: "plaid",
  label: "Plaid",

  async createTenantAccount(_input: CreateTenantAccountInput): Promise<PaymentAccount> {
    throw new PaymentProviderUnsupported("plaid", "createTenantAccount");
  },

  async connectBank(_input: ConnectBankInput): Promise<ConnectBankResult> {
    // Handled today by plaid-link-token-create + PlaidVerification.
    throw new PaymentProviderUnsupported("plaid", "connectBank");
  },

  async verifyAccount(tenantId: string): Promise<PaymentAccount> {
    return readTenantPaymentAccount(tenantId, "plaid");
  },

  async getAccount(tenantId: string): Promise<PaymentAccount> {
    return readTenantPaymentAccount(tenantId, "plaid");
  },

  async sendPayment(_input: SendPaymentInput): Promise<PaymentResult> {
    throw new PaymentProviderUnsupported("plaid", "sendPayment");
  },

  async receivePayment(_input: SendPaymentInput): Promise<PaymentResult> {
    throw new PaymentProviderUnsupported("plaid", "receivePayment");
  },

  async listPayments(_query: PaymentHistoryQuery): Promise<PaymentResult[]> {
    throw new PaymentProviderUnsupported("plaid", "listPayments");
  },
};
