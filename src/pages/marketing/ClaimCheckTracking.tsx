import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarketingPageShell } from "@/components/marketing/MarketingPageShell";
import { usePageMeta } from "@/hooks/usePageMeta";
import { CLAIM_CHECK_TRACKING_FAQ, CLAIM_CHECK_TRACKING_PAGE } from "@/pages/marketing/marketingPages";

/**
 * /claim-check-tracking: the category page for "claim check tracking" and "loss draft
 * tracking" searches. Every capability named here is already described on the home page.
 */
const STAGES = [
  { title: "Upload", desc: "Photo, scan, or PDF. OCR extracts the amount, check number, carrier, issue date, and every payee line." },
  { title: "Review", desc: "Verify the extracted data, correct payees, and file the check on its claim." },
  { title: "Endorse", desc: "Each payee signs digitally. See who has signed, who is pending, and who is waived." },
  { title: "Deposit", desc: "A ready-for-deposit packet is generated once every payee has endorsed. Branch or electronic: your company decides." },
  { title: "Monitor", desc: "Loss draft visibility, draw requests, reissue requests, and cleared status, all tracked to close." },
]

export default function ClaimCheckTracking() {
  usePageMeta(CLAIM_CHECK_TRACKING_PAGE);
  return (
    <MarketingPageShell currentPath={CLAIM_CHECK_TRACKING_PAGE.path}>
      <main className="mx-auto max-w-5xl px-4 md:px-6 py-14 md:py-20">
        <Badge variant="outline" className="mb-5">For public adjusting firms</Badge>
        <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-tight">
          Claim check and loss draft tracking for public adjusting firms
        </h1>
        <p className="mt-5 text-lg text-muted-foreground leading-relaxed max-w-3xl">
          Stop tracking claim checks in inboxes and spreadsheets. ChecksOps files every insurance
          check by claim, shows who still has to endorse it, tells you when it is ready to deposit,
          and keeps loss drafts held by mortgage companies in view. Every check has exactly one
          status and one next action.
        </p>

        <section className="mt-12">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">From the mailbox to the deposit</h2>
          <ol className="mt-6 grid md:grid-cols-5 gap-3">
            {STAGES.map((s, i) => (
              <li key={s.title} className="rounded-xl border border-border/50 bg-card/60 p-4">
                <p className="text-xs font-semibold text-primary">Stage {i + 1}</p>
                <h3 className="mt-1 font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{s.desc}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-12 grid md:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border/50 bg-card/60 p-5">
            <h2 className="text-xl font-bold tracking-tight">Without a system</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground list-disc pl-5">
              <li>Checks sit in an inbox or a desk drawer waiting on one signature.</li>
              <li>Status lives in a spreadsheet only one person updates.</li>
              <li>Restoration partners and homeowners email to ask where the money is.</li>
              <li>Loss drafts at the mortgage company drop out of sight between draws.</li>
            </ul>
          </div>
          <div className="rounded-xl border border-primary/40 bg-card/60 p-5">
            <h2 className="text-xl font-bold tracking-tight">With ChecksOps</h2>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground list-disc pl-5">
              <li>Every check on its claim file, with its payees and endorsement status.</li>
              <li>A deposit-ready lane, so nothing waits once the last signature is in.</li>
              <li>Partners see the checks you share with them, without emailing your team.</li>
              <li>Every action, signature and status change in the audit log.</li>
            </ul>
          </div>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Questions</h2>
          <div className="mt-6 space-y-4">
            {CLAIM_CHECK_TRACKING_FAQ.map((f) => (
              <div key={f.q} className="rounded-xl border border-border/50 bg-card/60 p-5">
                <h3 className="font-semibold">{f.q}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{f.a}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-12 flex flex-col sm:flex-row gap-3">
          <Button asChild size="lg">
            <Link to="/#demo">Book a live demo<ArrowRight className="h-4 w-4 ml-2" /></Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/pricing">See pricing</Link>
          </Button>
        </div>
      </main>
    </MarketingPageShell>
  );
}
