import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarketingPageShell } from "@/components/marketing/MarketingPageShell";
import { usePageMeta } from "@/hooks/usePageMeta";
import { type CarrierPlatformComparison, VS_GUIDEWIRE, VS_SNAPSHEET } from "@/pages/marketing/marketingPages";
import { PUBLISHED_PRICING } from "@/pages/marketing/marketingPricing";

/**
 * /vs/checksops-vs-snapsheet and /vs/checksops-vs-guidewire-claimcenter. Both rivals are
 * claims systems for the insurer's side of the claim. The page says only what their own
 * sites say (quoted in marketingPages.ts) and what this site already states about ChecksOps.
 *
 * TODO(owner): read both pages against snapsheet.com and guidewire.com before relying on them,
 * and update FACTS_AS_OF.
 */
const FACTS_AS_OF = "November 6, 2026";

function rows(c: CarrierPlatformComparison) {
  return [
    {
      topic: "Who it is for",
      checksops: "Public adjusting firms and their restoration partners: the side that receives the claim check.",
      them: c.builtFor,
    },
    {
      topic: "The job it does",
      checksops:
        "Files every insurance check by claim, collects payee endorsements, shows deposit readiness, and tracks loss drafts held by mortgage companies.",
      them: "Runs the claim inside the insurer: intake, adjusting and the claim file on the carrier side.",
    },
    {
      topic: "Who keeps the relationships",
      checksops:
        "Your company keeps the mortgage, carrier, payee, and banking decisions. ChecksOps provides the workflow, evidence, and status visibility.",
      them: "The insurer that runs the platform.",
    },
    {
      topic: "Published pricing",
      checksops: `${PUBLISHED_PRICING.platformFee} one-time platform fee, ${PUBLISHED_PRICING.perCheck} per check, support ${PUBLISHED_PRICING.supportMonthly} a month. Unlimited users.`,
      them: "Not published. Sold to insurers through enterprise sales.",
    },
  ];
}

function ComparisonPage({ c }: { c: CarrierPlatformComparison }) {
  usePageMeta(c.page);
  const table = rows(c);
  return (
    <MarketingPageShell
      currentPath={c.page.path}
      footerNote={`${c.name} is a trademark of its owner and is named here only for comparison.`}
    >
      <main className="mx-auto max-w-5xl px-4 md:px-6 py-14 md:py-20">
        <Badge variant="outline" className="mb-5">Comparison</Badge>
        <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-tight">ChecksOps vs {c.name}</h1>
        <p className="mt-5 text-lg text-muted-foreground leading-relaxed max-w-3xl">
          {c.name} is software for the insurer's side of the claim. ChecksOps is for the public
          adjusting firm on the other side: once the carrier issues the check, ChecksOps files it by
          claim, gets it endorsed by every payee, gets it deposited, and keeps any loss draft held
          by a mortgage company in view.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          {c.name} details as of {FACTS_AS_OF}, from {c.shortName}'s public website.
        </p>

        <section className="mt-12">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">In their own words</h2>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            {c.ownWords.map((w) => (
              <li key={w}>“{w}”</li>
            ))}
          </ul>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Side by side</h2>
          <div className="mt-6 hidden md:block overflow-hidden rounded-xl border border-border/50">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-left">
                <tr>
                  <th scope="col" className="p-4 w-1/5 font-semibold"><span className="sr-only">Topic</span></th>
                  <th scope="col" className="p-4 font-semibold">ChecksOps</th>
                  <th scope="col" className="p-4 font-semibold">{c.name}</th>
                </tr>
              </thead>
              <tbody>
                {table.map((r) => (
                  <tr key={r.topic} className="border-t border-border/40 align-top">
                    <th scope="row" className="p-4 text-left font-medium">{r.topic}</th>
                    <td className="p-4 text-muted-foreground leading-relaxed">{r.checksops}</td>
                    <td className="p-4 text-muted-foreground leading-relaxed">{r.them}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-6 space-y-4 md:hidden">
            {table.map((r) => (
              <div key={r.topic} className="rounded-xl border border-border/50 bg-card/60 p-4">
                <h3 className="font-semibold">{r.topic}</h3>
                <p className="mt-3 text-xs font-semibold text-primary">ChecksOps</p>
                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{r.checksops}</p>
                <p className="mt-3 text-xs font-semibold">{c.name}</p>
                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{r.them}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Questions</h2>
          <div className="mt-6 space-y-4">
            {c.faq.map((f) => (
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
            <Link to="/pricing">See ChecksOps pricing</Link>
          </Button>
        </div>
      </main>
    </MarketingPageShell>
  );
}

export function ChecksOpsVsSnapsheet() {
  return <ComparisonPage c={VS_SNAPSHEET} />;
}

export function ChecksOpsVsGuidewire() {
  return <ComparisonPage c={VS_GUIDEWIRE} />;
}
