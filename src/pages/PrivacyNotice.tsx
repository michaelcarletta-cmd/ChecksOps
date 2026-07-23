import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/hooks/use-toast";
import { CheckCircle2, ShieldCheck } from "lucide-react";

const NOTICE_VERSION = "2026-01";

export default function PrivacyNotice() {
  const [params] = useSearchParams();
  const tenantSlug = params.get("tenant");
  const claimId = params.get("claim");

  const [tenantId, setTenantId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState<string>("ChecksOps");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    document.title = `Privacy Notice | ${companyName}`;
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", `${companyName} GLBA Privacy Notice — how we collect, use, and share consumer financial information.`);
  }, [companyName]);

  useEffect(() => {
    (async () => {
      if (!tenantSlug) return;
      const { data } = await supabase
        .from("tenants_public" as any)
        .select("id, name")
        .eq("slug", tenantSlug)
        .maybeSingle();
      if (data) {
        const row = data as unknown as { id: string; name: string | null };
        setTenantId(row.id);
        if (row.name) setCompanyName(row.name);
      }
    })();
  }, [tenantSlug]);

  async function recordAcknowledgment() {
    if (!email.trim()) {
      toast({ title: "Email required", description: "Please enter your email to acknowledge." , variant: "destructive"});
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from("privacy_notice_acknowledgments").insert({
      tenant_id: tenantId,
      consumer_email: email.trim().toLowerCase(),
      consumer_name: name.trim() || null,
      claim_id: claimId || null,
      notice_version: NOTICE_VERSION,
      user_agent: navigator.userAgent,
      delivery_method: "web",
    });
    setSubmitting(false);
    if (error) {
      toast({ title: "Could not record acknowledgment", description: error.message, variant: "destructive" });
      return;
    }
    setAcknowledged(true);
  }

  return (
    <main className="min-h-screen bg-background text-foreground py-10 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        <header className="flex items-center gap-3">
          <ShieldCheck className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-semibold">Consumer Privacy Notice</h1>
            <p className="text-sm text-muted-foreground">
              {companyName} — Effective {NOTICE_VERSION} • Required under the Gramm-Leach-Bliley Act (15 U.S.C. §§ 6801–6809) and 16 CFR Part 313.
            </p>
          </div>
        </header>

        <Card>
          <CardHeader><CardTitle>FACTS — What does {companyName} do with your personal information?</CardTitle></CardHeader>
          <CardContent className="prose prose-invert max-w-none space-y-4 text-sm">
            <section>
              <h3 className="font-semibold">Why?</h3>
              <p>Financial companies choose how they share your personal information. Federal law gives consumers the right to limit some — but not all — sharing. Federal law also requires us to tell you how we collect, share, and protect your personal information. Please read this notice carefully.</p>
            </section>

            <section>
              <h3 className="font-semibold">What?</h3>
              <p>The types of personal information we collect and share depend on the product or service you have with us. This information can include:</p>
              <ul className="list-disc pl-6">
                <li>Name, address, phone number, and email</li>
                <li>Insurance claim number, policy number, and loss details</li>
                <li>Mortgage information and lender contact details</li>
                <li>Bank account and routing numbers used for endorsements and disbursements</li>
                <li>Identification details (Social Security number last four digits, government ID where required)</li>
                <li>Payment history and transaction records</li>
              </ul>
            </section>

            <section>
              <h3 className="font-semibold">How?</h3>
              <p>All financial companies need to share customers' personal information to run their everyday business. In the section below, we list the reasons financial companies can share their customers' personal information; the reasons {companyName} chooses to share; and whether you can limit this sharing.</p>
            </section>

            <section>
              <table className="w-full text-sm border border-border">
                <thead className="bg-muted">
                  <tr><th className="text-left p-2 border-b">Reasons we can share your information</th><th className="text-left p-2 border-b">Do we share?</th><th className="text-left p-2 border-b">Can you limit?</th></tr>
                </thead>
                <tbody>
                  <tr className="border-b"><td className="p-2">For everyday business purposes — processing claims, depositing checks, paying contractors and mortgage companies, responding to court orders</td><td className="p-2">Yes</td><td className="p-2">No</td></tr>
                  <tr className="border-b"><td className="p-2">For our marketing purposes — to offer our products and services to you</td><td className="p-2">No</td><td className="p-2">We don't share</td></tr>
                  <tr className="border-b"><td className="p-2">For joint marketing with other financial companies</td><td className="p-2">No</td><td className="p-2">We don't share</td></tr>
                  <tr className="border-b"><td className="p-2">For our affiliates' everyday business purposes</td><td className="p-2">No</td><td className="p-2">We don't share</td></tr>
                  <tr className="border-b"><td className="p-2">For our affiliates to market to you</td><td className="p-2">No</td><td className="p-2">We don't share</td></tr>
                  <tr><td className="p-2">For nonaffiliates to market to you</td><td className="p-2">No</td><td className="p-2">We don't share</td></tr>
                </tbody>
              </table>
            </section>

            <section>
              <h3 className="font-semibold">How does {companyName} protect my personal information?</h3>
              <p>To protect your personal information from unauthorized access and use, we use security measures that comply with federal law, including the FTC Safeguards Rule (16 CFR Part 314). These measures include encryption of data in transit (TLS 1.2+) and at rest (AES-256 / pgsodium), role-based access controls, multi-factor authentication for staff, continuous audit logging, vendor due diligence, written incident response procedures, and annual employee security training.</p>
            </section>

            <section>
              <h3 className="font-semibold">How does {companyName} collect my personal information?</h3>
              <p>We collect your personal information, for example, when you submit a claim, upload a check, provide contact information, request payment direction, or sign endorsement documents. We also collect information from insurance carriers, mortgage companies, and contractors involved in your claim.</p>
            </section>

            <section>
              <h3 className="font-semibold">Why can't I limit all sharing?</h3>
              <p>Federal law gives you the right to limit only:</p>
              <ul className="list-disc pl-6">
                <li>Sharing for affiliates' everyday business purposes — information about your creditworthiness</li>
                <li>Affiliates from using your information to market to you</li>
                <li>Sharing for nonaffiliates to market to you</li>
              </ul>
              <p>{companyName} does not engage in any of these activities.</p>
            </section>

            <section>
              <h3 className="font-semibold">Data retention</h3>
              <p>We retain claim and check information for seven (7) years after a claim is closed to comply with federal tax, banking, and audit requirements. After this period, personal information is securely purged unless required by law to be retained longer.</p>
            </section>

            <section>
              <h3 className="font-semibold">Your rights</h3>
              <p>You may request a copy of the personal information we hold about you, request corrections, or ask us to delete information that is no longer required for an active claim or by law. Contact your claims representative or email <strong>privacy@checksops.com</strong>.</p>
            </section>

            <section>
              <h3 className="font-semibold">Questions?</h3>
              <p>Email <strong>privacy@checksops.com</strong> or call your claims representative. To report a suspected security incident, email <strong>security@checksops.com</strong>.</p>
            </section>
          </CardContent>
        </Card>

        {acknowledged ? (
          <Card className="border-primary">
            <CardContent className="flex items-center gap-3 py-6">
              <CheckCircle2 className="h-6 w-6 text-primary" />
              <div>
                <p className="font-medium">Thank you — your acknowledgment has been recorded.</p>
                <p className="text-sm text-muted-foreground">A copy has been logged with your claim file.</p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader><CardTitle>Acknowledge receipt</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="ack-name">Your name</Label>
                  <Input id="ack-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="ack-email">Email *</Label>
                  <Input id="ack-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
              </div>
              <Button onClick={recordAcknowledgment} disabled={submitting}>
                {submitting ? "Recording…" : "I acknowledge receipt of this Privacy Notice"}
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
