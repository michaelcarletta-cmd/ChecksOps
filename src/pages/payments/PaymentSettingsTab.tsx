import { PaymentAccountPanel } from "@/components/payments/PaymentAccountPanel";
import { PaymentProviderAdmin } from "@/components/payments/PaymentProviderAdmin";
import { PlatformFeeSchedulePanel } from "@/components/payments/PlatformFeeSchedulePanel";
import { WalletPanel } from "@/components/payments/WalletPanel";
import { MoovTreasuryPanel } from "@/components/payments/MoovTreasuryPanel";
import { TenantBankAccountSettings } from "@/components/settings/TenantBankAccountSettings";
import { PAYMENT_FLAGS } from "@/lib/payments/featureFlags";

/**
 * Provider-neutral payment settings. Onboarding (identity, documents, terms,
 * underwriting, bank verification) lives only in Settings -> Compliance & Docs;
 * this tab shows the account summary and wallet tools.
 */
export function PaymentSettingsTab() {
  return (
    <div className="space-y-4 pt-2">
      <PaymentAccountPanel />
      <WalletPanel />
      <MoovTreasuryPanel />
      <PlatformFeeSchedulePanel />
      <TenantBankAccountSettings />
      {PAYMENT_FLAGS.SHOW_PAYMENT_ADMIN && <PaymentProviderAdmin />}
    </div>
  );
}
