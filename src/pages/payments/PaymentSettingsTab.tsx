import { PaymentAccountPanel } from "@/components/payments/PaymentAccountPanel";
import { VerificationDocumentsPanel } from "@/components/payments/VerificationDocumentsPanel";
import { PaymentProviderAdmin } from "@/components/payments/PaymentProviderAdmin";
import { PlatformFeeSchedulePanel } from "@/components/payments/PlatformFeeSchedulePanel";
import { WalletPanel } from "@/components/payments/WalletPanel";
import { MoovTreasuryPanel } from "@/components/payments/MoovTreasuryPanel";
import { TenantBankAccountSettings } from "@/components/settings/TenantBankAccountSettings";
import { PAYMENT_FLAGS } from "@/lib/payments/featureFlags";

/**
 * Provider-neutral payment settings. The bank connection widget underneath
 * still routes to whichever rail the organization is on today.
 */
export function PaymentSettingsTab() {
  return (
    <div className="space-y-4 pt-2">
      <PaymentAccountPanel />
      <VerificationDocumentsPanel />
      <WalletPanel />
      <MoovTreasuryPanel />
      <PlatformFeeSchedulePanel />
      <TenantBankAccountSettings />
      {PAYMENT_FLAGS.SHOW_PAYMENT_ADMIN && <PaymentProviderAdmin />}

    </div>
  );
}

