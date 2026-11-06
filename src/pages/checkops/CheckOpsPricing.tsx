import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  CheckCircle2,
  Sparkles,
  LogIn,
  ShieldCheck,
  Lock,
  Infinity as InfinityIcon,
  Receipt,
  Wrench,
  Building2,
} from "lucide-react";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";
import { MarketingMenuButton, MarketingMobileMenu } from "@/components/marketing/MarketingMobileMenu";
import { usePageMeta } from "@/hooks/usePageMeta";
import { TestimonialWall } from "@/components/marketing/MarketingProof";
import { COMPARISON_LINKS, PRICING_EXAMPLE, PRICING_PAGE } from "@/pages/marketing/marketingPages";
import { PUBLISHED_PRICING, ROLLOUT_GUARANTEE } from "@/pages/marketing/marketingPricing";

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

const PRICING_NAV_ITEMS = [
  { label: "Capabilities", href: "/#capabilities" },
  { label: "Workflow", href: "/#workflow" },
  { label: "Security", href: "/#security" },
  { label: "Pricing", href: "/pricing" },
];

const platformIncludes = [
  "Unlimited users across your company",
  "Claim-centered check organization & audit log",
  "Endorsement workflows (digital + manual signatures)",
  "Loss draft visibility & mortgage tracking",
  "Deposit operations dashboard & reconciliation",
  "Role-based access controls",
  "Backend, storage, and AI document intelligence included",
  "Dedicated onboarding & training",
];

export default function CheckOpsPricing() {
  const [menuOpen, setMenuOpen] = useState(false);
  usePageMeta(PRICING_PAGE);
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header — mirrors marketing */}
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center min-h-[44px]">
            <CheckOpsLogo className="text-foreground h-9 sm:h-10 md:h-12" />
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <Link to="/#capabilities" className="hover:text-foreground transition-colors">Capabilities</Link>
            <Link to="/#workflow" className="hover:text-foreground transition-colors">Workflow</Link>
            <Link to="/#security" className="hover:text-foreground transition-colors">Security</Link>
            <span className="text-foreground font-medium">Pricing</span>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link to="/login"><LogIn className="h-4 w-4 mr-1.5" />Log in</Link>
            </Button>
            <Button asChild size="sm" className="h-11 sm:h-9">
              <Link to="/#demo">Talk to us<ArrowRight className="h-4 w-4 ml-1.5" /></Link>
            </Button>
            <MarketingMenuButton open={menuOpen} onToggle={() => setMenuOpen(!menuOpen)} />
          </div>
        </div>
        <MarketingMobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} items={PRICING_NAV_ITEMS} demoHref="/#demo" />
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(ellipse at 20% 0%, hsl(69 32% 40% / 0.18) 0%, transparent 50%), radial-gradient(ellipse at 85% 15%, hsl(75 28% 45% / 0.14) 0%, transparent 45%)",
          }}
        />
        <div className="relative mx-auto max-w-5xl px-4 md:px-6 pt-14 md:pt-20 pb-10 text-center">
          <Badge variant="outline" className="mb-5 gap-1.5 border-primary/30 bg-primary/5 text-primary">
            <Sparkles className="h-3 w-3" />
            Straightforward pricing, published for PA firms evaluating at scale
          </Badge>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight leading-[1.05]">
            Simple, predictable
            <br />
            <span className="bg-gradient-to-r from-primary via-[#7d8548] to-[#c4cb92] bg-clip-text text-transparent">
              ChecksOps pricing.
            </span>
          </h1>
          <p className="mt-5 text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            One platform fee. One per-check rate. One support plan. No per-seat charges,
            no usage caps, no surprises. Built for firms that process insurance claim checks at scale.
          </p>
        </div>
      </section>

      {/* Three pricing cards */}
      <section className="mx-auto max-w-7xl px-4 md:px-6 pb-12">
        <div className="grid md:grid-cols-3 gap-4 md:gap-6">
          {/* Platform */}
          <Card className="border-border/50 bg-card/60 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary via-[#7d8548] to-[#c4cb92]" />
            <CardContent className="p-6 md:p-8">
              <div className="flex items-center gap-2 text-primary mb-3">
                <Building2 className="h-5 w-5" />
                <span className="text-xs font-semibold tracking-wider">Platform</span>
              </div>
              <h3 className="text-xl font-bold">ChecksOps System</h3>
              <p className="text-xs text-muted-foreground mt-1">One-time, per company</p>
              <div className="mt-5 flex items-baseline gap-1">
                <span className="text-4xl md:text-5xl font-bold">{PUBLISHED_PRICING.platformFee}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                <InfinityIcon className="h-3.5 w-3.5" /> Unlimited users included
              </p>
              <p className="text-xs text-foreground/80 mt-3 leading-relaxed">
                One platform fee replaces the hours your team loses per check to inbox, printer and bank-branch tracking.
              </p>
              <div className="my-6 h-px bg-border/60" />
              <p className="text-sm text-muted-foreground leading-relaxed">
                Full ChecksOps platform license for your company. Onboard your entire
                team — operations, processors, managers, admins — at no additional
                per-seat cost.
              </p>
            </CardContent>
          </Card>

          {/* Per check — featured */}
          <Card className="border-primary/40 bg-card/80 relative overflow-hidden ring-1 ring-primary/20 md:scale-[1.02]">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary via-[#596032] to-primary" />
            <Badge className="absolute top-4 right-4 bg-primary/15 text-primary border-primary/30 hover:bg-primary/15">
              Recommended
            </Badge>
            <CardContent className="p-6 md:p-8">
              <div className="flex items-center gap-2 text-primary mb-3">
                <Receipt className="h-5 w-5" />
                <span className="text-xs font-semibold tracking-wider">Per Check</span>
              </div>
              <h3 className="text-xl font-bold">Processing Rate</h3>
              <p className="text-xs text-muted-foreground mt-1">Billed monthly on usage</p>
              <div className="mt-5 flex items-baseline gap-1">
                <span className="text-4xl md:text-5xl font-bold">{PUBLISHED_PRICING.perCheck}</span>
                <span className="text-sm text-muted-foreground">/ check</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">No minimums, no caps</p>
              <div className="my-6 h-px bg-border/60" />
              <p className="text-sm text-muted-foreground leading-relaxed">
                Pay only for checks processed through ChecksOps — endorsements,
                deposits, loss draft tracking, and audit-logged workflow all
                included in the per-check rate.
              </p>
            </CardContent>
          </Card>

          {/* Maintenance */}
          <Card className="border-border/50 bg-card/60 relative overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#c4cb92] via-[#7d8548] to-primary" />
            <CardContent className="p-6 md:p-8">
              <div className="flex items-center gap-2 text-primary mb-3">
                <Wrench className="h-5 w-5" />
                <span className="text-xs font-semibold tracking-wider">Maintenance</span>
              </div>
              <h3 className="text-xl font-bold">Support & Updates</h3>
              <p className="text-xs text-muted-foreground mt-1">Choose monthly or annual</p>
              <div className="mt-5 space-y-2">
                <div className="flex items-baseline gap-1">
                  <span className="text-3xl md:text-4xl font-bold">{PUBLISHED_PRICING.supportMonthly}</span>
                  <span className="text-sm text-muted-foreground">/ month</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">or</span>
                  <span className="text-lg font-semibold">{PUBLISHED_PRICING.supportAnnual} paid annually</span>
                  <Badge variant="outline" className="text-[10px] border-success/40 text-success">
                    Save $200
                  </Badge>
                </div>
              </div>
              <div className="my-6 h-px bg-border/60" />
              <p className="text-sm text-muted-foreground leading-relaxed">
                Ongoing platform maintenance, security patches, infrastructure,
                feature updates, and standard support. Required for all
                deployments.
              </p>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Worked example: the first-year total a buyer actually needs */}
      <section className="mx-auto max-w-5xl px-4 md:px-6 pb-14 md:pb-20">
        <div className="rounded-2xl border border-border/50 bg-card/60 p-6 md:p-8">
          <Badge variant="outline" className="mb-4">Worked example</Badge>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
            A firm processing {PRICING_EXAMPLE.checksPerMonth} checks a month
          </h2>
          <p className="mt-3 text-sm md:text-base text-muted-foreground leading-relaxed">
            pays {PUBLISHED_PRICING.platformFee} once, plus {usd(PRICING_EXAMPLE.checksMonthly)} a month in checks
            and {PUBLISHED_PRICING.supportMonthly} a month in support.
          </p>
          <div className="mt-6 grid sm:grid-cols-3 gap-3">
            <div className="rounded-lg border border-border/50 bg-background/40 p-4">
              <p className="text-xs text-muted-foreground">First year, support paid monthly</p>
              <p className="mt-1 text-2xl font-bold">{usd(PRICING_EXAMPLE.firstYearMonthlySupport)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {PUBLISHED_PRICING.platformFee} + {PRICING_EXAMPLE.checksPerYear.toLocaleString("en-US")} checks × {PUBLISHED_PRICING.perCheck} + 12 × {PUBLISHED_PRICING.supportMonthly}
              </p>
            </div>
            <div className="rounded-lg border border-border/50 bg-background/40 p-4">
              <p className="text-xs text-muted-foreground">First year, support paid annually</p>
              <p className="mt-1 text-2xl font-bold">{usd(PRICING_EXAMPLE.firstYearAnnualSupport)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {PUBLISHED_PRICING.platformFee} + {PRICING_EXAMPLE.checksPerYear.toLocaleString("en-US")} checks × {PUBLISHED_PRICING.perCheck} + {PUBLISHED_PRICING.supportAnnual}
              </p>
            </div>
            <div className="rounded-lg border border-border/50 bg-background/40 p-4">
              <p className="text-xs text-muted-foreground">Every year after, support paid annually</p>
              <p className="mt-1 text-2xl font-bold">{usd(PRICING_EXAMPLE.yearTwoAnnualSupport)}</p>
              <p className="mt-1 text-xs text-muted-foreground">No platform fee again. Same {PUBLISHED_PRICING.perCheck} per check.</p>
            </div>
          </div>
          <p className="mt-6 text-sm md:text-base text-muted-foreground leading-relaxed">
            Weigh that against what each check costs your team today: the hours lost to inbox, printer
            and bank-branch tracking, chasing payee signatures, and answering "where is my check?"
            calls. The platform fee is paid once; after that, a check costs {PUBLISHED_PRICING.perCheck}{" "}
            whatever its amount or payee, with no percentage on mortgage checks.
          </p>
        </div>
      </section>

      {/* Customer proof: hidden until marketingProof.ts TESTIMONIALS has real quotes */}
      <TestimonialWall />

      {/* What's included */}
      <section className="border-y border-border/40 bg-muted/20">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-14 md:py-20 grid gap-10 lg:grid-cols-[0.9fr_1.1fr] items-start">
          <div>
            <Badge variant="outline" className="mb-4">Everything included</Badge>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight">
              No tiers, no hidden modules.
            </h2>
            <p className="mt-3 text-sm md:text-base text-muted-foreground leading-relaxed">
              Every ChecksOps deployment includes the full platform — every user,
              every workflow, every report. The pricing above is the complete
              picture for your company.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            {platformIncludes.map((item) => (
              <div
                key={item}
                className="flex items-start gap-3 rounded-lg border border-border/50 bg-card/60 p-4"
              >
                <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                <span className="text-sm text-foreground/90 leading-snug">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-5xl px-4 md:px-6 pb-20">
        <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card/60 to-card/40 p-8 md:p-12 text-center">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Ready to move forward?</h2>
          <p className="mt-3 text-muted-foreground max-w-xl mx-auto">
            We'll set up your environment, migrate any historical data, and train your
            team. Most companies are live within two weeks.
          </p>
          {ROLLOUT_GUARANTEE && (
            <p className="mt-3 text-sm text-foreground/90">
              {ROLLOUT_GUARANTEE.text}{" "}
              <Link to={ROLLOUT_GUARANTEE.termsPath} className="underline underline-offset-2 hover:text-foreground">Terms</Link>
            </p>
          )}
          <p className="mt-3 text-sm text-muted-foreground">
            Comparing options?{" "}
            {COMPARISON_LINKS.map((l, i) => (
              <span key={l.to}>
                {i > 0 && " · "}
                <Link to={l.to} className="underline underline-offset-2 hover:text-foreground">{l.label}</Link>
              </span>
            ))}
          </p>
          <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center">
            <Button asChild size="lg">
              <Link to="/#demo">Schedule onboarding<ArrowRight className="h-4 w-4 ml-2" /></Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/login">Sign in</Link>
            </Button>
          </div>
          <div className="mt-6 flex flex-wrap justify-center items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Audit trail on every action</div>
            <div className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> Role-based access</div>
          </div>
        </div>
      </section>

      <footer className="border-t border-border/40">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <CheckOpsLogo className="text-foreground text-sm" />
            <span>© {new Date().getFullYear()} ChecksOps</span>
          </div>
          <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 [&>a]:inline-flex [&>a]:items-center [&>a]:min-h-[44px] sm:[&>a]:min-h-0">
            <Link to="/" className="hover:text-foreground">Home</Link>
            {COMPARISON_LINKS.map((l) => (
              <Link key={l.to} to={l.to} className="hover:text-foreground">{l.label}</Link>
            ))}
            <Link to="/privacy-notice" className="hover:text-foreground">Privacy Notice</Link>
            <Link to="/terms" className="hover:text-foreground">Terms of Service</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="px-5 py-4 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
      <p className="text-lg font-semibold whitespace-nowrap">{value}</p>
    </div>
  );
}
