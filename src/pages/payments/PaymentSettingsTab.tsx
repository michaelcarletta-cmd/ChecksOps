import { PaymentAccountPanel } from "@/components/payments/PaymentAccountPanel";
import { TenantBankAccountSettings } from "@/components/settings/TenantBankAccountSettings";

/**
 * Provider-neutral payment settings. The bank connection widget underneath
 * still routes to whichever rail the organization is on today.
 */
export function PaymentSettingsTab() {
  return (
    <div className="space-y-4 pt-2">
      <PaymentAccountPanel />
      <TenantBankAccountSettings />
    </div>
  );
}
