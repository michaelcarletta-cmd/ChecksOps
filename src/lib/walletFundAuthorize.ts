/**
 * Production wallet.fund authorization only.
 *
 * Opens the normal Financial TOTP dialog for Freedom BANK→WALLET $0.01,
 * then STOPS. Must never invoke the independent funding writer or disburse.
 */

import {
  buildFinancialStepUpRequest,
  type FinancialStepUpRequest,
} from "./financialStepUp.ts";
import {
  FINANCIAL_TOTP_ONLY_ROLES,
  canShowFinancialTotpOnlyTestCard,
  roleMayRunFinancialTotpOnlyTest,
} from "./financialTotpOnlyTest.ts";

export const WALLET_FUND_AUTHORIZE_ACTION = "wallet.fund" as const;
export const WALLET_FUND_AUTHORIZE_AMOUNT_CENTS = 1;
export const WALLET_FUND_AUTHORIZE_TENANT_ID = "2eff5f1a-929d-4ce3-9a8b-cd96b98df42a";
export const WALLET_FUND_AUTHORIZE_SOURCE_LABEL = "Freedom Wells Fargo ••••4573";
export const WALLET_FUND_AUTHORIZE_DESTINATION_LABEL = "Freedom wallet";
export const WALLET_FUND_AUTHORIZE_COPY =
  "Authorize wallet.fund $0.01 only. This does not move money and does not disburse.";

export const WALLET_FUND_AUTHORIZE_FORBIDDEN = Object.freeze([
  "moov-wallet-fund",
  "moov-wallet-disburse",
  "fundWallet",
  "wallet.disburse",
  "checkalt-submit-deposit",
] as const);

export const canShowWalletFundAuthorizeCard = canShowFinancialTotpOnlyTestCard;
export const roleMayAuthorizeWalletFund = roleMayRunFinancialTotpOnlyTest;
export const WALLET_FUND_AUTHORIZE_ROLES = FINANCIAL_TOTP_ONLY_ROLES;

export const buildWalletFundAuthorizeRequest = (): ReturnType<typeof buildFinancialStepUpRequest> =>
  buildFinancialStepUpRequest({
    actionKey: WALLET_FUND_AUTHORIZE_ACTION,
    tenantId: WALLET_FUND_AUTHORIZE_TENANT_ID,
    title: "Authorize wallet funding",
    description:
      "Freedom Wells Fargo → Freedom wallet, exactly $0.01. Enter the Financial TOTP yourself. This authorization does not send money.",
    amount_cents: WALLET_FUND_AUTHORIZE_AMOUNT_CENTS,
  });

export const runWalletFundAuthorization = async (input: {
  roles: unknown;
  requireStepUp: (request: FinancialStepUpRequest) => Promise<boolean>;
}): Promise<
  | { ok: true; authorized: boolean; action: typeof WALLET_FUND_AUTHORIZE_ACTION; stopped: true }
  | { ok: false; error: string }
> => {
  if (!roleMayAuthorizeWalletFund(input.roles)) {
    return { ok: false, error: "financial_role_required" };
  }
  const built = buildWalletFundAuthorizeRequest();
  if (!built.ok) return { ok: false, error: built.error };
  const authorized = await input.requireStepUp(built.request);
  return {
    ok: true,
    authorized,
    action: WALLET_FUND_AUTHORIZE_ACTION,
    stopped: true,
  };
};
