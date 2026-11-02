import { PasskeyManagerCard } from "@/components/auth/PasskeyManagerCard";
import { TotpManagerCard } from "@/components/auth/TotpManagerCard";
import { PaymentSettingsTab } from "@/pages/payments/PaymentSettingsTab";

/**
 * Vendor Portal settings: sign-in security for the user, then the organization's
 * payment account, wallet and bank account (the same panels as the Check Center's
 * payment settings).
 */
export default function VendorSettings() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Security</h2>
        <PasskeyManagerCard />
        <TotpManagerCard />
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Payments and bank account</h2>
        <PaymentSettingsTab />
      </section>
    </div>
  );
}
