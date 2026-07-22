import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  LogIn,
  ShieldCheck,
  Lock,
  KeyRound,
  Database,
  FileCheck2,
  Building2,
  Users,
  Eye,
  AlertTriangle,
  ScrollText,
  Server,
  Fingerprint,
  Landmark,
} from "lucide-react";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";

const pillars = [
  {
    icon: Lock,
    title: "Encryption everywhere",
    body: "TLS 1.2+ in transit. AES-256 at rest. Bank account and routing numbers are encrypted at the field level with pgsodium (libsodium) before they ever touch disk — a raw database dump reveals only ciphertext.",
  },
  {
    icon: Database,
    title: "Private storage, signed URLs only",
    body: "Every check image, endorsement packet, loss-draft document, and deposit attachment lives in a private bucket. Files are served only through short-lived signed URLs — never public links.",
  },
  {
    icon: Fingerprint,
    title: "Tenant-isolated by default",
    body: "Row-Level Security on every table, scoped to your tenant. One firm can never see another firm's checks, claims, homeowners, or bank information — enforced at the database layer, not the app.",
  },
  {
    icon: KeyRound,
    title: "MFA, SSO, and leaked-password protection",
    body: "TOTP available for every user, required for admin and staff. SAML SSO for enterprise tenants. Have-I-Been-Pwned checks block compromised passwords at signup and reset.",
  },
  {
    icon: Eye,
    title: "PII masked by default",
    body: "Sensitive fields render masked in the UI. Every reveal is logged with user, timestamp, and reason to pii_reveal_logs so you always know who saw what.",
  },
  {
    icon: ScrollText,
    title: "7-year immutable audit trail",
    body: "Every privileged action, status change, deposit, endorsement, and admin override is logged and retained for seven years across audit_logs, check_audit_log, deposit_audit_log, and glba_security_events.",
  },
];

const bankingControls = [
  {
    icon: Landmark,
    title: "Non-custodial by design",
    body: "ChecksOps never holds, pools, or routes funds through a ChecksOps-owned account. Deposits go straight to your bank through our bank-grade deposit rail. Disbursements originate through our ACH processor directly to the recipient's bank.",
  },
  {
    icon: FileCheck2,
    title: "Micro-deposit account validation",
    body: "WEB Debit Rule compliant. Every recipient bank account is validated with micro-deposits before any ACH debit or credit is originated.",
  },
  {
    icon: ShieldCheck,
    title: "Duplicate & fraud screening",
    body: "Our deposit rail runs duplicate-check detection and image fraud screening on every deposit. Our ACH processor performs OFAC screening and return management on every ACH.",
  },
  {
    icon: AlertTriangle,
    title: "Velocity, volume & return-rate monitoring",
    body: "NACHA-aligned rolling return-rate tracking, per-tenant volume limits, and behavioral flags. Documented in our ACH Risk and Fraud Monitoring Policy (effective 2026-06-22).",
  },
];

const compliance = [
  {
    title: "FTC Safeguards Rule / GLBA",
    body: "Full Written Information Security Program with a designated Qualified Individual, annual risk assessments, annual third-party penetration tests, and vulnerability assessments every six months.",
  },
  {
    title: "BSA / AML program",
    body: "Designated AML Officer, KYC and beneficial-owner verification at tenant onboarding, ongoing transaction monitoring, SAR filing capability, and independent review at least every 18 months.",
  },
  {
    title: "NACHA ACH Risk & Fraud Monitoring",
    body: "Fully documented origination risk framework, calibrated for restoration-industry ticket sizes and post-catastrophe velocity spikes.",
  },
  {
    title: "State-law breach notification",
    body: "FTC notified within 30 days for any breach affecting 500+ consumers. Affected consumers notified per applicable state law timelines.",
  },
];

const vendors = [
  { name: "Supabase / Lovable Cloud", purpose: "Database, auth, storage, edge compute" },
  { name: "Bank-grade deposit processor", purpose: "Remote check deposit rail" },
  { name: "ACH origination partner", purpose: "ACH disbursement rail" },
  { name: "OpenAI", purpose: "AI inference on redacted claim text" },
  { name: "Tavily", purpose: "Non-PII web search" },
  { name: "Resend / Mailgun", purpose: "Transactional email delivery" },
];

export default function CheckOpsSecurity() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header — mirrors marketing */}
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center justify-between">
          <Link to="/">
            <CheckOpsLogo className="text-foreground text-base" />
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <Link to="/#capabilities" className="hover:text-foreground transition-colors">Capabilities</Link>
            <Link to="/#workflow" className="hover:text-foreground transition-colors">Workflow</Link>
            <span className="text-foreground font-medium">Security</span>
            <Link to="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link to="/login"><LogIn className="h-4 w-4 mr-1.5" />Log in</Link>
            </Button>
            <Button asChild size="sm">
              <Link to="/#demo">Talk to us<ArrowRight className="h-4 w-4 ml-1.5" /></Link>
            </Button>
          </div>
        </div>
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
            <ShieldCheck className="h-3 w-3" />
            Trust &amp; Security
          </Badge>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight leading-[1.05]">
            Bank-grade protection for
            <br />
            <span className="bg-gradient-to-r from-primary via-[#7d8548] to-[#c4cb92] bg-clip-text text-transparent">
              every check you upload.
            </span>
          </h1>
          <p className="mt-5 text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            ChecksOps is a non-custodial payments platform built for insurance restoration.
            Encryption, tenant isolation, MFA, and 7-year audit trails come standard — not as add-ons.
          </p>
          <p className="mt-3 text-xs text-muted-foreground/80 max-w-2xl mx-auto">
            This page is maintained by ChecksOps to describe the controls currently in place. It is not an independent certification.
          </p>
        </div>
      </section>

      {/* Data Protection */}
      <section className="mx-auto max-w-6xl px-4 md:px-6 py-10">
        <div className="mb-8">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Data protection</h2>
          <p className="text-muted-foreground mt-2">How we keep check images, bank information, and claim data safe.</p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {pillars.map((p) => (
            <Card key={p.title} className="border-border/60">
              <CardContent className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <p.icon className="h-4 w-4" />
                  </div>
                  <h3 className="font-semibold text-sm">{p.title}</h3>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{p.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Banking Controls */}
      <section className="mx-auto max-w-6xl px-4 md:px-6 py-10 border-t border-border/40">
        <div className="mb-8">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Banking &amp; payments security</h2>
          <p className="text-muted-foreground mt-2">Funds never sit with ChecksOps. We move value between regulated bank rails only.</p>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          {bankingControls.map((c) => (
            <Card key={c.title} className="border-border/60">
              <CardContent className="p-5">
                <div className="flex items-center gap-2 mb-3">
                  <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                    <c.icon className="h-4 w-4" />
                  </div>
                  <h3 className="font-semibold text-sm">{c.title}</h3>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">{c.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Access Control */}
      <section className="mx-auto max-w-6xl px-4 md:px-6 py-10 border-t border-border/40">
        <div className="grid md:grid-cols-2 gap-8 items-start">
          <div>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Access control</h2>
            <p className="text-muted-foreground mt-2">
              Least-privilege by default. Every role — admin, staff, mortgage agent, contractor, homeowner —
              only sees what it needs to do its job.
            </p>
          </div>
          <div className="space-y-3">
            {[
              { icon: Users, label: "Role-based permissions enforced in the database (RLS), not just the UI" },
              { icon: KeyRound, label: "MFA required for admin and staff; TOTP for every user" },
              { icon: Building2, label: "SAML SSO available for enterprise tenants" },
              { icon: Server, label: "Idle-timeout, server-side session validation, and remote revocation" },
              { icon: Eye, label: "Quarterly access reviews of admin and staff lists" },
            ].map((row) => (
              <div key={row.label} className="flex items-start gap-3 p-3 rounded-lg border border-border/50 bg-card/40">
                <row.icon className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                <p className="text-sm">{row.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Compliance */}
      <section className="mx-auto max-w-6xl px-4 md:px-6 py-10 border-t border-border/40">
        <div className="mb-8">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Compliance &amp; governance</h2>
          <p className="text-muted-foreground mt-2">Documented programs, reviewed annually, aligned to the regulations that govern payments and consumer data.</p>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          {compliance.map((c) => (
            <Card key={c.title} className="border-border/60">
              <CardContent className="p-5">
                <h3 className="font-semibold text-sm mb-2">{c.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{c.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Subprocessors */}
      <section className="mx-auto max-w-6xl px-4 md:px-6 py-10 border-t border-border/40">
        <div className="mb-6">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Subprocessors</h2>
          <p className="text-muted-foreground mt-2">Every vendor operates under a written addendum with annual security review. Access is revoked within 24 hours of contract termination.</p>
        </div>
        <div className="rounded-xl border border-border/60 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Vendor</th>
                <th className="text-left px-4 py-2 font-medium">Purpose</th>
              </tr>
            </thead>
            <tbody>
              {vendors.map((v, i) => (
                <tr key={v.name} className={i % 2 === 0 ? "bg-background" : "bg-muted/20"}>
                  <td className="px-4 py-2.5 font-medium">{v.name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{v.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Incident Response */}
      <section className="mx-auto max-w-6xl px-4 md:px-6 py-10 border-t border-border/40">
        <Card className="border-border/60 bg-gradient-to-br from-primary/5 to-transparent">
          <CardContent className="p-6 md:p-8">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="h-5 w-5 text-primary" />
              <h2 className="text-xl md:text-2xl font-bold tracking-tight">Incident response</h2>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed max-w-3xl">
              Documented Detection → Containment → Eradication → Recovery → Post-mortem playbook,
              tabletop-exercised annually. Retention purge runs nightly against closed claims per each tenant's configured retention window (default seven years).
            </p>
            <p className="text-sm mt-4">
              Report a security concern:{" "}
              <a href="mailto:security@checksops.com" className="text-primary font-medium hover:underline">
                security@checksops.com
              </a>
            </p>
          </CardContent>
        </Card>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-4xl px-4 md:px-6 py-14 text-center">
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight">Have a security questionnaire?</h2>
        <p className="text-muted-foreground mt-3 max-w-2xl mx-auto">
          We're happy to walk your team through our WISP, AML program, and ACH risk framework in detail.
        </p>
        <div className="mt-6 flex flex-wrap gap-3 justify-center">
          <Button asChild size="lg">
            <Link to="/#demo">Talk to us<ArrowRight className="h-4 w-4 ml-1.5" /></Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link to="/pricing">See pricing</Link>
          </Button>
        </div>
      </section>

      <footer className="border-t border-border/40 py-8 mt-10">
        <div className="mx-auto max-w-6xl px-4 md:px-6 flex flex-col md:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>© {new Date().getFullYear()} ChecksOps. All rights reserved.</p>
          <div className="flex gap-4">
            <Link to="/privacy-notice" className="hover:text-foreground">Privacy</Link>
            <Link to="/security" className="hover:text-foreground">Security</Link>
            <Link to="/pricing" className="hover:text-foreground">Pricing</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
