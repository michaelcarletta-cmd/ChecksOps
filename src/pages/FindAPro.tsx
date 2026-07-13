import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ShieldCheck, Crosshair, Star, MapPin, Search, Lock, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { HomeownerIntroRequestModal } from "@/components/networking/HomeownerIntroRequestModal";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";

const TRADE_OPTIONS: { value: string; label: string }[] = [
  { value: "general_contractor", label: "General Contractor" },
  { value: "roofing", label: "Roofing" },
  { value: "water_mitigation", label: "Water Mitigation" },
  { value: "fire_restoration", label: "Fire / Smoke Restoration" },
  { value: "mold_remediation", label: "Mold Remediation" },
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "hvac", label: "HVAC" },
  { value: "flooring", label: "Flooring" },
  { value: "windows_siding", label: "Windows & Siding" },
  { value: "public_adjuster", label: "Public Adjuster" },
  { value: "attorney", label: "Attorney (Insurance)" },
];
const TRADE_LABEL = new Map(TRADE_OPTIONS.map((t) => [t.value, t.label]));
const STATE_OPTIONS = ["FL","TX","CA","NY","GA","AZ","NC","SC","TN","VA","PA","OH","IL","CO","WA","OR","LA","AL","MS","NJ"];

type PublicContractor = {
  id: string;
  display_name: string;
  bio: string | null;
  trades: string[] | null;
  service_states: string[] | null;
  service_zip_prefixes: string[] | null;
  service_radius_miles: number | null;
  tier: string | null;
  avg_rating: number | null;
  review_count: number | null;
  jobs_count: number | null;
  verified: boolean;
  distance_miles?: number | null;
  zip_prefix_match?: boolean;
  google_rating?: number | null;
  google_review_count?: number | null;
  google_reviews_url?: string | null;
};


type Review = { rating: number; comment: string | null; created_at: string };

const GATE_KEY = "checksops.homeowner.gate.v1";

export default function FindAPro() {
  const [gate, setGate] = useState<{ email: string; zip: string } | null>(() => {
    try {
      const raw = localStorage.getItem(GATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });

  // SEO
  useEffect(() => {
    document.title = "Find a Vetted Restoration Pro | ChecksOps";
    const desc = "Browse Pro-tier, ChecksOps-verified restoration contractors and public adjusters. Real ratings from paid claims, not anonymous reviews.";
    let m = document.querySelector('meta[name="description"]');
    if (!m) { m = document.createElement("meta"); m.setAttribute("name","description"); document.head.appendChild(m); }
    m.setAttribute("content", desc);
    let c = document.querySelector('link[rel="canonical"]');
    if (!c) { c = document.createElement("link"); c.setAttribute("rel","canonical"); document.head.appendChild(c); }
    c.setAttribute("href", "/find-a-pro");
  }, []);

  if (!gate) return <Gate onSubmit={(g) => { localStorage.setItem(GATE_KEY, JSON.stringify(g)); setGate(g); }} />;
  return <Directory gate={gate} onSignOut={() => { localStorage.removeItem(GATE_KEY); setGate(null); }} />;
}

function Gate({ onSubmit }: { onSubmit: (g: { email: string; zip: string }) => void }) {
  const [email, setEmail] = useState("");
  const [zip, setZip] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const em = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) { toast.error("Enter a valid email."); return; }
    if (!/^\d{5}(-\d{4})?$/.test(zip.trim())) { toast.error("Enter a valid 5-digit ZIP."); return; }
    setLoading(true);
    onSubmit({ email: em, zip: zip.trim() });
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <PublicHeader />
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-xl">
          <div className="text-center mb-8">
            <Badge className="mb-4 gap-1.5" variant="secondary">
              <Crosshair className="h-3.5 w-3.5" strokeWidth={2.5} /> ChecksOps Verified Network
            </Badge>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4">
              Find a restoration pro who won't take your money and disappear.
            </h1>
            <p className="text-muted-foreground text-lg">
              Every contractor in this directory has passed sponsor-verified onboarding and gets paid through
              ChecksOps — so we know they're real, licensed, and accountable.
            </p>
          </div>

          <Card>
            <CardContent className="pt-6">
              <form onSubmit={submit} className="space-y-4">
                <div>
                  <label className="text-sm font-medium mb-1.5 block">Your email</label>
                  <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1.5 block">Your ZIP code</label>
                  <Input required value={zip} onChange={(e) => setZip(e.target.value)} placeholder="33101" inputMode="numeric" maxLength={10} />
                </div>
                <Button type="submit" className="w-full" size="lg" disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Browse verified pros <Search className="h-4 w-4 ml-1" /></>}
                </Button>
                <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1.5">
                  <Lock className="h-3 w-3" /> We use your info only to match you with local pros. No spam.
                </p>
              </form>
            </CardContent>
          </Card>

          <div className="grid grid-cols-3 gap-4 mt-8 text-center">
            <TrustStat n="Sponsor" label="Verified" />
            <TrustStat n="Real" label="Paid-claim ratings" />
            <TrustStat n="Pro tier" label="Only" />
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}

function TrustStat({ n, label }: { n: string; label: string }) {
  return (
    <div className="border border-border rounded-lg p-3">
      <div className="text-sm font-semibold">{n}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Directory({ gate, onSignOut }: { gate: { email: string; zip: string }; onSignOut: () => void }) {
  const [results, setResults] = useState<PublicContractor[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [trade, setTrade] = useState<string>("all");
  const [state, setState] = useState<string>("all");
  const [minRating, setMinRating] = useState<string>("0");
  const [sortBy, setSortBy] = useState<"rating" | "jobs" | "recent">("rating");
  const [selected, setSelected] = useState<PublicContractor | null>(null);
  const [selectedReviews, setSelectedReviews] = useState<Review[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("public-contractor-directory", {
      body: {
        action: "search",
        email: gate.email, zip: gate.zip,
        search,
        trades: trade === "all" ? [] : [trade],
        states: state === "all" ? [] : [state],
        minRating: Number(minRating),
        sortBy,
        limit: 48,
      },
    });
    if (error) { toast.error("Couldn't load directory"); setLoading(false); return; }
    setResults((data as any)?.results ?? []);
    setTotal((data as any)?.total ?? 0);
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [trade, state, minRating, sortBy]);

  const openDetail = async (c: PublicContractor) => {
    setSelected(c);
    setDetailLoading(true);
    const { data } = await supabase.functions.invoke("public-contractor-directory", {
      body: { action: "detail", email: gate.email, zip: gate.zip, contractorId: c.id },
    });
    setSelectedReviews((data as any)?.reviews ?? []);
    setDetailLoading(false);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PublicHeader />
      <div className="border-b border-border bg-card/40">
        <div className="max-w-6xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-2xl md:text-3xl font-bold bg-gradient-to-r from-primary via-blue-400 to-cyan-300 bg-clip-text text-transparent">Vetted Restoration Pros</h1>
              <p className="text-sm text-muted-foreground">Browsing as {gate.email} · ZIP {gate.zip} · <button onClick={onSignOut} className="underline">change</button></p>
            </div>
            <Badge variant="secondary" className="gap-1.5 hidden md:inline-flex">
              <Crosshair className="h-3.5 w-3.5" strokeWidth={2.5} /> {total} verified pros
            </Badge>
          </div>

          <form onSubmit={(e) => { e.preventDefault(); load(); }} className="grid grid-cols-1 md:grid-cols-6 gap-3">
            <div className="md:col-span-2 relative">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or specialty" className="pl-9" />
            </div>
            <Select value={trade} onValueChange={setTrade}>
              <SelectTrigger><SelectValue placeholder="Trade" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All trades</SelectItem>
                {TRADE_OPTIONS.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={state} onValueChange={setState}>
              <SelectTrigger><SelectValue placeholder="State" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All states</SelectItem>
                {STATE_OPTIONS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={minRating} onValueChange={setMinRating}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Any rating</SelectItem>
                <SelectItem value="3">3★+</SelectItem>
                <SelectItem value="4">4★+</SelectItem>
                <SelectItem value="4.5">4.5★+</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as any)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="rating">Top rated</SelectItem>
                <SelectItem value="jobs">Most jobs</SelectItem>
                <SelectItem value="recent">Newest</SelectItem>
              </SelectContent>
            </Select>
          </form>
        </div>
      </div>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <TrustStrip />

        {loading ? (
          <div className="flex items-center justify-center py-24"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : results.length === 0 ? (
          <Card><CardContent className="py-16 text-center text-muted-foreground">
            No pros match those filters. Try widening your search.
          </CardContent></Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {results.map(c => <ContractorCard key={c.id} c={c} onClick={() => openDetail(c)} />)}
          </div>
        )}
      </main>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="text-2xl">{selected.display_name}</SheetTitle>
              </SheetHeader>
              <div className="mt-4 space-y-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge className="gap-1"><Crosshair className="h-3 w-3" strokeWidth={2.5} /> Verified by ChecksOps</Badge>
                  <RatingBadge rating={selected.avg_rating} count={selected.review_count} />
                </div>
                {selected.bio && <p className="text-sm text-muted-foreground">{selected.bio}</p>}
                <div>
                  <div className="text-xs font-semibold uppercase text-muted-foreground mb-1.5">Trades</div>
                  <div className="flex flex-wrap gap-1.5">{(selected.trades ?? []).map(t => <Badge key={t} variant="outline">{TRADE_LABEL.get(t) ?? t}</Badge>)}</div>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase text-muted-foreground mb-1.5">Serves</div>
                  <div className="flex flex-wrap gap-1.5">{(selected.service_states ?? []).map(s => <Badge key={s} variant="outline">{s}</Badge>)}</div>
                </div>
                <div className="border-t border-border pt-4">
                  <div className="text-xs font-semibold uppercase text-muted-foreground mb-3">
                    Reviews from paid claims ({selectedReviews.length})
                  </div>
                  {detailLoading ? (
                    <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin" /></div>
                  ) : selectedReviews.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No written reviews yet.</p>
                  ) : (
                    <div className="space-y-3">
                      {selectedReviews.map((r, i) => (
                        <div key={i} className="border border-border rounded-md p-3">
                          <div className="flex items-center gap-1 mb-1">
                            {Array.from({ length: 5 }).map((_, idx) => (
                              <Star key={idx} className={`h-3.5 w-3.5 ${idx < r.rating ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground/40"}`} />
                            ))}
                            <span className="text-xs text-muted-foreground ml-2">{new Date(r.created_at).toLocaleDateString()}</span>
                          </div>
                          {r.comment && <p className="text-sm">{r.comment}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="border-t border-border pt-4 -mx-6 px-6 bg-muted/30 py-4 space-y-3">
                  <Button className="w-full" size="lg" onClick={() => setContactOpen(true)}>
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                    Contact this Pro
                  </Button>
                  <p className="text-[11px] text-muted-foreground text-center">
                    Your info goes straight to {selected.display_name}. ChecksOps doesn't sell your details or
                    share them with anyone else in the directory.
                  </p>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <HomeownerIntroRequestModal
        open={contactOpen}
        onOpenChange={setContactOpen}
        contractor={selected ? { id: selected.id, display_name: selected.display_name } : null}
      />

      <PublicFooter />
    </div>
  );
}


function ContractorCard({ c, onClick }: { c: PublicContractor; onClick: () => void }) {
  const local = c.zip_prefix_match || (c.distance_miles != null && c.service_radius_miles != null && c.distance_miles <= c.service_radius_miles);
  return (
    <Card onClick={onClick} className="cursor-pointer hover:border-primary transition-colors">
      <CardContent className="pt-6">
        <div className="flex items-start justify-between mb-2 gap-2">
          <h3 className="font-semibold truncate">{c.display_name}</h3>
          <Badge className="gap-1 flex-shrink-0 text-xs"><Crosshair className="h-3 w-3" strokeWidth={2.5} /> Verified</Badge>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <RatingBadge rating={c.avg_rating} count={c.review_count} />
          {local && <Badge variant="secondary" className="text-xs gap-1"><MapPin className="h-3 w-3" /> Serves your area</Badge>}
        </div>
        {c.bio && <p className="text-sm text-muted-foreground mt-2 line-clamp-2">{c.bio}</p>}
        <div className="flex flex-wrap gap-1 mt-3">
          {(c.trades ?? []).slice(0, 3).map(t => <Badge key={t} variant="outline" className="text-xs">{TRADE_LABEL.get(t) ?? t}</Badge>)}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-3">
          {c.distance_miles != null && (
            <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> ~{Math.round(c.distance_miles)} mi away</span>
          )}
          {(c.service_states ?? []).length > 0 && c.distance_miles == null && (
            <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> {(c.service_states ?? []).slice(0, 5).join(", ")}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RatingBadge({ rating, count }: { rating: number | null; count: number | null }) {
  if (!rating || !count) return <span className="text-xs text-muted-foreground">No ratings yet</span>;
  return (
    <div className="flex items-center gap-1 text-sm">
      <Star className="h-3.5 w-3.5 fill-yellow-500 text-yellow-500" />
      <span className="font-medium">{rating.toFixed(1)}</span>
      <span className="text-muted-foreground">({count})</span>
    </div>
  );
}

function TrustStrip() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
      {[
        { icon: Crosshair, title: "Sponsor-verified", body: "Each pro is vouched for by another verified network member before joining." },
        { icon: Star, title: "Real reviews only", body: "Ratings come from tenants who actually paid the contractor on a settled claim." },
        { icon: Lock, title: "Payments on-platform", body: "Pros get paid through ChecksOps, so we can track disputes and revoke bad actors." },
      ].map((f, i) => (
        <div key={i} className="border border-border rounded-lg p-4 bg-card/40">
          <f.icon className="h-5 w-5 text-primary mb-2" />
          <div className="font-semibold text-sm mb-1">{f.title}</div>
          <p className="text-xs text-muted-foreground">{f.body}</p>
        </div>
      ))}
    </div>
  );
}

function PublicHeader() {
  return (
    <header className="border-b border-border">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <a href="/" className="flex items-center" aria-label="ChecksOps home">
          <CheckOpsLogo className="text-foreground text-xl" />
        </a>
        <div className="text-xs text-muted-foreground">For homeowners</div>
      </div>
    </header>
  );
}


function PublicFooter() {
  return (
    <footer className="border-t border-border mt-12">
      <div className="max-w-6xl mx-auto px-4 py-6 text-xs text-muted-foreground flex flex-col md:flex-row items-center justify-between gap-2">
        <div>© {new Date().getFullYear()} ChecksOps. Verified restoration network.</div>
        <div className="flex gap-4">
          <a href="/privacy-notice" className="hover:text-foreground">Privacy</a>
          <a href="/" className="hover:text-foreground">About ChecksOps</a>
        </div>
      </div>
    </footer>
  );
}
