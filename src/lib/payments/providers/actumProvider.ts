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
 * Actum adapter.
 *
 * Actum's live money movement still runs through the existing
 * `actum-disburse` / `actum-send-payment` edge functions and the disbursement
 * console. This adapter exists so new code can be written against the
 * provider-neutral interface today; it deliberately does NOT re-route or
 * change any current flow.
 */
export const actumProvider: PaymentProvider = {
  id: "actum",
  label: "Actum",

  async createTenantAccount(_input: CreateTenantAccountInput): Promise<PaymentAccount> {
    throw new PaymentProviderUnsupported("actum", "createTenantAccount");
  },

  async connectBank(_input: ConnectBankInput): Promise<ConnectBankResult> {
    // Handled today by actum-authentecheck-init + BankVerification.
    throw new PaymentProviderUnsupported("actum", "connectBank");
  },

  async verifyAccount(tenantId: string): Promise<PaymentAccount> {
    return readTenantPaymentAccount(tenantId, "actum");
  },

  async getAccount(tenantId: string): Promise<PaymentAccount> {
    return readTenantPaymentAccount(tenantId, "actum");
  },

  async sendPayment(_input: SendPaymentInput): Promise<PaymentResult> {
    throw new PaymentProviderUnsupported("actum", "sendPayment");
  },

  async receivePayment(_input: SendPaymentInput): Promise<PaymentResult> {
    throw new PaymentProviderUnsupported("actum", "receivePayment");
  },

  async listPayments(_query: PaymentHistoryQuery): Promise<PaymentResult[]> {
    throw new PaymentProviderUnsupported("actum", "listPayments");
  },
};
