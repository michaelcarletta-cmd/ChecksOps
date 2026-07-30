import { PaymentAccountPanel } from "@/components/payments/PaymentAccountPanel";
import { PaymentProviderAdmin } from "@/components/payments/PaymentProviderAdmin";
import { WalletPanel } from "@/components/payments/WalletPanel";
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
      <WalletPanel />
      <TenantBankAccountSettings />
      {PAYMENT_FLAGS.SHOW_PAYMENT_ADMIN && <PaymentProviderAdmin />}
    </div>
  );
}
