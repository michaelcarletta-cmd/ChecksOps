import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";
import { MarketingMenuButton, MarketingMobileMenu } from "@/components/marketing/MarketingMobileMenu";
import { usePageMeta } from "@/hooks/usePageMeta";
import { PUBLISHED_PRICING } from "@/pages/marketing/marketingPricing";

/**
 * /vs/checksops-vs-iink-payments: an honest side-by-side for a firm owner choosing between
 * the two. ChecksOps facts come from this site (home page, /pricing). iink Payments facts come
 * from the website audit of iink's public pages.
 *
 * TODO(owner): confirm every iink figure below against iink.com/pricing before publishing and
 * update IINK_FACTS_AS_OF. Two points to check in particular: the $25 minimum on the mortgage
 * fee (not in src/lib/financial/iink.ts, captured 2026-08-21), and the 2% RTP rate
 * (src/lib/financial/iink.ts lists 3% on the Basic tier and 2% on the others).
 */
const IINK_FACTS_AS_OF = "November 6, 2026";

const TITLE = "ChecksOps vs iink Payments - Claim check workflow compared";
const DESCRIPTION =
  `ChecksOps vs iink Payments for public adjusting firms: a control layer your firm runs at a flat ${PUBLISHED_PRICING.perCheck} per check, versus a payments network with monthly tiers and a 1% fee on mortgage checks.`;

const NAV_ITEMS = [
  { label: "Capabilities", href: "/#capabilities" },
  { label: "Workflow", href: "/#workflow" },
  { label: "Security", href: "/#security" },
  { label: "Pricing", href: "/pricing" },
];

interface Row {
  topic: string;
  checksops: string;
  iink: string;
}

const ROWS: Row[] = [
  {
    topic: "What it is",
    checksops:
      "A workflow control layer. Your company keeps the mortgage, carrier, payee, and banking decisions; ChecksOps provides the organized workflow, evidence, and status visibility. Not a bank or payment processor.",
    iink: "A payments network that handles claim payments and loss drafts for you.",
  },
  {
    topic: "Entry price",
    checksops: `${PUBLISHED_PRICING.platformFee} one-time platform fee per company, plus support at ${PUBLISHED_PRICING.supportMonthly} a month or ${PUBLISHED_PRICING.supportAnnual} a year. Unlimited users.`,
    iink: "Monthly subscription tiers, from Basic at $45/month (2 checks) to Premium at $375/month (50 checks). Enterprise on request.",
  },
  {
    topic: "Per check",
    checksops: `${PUBLISHED_PRICING.perCheck} per check, the same for every check. No minimums, no caps.`,
    iink: "Checks included in the monthly tier.",
  },
  {
    topic: "Checks with a mortgage company payee",
    checksops: `${PUBLISHED_PRICING.perCheck} per check. No percentage of the check amount.`,
    iink: "1% of the check amount, with a $25 minimum and a cap of $299 to $329 per check depending on tier.",
  },
  {
    topic: "Instant (RTP) payouts",
    checksops: "Send ACH, same-day ACH, or RTP from your company's own wallet.",
    iink: "2% surcharge on RTP transfers.",
  },
  {
    topic: "Where the money sits",
    checksops:
      "Your company's own wallet, separate and owned by you. Money movement is powered by Moov, a regulated money services provider. Your company remains the merchant of record.",
    iink: "On iink's payment rails. iink states funds are held at Avidia Bank, Member FDIC.",
  },
];

// Worked example from the figures above: a $20,000 check with a mortgage company payee.
const EXAMPLE_CHECK = 20000;
const IINK_MORTGAGE_FEE = Math.max(25, EXAMPLE_CHECK * 0.01);

const FAQ = [
  {
    q: "Is ChecksOps a payment processor like iink?",
    a: "No. ChecksOps is workflow software, not a bank, lender, escrow service, or payment processor. Your company owns the process and controls all communications with carriers, mortgage companies, payees, and banks.",
  },
  {
    q: "How does the cost of a mortgage check compare?",
    a: `iink charges 1% of the check amount on checks with a mortgage company payee, with a $25 minimum and a cap of $299 to $329 depending on tier. ChecksOps charges ${PUBLISHED_PRICING.perCheck} per check whatever the amount or payee.`,
  },
  {
    q: "Which is cheaper for a small firm?",
    a: `For a firm with a handful of checks a month, iink's $45-a-month Basic tier is the lower start. ChecksOps has a ${PUBLISHED_PRICING.platformFee} one-time platform fee and is built for firms that process insurance claim checks at scale.`,
  },
  {
    q: "Who controls the money and the mortgage company relationship?",
    a: "With ChecksOps, your company does. Each organization has its own wallet, your company stays the merchant of record, and your team keeps mortgage-company communication.",
  },
];

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

export default function ChecksOpsVsIink() {
  const [menuOpen, setMenuOpen] = useState(false);
  usePageMeta({ title: TITLE, description: DESCRIPTION, path: "/vs/checksops-vs-iink-payments", jsonLd: JSON_LD });

  return (
    <div className="min-h-screen max-w-full overflow-x-hidden bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center justify-between">
          <Link to="/">
            <CheckOpsLogo className="text-foreground h-9 sm:h-10" />
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            {NAV_ITEMS.map((item) => (
              <Link key={item.href} to={item.href} className="hover:text-foreground transition-colors">{item.label}</Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link to="/login"><LogIn className="h-4 w-4 mr-1.5" />Sign in</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/#demo">Book a demo</Link>
            </Button>
            <MarketingMenuButton open={menuOpen} onToggle={() => setMenuOpen(!menuOpen)} />
          </div>
        </div>
        <MarketingMobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} items={NAV_ITEMS} demoHref="/#demo" />
      </header>

      <main className="mx-auto max-w-5xl px-4 md:px-6 py-14 md:py-20">
        <Badge variant="outline" className="mb-5">Comparison</Badge>
        <h1 className="text-3xl md:text-5xl font-bold tracking-tight leading-tight">ChecksOps vs iink Payments</h1>
        <p className="mt-5 text-lg text-muted-foreground leading-relaxed max-w-3xl">
          Both help public adjusting firms deal with insurance claim checks and loss drafts. They are
          built differently: iink is a payments network that moves the money for you. ChecksOps is a
          workflow your firm runs, with the money staying in your company's own wallet and the
          mortgage-company relationship staying with your team.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          iink Payments details as of {IINK_FACTS_AS_OF}, from iink's public website. Prices change; check iink.com for current terms.
        </p>

        <section className="mt-12">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Side by side</h2>
          {/* Phone widths: one card per topic. md and up: a three-column table. */}
          <div className="mt-6 hidden md:block overflow-hidden rounded-xl border border-border/50">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-left">
                <tr>
                  <th scope="col" className="p-4 w-1/5 font-semibold"><span className="sr-only">Topic</span></th>
                  <th scope="col" className="p-4 font-semibold">ChecksOps</th>
                  <th scope="col" className="p-4 font-semibold">iink Payments</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((r) => (
                  <tr key={r.topic} className="border-t border-border/40 align-top">
                    <th scope="row" className="p-4 text-left font-medium">{r.topic}</th>
                    <td className="p-4 text-muted-foreground leading-relaxed">{r.checksops}</td>
                    <td className="p-4 text-muted-foreground leading-relaxed">{r.iink}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-6 space-y-4 md:hidden">
            {ROWS.map((r) => (
              <div key={r.topic} className="rounded-xl border border-border/50 bg-card/60 p-4">
                <h3 className="font-semibold">{r.topic}</h3>
                <p className="mt-3 text-xs font-semibold text-primary">ChecksOps</p>
                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{r.checksops}</p>
                <p className="mt-3 text-xs font-semibold">iink Payments</p>
                <p className="mt-1 text-sm text-muted-foreground leading-relaxed">{r.iink}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-12 rounded-xl border border-border/50 bg-card/60 p-6">
          <h2 className="text-xl md:text-2xl font-bold tracking-tight">Example: one {usd(EXAMPLE_CHECK)} check with a mortgage company payee</h2>
          <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
            <li>iink: 1% of {usd(EXAMPLE_CHECK)} = {usd(IINK_MORTGAGE_FEE)}, on top of the monthly subscription.</li>
            <li>ChecksOps: {PUBLISHED_PRICING.perCheck}, on top of the one-time platform fee and support plan.</li>
          </ul>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Which fits your firm</h2>
          <div className="mt-6 grid md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-border/50 bg-card/60 p-5">
              <h3 className="font-semibold">iink may fit better if</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                You handle a few checks a month and want the lowest monthly start, and you are
                comfortable with a payments network handling the money for you.
              </p>
            </div>
            <div className="rounded-xl border border-primary/40 bg-card/60 p-5">
              <h3 className="font-semibold">ChecksOps may fit better if</h3>
              <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                You process claim checks at scale, want one flat price per check instead of a
                percentage on mortgage checks, and want your firm to keep the wallet, the
                decisions, and the mortgage-company relationship.
              </p>
            </div>
          </div>
        </section>

        <section className="mt-12">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Questions</h2>
          <div className="mt-6 space-y-4">
            {FAQ.map((f) => (
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

      <footer className="border-t border-border/40">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} ChecksOps</span>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link to="/" className="hover:text-foreground">Home</Link>
            <Link to="/pricing" className="hover:text-foreground">Pricing</Link>
            <Link to="/privacy-notice" className="hover:text-foreground">Privacy Notice</Link>
            <Link to="/terms" className="hover:text-foreground">Terms of Service</Link>
          </nav>
        </div>
        <p className="mx-auto max-w-4xl px-4 pb-6 text-center text-[11px] leading-relaxed text-muted-foreground">
          iink Payments is a trademark of its owner and is named here only for comparison. ChecksOps is
          workflow software, not a bank, lender, escrow service, or payment processor.
        </p>
      </footer>
    </div>
  );
}
