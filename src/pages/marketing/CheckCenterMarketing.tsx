import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  ScanLine,
  ShieldCheck,
  Building2,
  Share2,
  Inbox,
  Send,
  FileCheck,
  Landmark,
  ClipboardCheck,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
  Sparkles,
  LogIn,
  Menu,
  X,
  Users,
  Lock,
  Zap,
  LineChart,
} from "lucide-react";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";

const HeroMockup = () => (
  <div className="relative rounded-xl border border-border/60 bg-card/80 backdrop-blur shadow-2xl overflow-hidden">
    {/* Fake window chrome */}
    <div className="h-8 border-b border-border/50 bg-muted/40 flex items-center px-3 gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full bg-destructive/70" />
      <span className="h-2.5 w-2.5 rounded-full bg-warning/70" />
      <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
      <span className="ml-3 text-[10px] text-muted-foreground font-mono">checkops.app</span>
    </div>
    <div className="p-4 md:p-6 space-y-4">
      {/* Dashboard cards */}
      <div className="grid grid-cols-4 gap-2 md:gap-3">
        {[
          { label: "Manual Review", count: 4, icon: AlertTriangle, color: "text-orange-400", bg: "bg-orange-500/10" },
          { label: "Branch Deposit", count: 12, icon: Building2, color: "text-blue-400", bg: "bg-blue-500/10" },
          { label: "Reissue", count: 2, icon: RotateCcw, color: "text-amber-400", bg: "bg-amber-500/10" },
          { label: "Approved", count: 27, icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-500/10" },
        ].map((c) => (
          <div key={c.label} className="rounded-lg border border-border/60 bg-card p-2.5 md:p-3 flex items-center gap-2">
            <div className={`p-1.5 rounded-md ${c.bg} ${c.color}`}>
              <c.icon className="h-3.5 w-3.5 md:h-4 md:w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-lg md:text-xl font-bold leading-none">{c.count}</p>
              <p className="text-[9px] md:text-[10px] text-muted-foreground truncate">{c.label}</p>
            </div>
          </div>
        ))}
      </div>
      {/* Tabs */}
      <div className="flex gap-1 border-b border-border/50 text-[11px] overflow-x-auto">
        {[
          { l: "Intake", icon: Inbox, active: false },
          { l: "Review", icon: ClipboardCheck, active: true },
          { l: "Endorsing", icon: Send, active: false },
          { l: "Ready", icon: FileCheck, active: false },
          { l: "Loss Draft", icon: Landmark, active: false },
        ].map((t) => (
          <div
            key={t.l}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-t-md whitespace-nowrap ${
              t.active ? "bg-primary/15 text-primary border-b-2 border-primary" : "text-muted-foreground"
            }`}
          >
            <t.icon className="h-3 w-3" />
            {t.l}
          </div>
        ))}
      </div>
      {/* Check row */}
      <div className="space-y-2">
        {[
          { payee: "John & Jane Smith", amount: "$24,850.00", carrier: "Allstate", status: "Ready", statusColor: "bg-emerald-500/15 text-emerald-400" },
          { payee: "Condition One Restoration", amount: "$12,400.00", carrier: "State Farm", status: "Endorsing", statusColor: "bg-amber-500/15 text-amber-400" },
          { payee: "Wells Fargo Mortgage", amount: "$87,200.00", carrier: "Travelers", status: "Loss Draft", statusColor: "bg-orange-500/15 text-orange-400" },
        ].map((r, i) => (
          <div key={i} className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/20 p-2.5">
            <div className="h-8 w-12 rounded bg-gradient-to-br from-emerald-500/20 to-blue-500/20 border border-border/40 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{r.payee}</p>
              <p className="text-[10px] text-muted-foreground">{r.carrier} • Check #{4501 + i}</p>
            </div>
            <div className="text-xs font-mono font-semibold hidden sm:block">{r.amount}</div>
            <span className={`text-[9px] px-2 py-0.5 rounded-full ${r.statusColor}`}>{r.status}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

export default function CheckCenterMarketing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", company: "", role: "", notes: "" });

  const handleDemoSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.email) {
      toast.error("Please fill in your name and email");
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await supabase.functions.invoke("demo-request", { body: form });
      if (error) throw error;
      toast.success("Request received. We'll reach out shortly.");
      setForm({ name: "", email: "", company: "", role: "", notes: "" });
    } catch (err) {
      // Fallback: mailto
      window.location.href = `mailto:hello@freedomclaims.work?subject=Check Center Demo Request&body=${encodeURIComponent(
        `Name: ${form.name}\nEmail: ${form.email}\nCompany: ${form.company}\nRole: ${form.role}\n\n${form.notes}`
      )}`;
    } finally {
      setSubmitting(false);
    }
  };

  const capabilities = [
    {
      icon: ScanLine,
      title: "OCR-powered intake",
      desc: "Drop a photo or PDF. We extract amount, check number, carrier, issue date, and every payee line — then flag anomalies before they hit your ledger.",
    },
    {
      icon: ClipboardCheck,
      title: "Structured review queue",
      desc: "Manual Review, Endorsing, Ready, Loss Draft — every check has exactly one place to be, with a clear next action and an auditable decision trail.",
    },
    {
      icon: Send,
      title: "Digital endorsements",
      desc: "Send secure endorsement links via email or SMS. Payees sign from any device. Full signature image, IP, and consent captured per payee.",
    },
    {
      icon: Landmark,
      title: "Loss draft tracking",
      desc: "Purpose-built workflow for mortgage company disbursements. Track sent/received dates, tracking numbers, draws, and final release — in one view.",
    },
    {
      icon: Share2,
      title: "Partner sharing",
      desc: "Share a specific check with a restoration partner or contractor. They see only what you share, can upload loss-draft documents, and can never edit your data.",
    },
    {
      icon: ShieldCheck,
      title: "Owner-only controls",
      desc: "Partner tenants get strict read-only access to shared checks. All edits, status transitions, and payee changes stay locked to the owner tenant.",
    },
  ];

  const workflow = [
    { step: "01", title: "Upload", desc: "Photo, scan, or PDF. Front and back captured with OCR heartbeat monitoring." },
    { step: "02", title: "Review", desc: "Verify extracted data, correct payees, confirm amount. One-click approve to the right lane." },
    { step: "03", title: "Endorse", desc: "Each payee signs digitally. Track who's signed, who's pending, who's waived." },
    { step: "04", title: "Deposit", desc: "Ready-for-deposit packet generated automatically. Branch or electronic — your call." },
    { step: "05", title: "Monitor", desc: "Loss draft disbursements, reissue requests, and cleared status — all tracked to close." },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top Nav */}
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center justify-between">
          <CheckOpsLogo className="text-foreground text-base" />
          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#capabilities" className="hover:text-foreground transition-colors">Capabilities</a>
            <a href="#workflow" className="hover:text-foreground transition-colors">Workflow</a>
            <a href="#partners" className="hover:text-foreground transition-colors">Partners</a>
            <a href="#security" className="hover:text-foreground transition-colors">Security</a>
            <a href="#demo" className="hover:text-foreground transition-colors">Demo</a>
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link to="/auth"><LogIn className="h-4 w-4 mr-1.5" />Log in</Link>
            </Button>
            <Button asChild size="sm">
              <a href="#demo">Book a demo<ArrowRight className="h-4 w-4 ml-1.5" /></a>
            </Button>
            <button className="md:hidden p-2" onClick={() => setMenuOpen(!menuOpen)} aria-label="Menu">
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <div className="md:hidden border-t border-border/40 bg-background/95 backdrop-blur px-4 py-3 space-y-2 text-sm">
            {["capabilities", "workflow", "partners", "security", "demo"].map((s) => (
              <a key={s} href={`#${s}`} onClick={() => setMenuOpen(false)} className="block py-1.5 capitalize text-muted-foreground">
                {s}
              </a>
            ))}
            <Link to="/auth" className="block py-1.5 text-foreground font-medium">Log in</Link>
          </div>
        )}
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none opacity-70"
          style={{
            backgroundImage:
              "radial-gradient(ellipse at 20% 0%, hsl(217 91% 60% / 0.18) 0%, transparent 50%), radial-gradient(ellipse at 85% 15%, hsl(200 80% 54% / 0.14) 0%, transparent 45%)",
          }}
        />
        <div className="relative mx-auto max-w-7xl px-4 md:px-6 pt-14 md:pt-24 pb-16 md:pb-24 grid lg:grid-cols-2 gap-10 lg:gap-16 items-center">
          <div>
            <Badge variant="outline" className="mb-5 gap-1.5 border-primary/30 bg-primary/5 text-primary">
              <Sparkles className="h-3 w-3" />
              Built for teams that handle insurance checks
            </Badge>
            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05]">
              Every check.
              <br />
              <span className="bg-gradient-to-r from-primary via-blue-400 to-cyan-300 bg-clip-text text-transparent">
                Locked on target.
              </span>
            </h1>
            <p className="mt-5 text-lg text-muted-foreground max-w-xl leading-relaxed">
              From intake to deposit to loss draft — move insurance checks through a single,
              auditable pipeline. OCR, digital endorsements, partner sharing, and mortgage
              tracking in one workspace.
            </p>
            <div className="mt-8 flex flex-col sm:flex-row gap-3">
              <Button asChild size="lg" className="text-base">
                <a href="#demo">Book a live demo<ArrowRight className="h-4 w-4 ml-2" /></a>
              </Button>
              <Button asChild size="lg" variant="outline" className="text-base">
                <Link to="/auth">Sign in</Link>
              </Button>
            </div>
            <div className="mt-8 flex items-center gap-6 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Audit trail on every action</div>
              <div className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> Role-based access</div>
            </div>
          </div>
          <div className="relative">
            <div className="absolute -inset-6 bg-gradient-to-tr from-primary/20 via-transparent to-blue-400/10 blur-3xl" />
            <div className="relative">
              <HeroMockup />
            </div>
          </div>
        </div>
      </section>

      {/* Stat strip */}
      <section className="border-y border-border/40 bg-card/30">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-8 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          {[
            { n: "5+", l: "Status lanes" },
            { n: "100%", l: "Audit-logged" },
            { n: "2-sided", l: "OCR capture" },
            { n: "1 view", l: "Loss draft to close" },
          ].map((s) => (
            <div key={s.l}>
              <p className="text-2xl md:text-3xl font-bold bg-gradient-to-b from-foreground to-muted-foreground bg-clip-text text-transparent">{s.n}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.l}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Capabilities */}
      <section id="capabilities" className="mx-auto max-w-7xl px-4 md:px-6 py-20 md:py-28">
        <div className="max-w-2xl">
          <Badge variant="outline" className="mb-4">Capabilities</Badge>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
            Purpose-built for the check lifecycle.
          </h2>
          <p className="mt-4 text-muted-foreground text-lg">
            Not a generic inbox with tags. A structured pipeline that knows the difference
            between a payee awaiting signature and a mortgage company holding funds.
          </p>
        </div>
        <div className="mt-12 grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {capabilities.map((c) => (
            <Card key={c.title} className="border-border/50 bg-card/60 hover:bg-card/80 hover:border-primary/30 transition-all group">
              <CardContent className="p-6">
                <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <c.icon className="h-5 w-5" />
                </div>
                <h3 className="font-semibold mb-2">{c.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{c.desc}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Workflow */}
      <section id="workflow" className="border-t border-border/40 bg-gradient-to-b from-transparent via-card/20 to-transparent">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20 md:py-28">
          <div className="max-w-2xl">
            <Badge variant="outline" className="mb-4">Workflow</Badge>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
              Five stages. Zero ambiguity.
            </h2>
            <p className="mt-4 text-muted-foreground text-lg">
              Every check in the system has exactly one status and exactly one next action.
              Your team stops guessing. Partners stop emailing.
            </p>
          </div>
          <div className="mt-12 grid md:grid-cols-5 gap-4">
            {workflow.map((w, i) => (
              <div key={w.step} className="relative">
                <div className="rounded-xl border border-border/50 bg-card/70 p-5 h-full hover:border-primary/40 transition-colors">
                  <p className="text-xs font-mono text-primary/70 mb-3">{w.step}</p>
                  <h3 className="font-semibold mb-2">{w.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">{w.desc}</p>
                </div>
                {i < workflow.length - 1 && (
                  <ArrowRight className="hidden md:block absolute top-1/2 -right-3 -translate-y-1/2 h-4 w-4 text-border z-10" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Partners */}
      <section id="partners" className="mx-auto max-w-7xl px-4 md:px-6 py-20 md:py-28">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <Badge variant="outline" className="mb-4">Partner sharing</Badge>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
              Collaborate without compromising control.
            </h2>
            <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
              Public adjusters share specific checks with restoration partners. Partners upload
              loss-draft documents and monitor status. Only the owner tenant can edit — enforced
              at the database with row-level security.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                { icon: Share2, t: "Share one check or many — partners only see what you share" },
                { icon: Lock, t: "Read-only UI for partners, enforced with RLS at the data layer" },
                { icon: Users, t: "Partners upload documents for loss-draft workflows" },
                { icon: LineChart, t: "Both sides see the same real-time status" },
              ].map((f) => (
                <li key={f.t} className="flex gap-3 items-start">
                  <div className="h-6 w-6 rounded-md bg-primary/10 text-primary flex items-center justify-center flex-shrink-0 mt-0.5">
                    <f.icon className="h-3.5 w-3.5" />
                  </div>
                  <span className="text-sm text-muted-foreground">{f.t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="relative">
            <Card className="border-border/50 bg-card/60 overflow-hidden">
              <CardContent className="p-0">
                <div className="p-5 border-b border-border/40 bg-muted/20 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-primary" />
                    <span className="text-sm font-semibold">Condition One Restoration</span>
                  </div>
                  <Badge variant="outline" className="text-[10px] border-blue-500/30 text-blue-400 bg-blue-500/10 gap-1">
                    <Share2 className="h-2.5 w-2.5" /> Shared by Freedom
                  </Badge>
                </div>
                <div className="p-5 space-y-3">
                  <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-xs text-blue-300">
                    <Lock className="h-3.5 w-3.5 inline mr-1.5" />
                    Shared check — read only. Upload loss-draft documents below.
                  </div>
                  <div className="space-y-2">
                    {[
                      { l: "Amount", v: "$87,200.00" },
                      { l: "Carrier", v: "Travelers" },
                      { l: "Check #", v: "4503" },
                      { l: "Status", v: "Loss Draft — Sent" },
                    ].map((r) => (
                      <div key={r.l} className="flex justify-between items-center text-xs">
                        <span className="text-muted-foreground">{r.l}</span>
                        <span className="font-mono">{r.v}</span>
                      </div>
                    ))}
                  </div>
                  <Button variant="outline" size="sm" className="w-full text-xs">
                    <ClipboardCheck className="h-3.5 w-3.5 mr-1.5" />
                    Upload loss-draft documents
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Security */}
      <section id="security" className="border-t border-border/40 bg-card/20">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20 md:py-28">
          <div className="max-w-2xl">
            <Badge variant="outline" className="mb-4">Security & audit</Badge>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
              Built for money that has to be tracked.
            </h2>
          </div>
          <div className="mt-10 grid md:grid-cols-3 gap-4">
            {[
              { icon: ShieldCheck, t: "Row-level security", d: "Every table enforces tenant isolation at the database. Not just the UI." },
              { icon: FileCheck, t: "Full audit log", d: "Every upload, edit, status change, endorsement, and decision is recorded with actor and timestamp." },
              { icon: Lock, t: "Role-based access", d: "Admin-only surfaces for Check Center and deposit operations. Staff and partners get only what they need." },
              { icon: Users, t: "Multi-tenant by design", d: "Each firm's data is fully isolated. Partner sharing is explicit, scoped, and revocable." },
              { icon: Zap, t: "OCR heartbeat monitoring", d: "Stuck jobs are detected and auto-recovered so nothing sits in limbo." },
              { icon: LineChart, t: "Real-time dashboard", d: "Counts by lane refresh automatically. Spot pileups before they become problems." },
            ].map((f) => (
              <div key={f.t} className="rounded-xl border border-border/50 bg-card/60 p-5">
                <div className="h-9 w-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center mb-4">
                  <f.icon className="h-4 w-4" />
                </div>
                <h3 className="font-semibold text-sm mb-2">{f.t}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Demo CTA */}
      <section id="demo" className="mx-auto max-w-7xl px-4 md:px-6 py-20 md:py-28">
        <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 items-start">
          <div>
            <Badge variant="outline" className="mb-4">Book a demo</Badge>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
              See it with your own checks.
            </h2>
            <p className="mt-4 text-muted-foreground text-lg leading-relaxed">
              A 20-minute live walkthrough. Bring a sample check photo — we'll run it through
              intake, review, endorsement, and show you exactly what partner sharing looks like
              from both sides.
            </p>
            <div className="mt-8 space-y-3">
              {[
                "Tailored to your workflow — PA firm or restoration partner",
                "See live OCR, endorsement flows, and loss-draft tracking",
                "Q&A on pricing, onboarding, and white-label options",
              ].map((t) => (
                <div key={t} className="flex items-start gap-2.5">
                  <CheckCircle2 className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                  <span className="text-sm text-muted-foreground">{t}</span>
                </div>
              ))}
            </div>
          </div>
          <Card className="border-border/50 bg-card/60">
            <CardContent className="p-6 md:p-8">
              <form onSubmit={handleDemoSubmit} className="space-y-4">
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="name" className="text-xs">Name *</Label>
                    <Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" required />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="email" className="text-xs">Work email *</Label>
                    <Input id="email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="jane@firm.com" required />
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="company" className="text-xs">Company</Label>
                    <Input id="company" value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Firm or contractor" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="role" className="text-xs">Role</Label>
                    <Input id="role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="PA, Owner, Ops" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="notes" className="text-xs">What would you like to see?</Label>
                  <Textarea id="notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Volume of checks, partner sharing interest, loss draft use case…" rows={3} />
                </div>
                <Button type="submit" size="lg" className="w-full" disabled={submitting}>
                  {submitting ? "Sending…" : "Request demo"}
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
                <p className="text-[10px] text-muted-foreground text-center">
                  By submitting, you agree to be contacted about ChecksOps.
                </p>
              </form>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/40 bg-card/30">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <CheckOpsLogo className="text-foreground text-sm" />
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} ChecksOps. All rights reserved.
          </p>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <Link to="/auth" className="hover:text-foreground">Sign in</Link>
            <a href="#demo" className="hover:text-foreground">Book demo</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
