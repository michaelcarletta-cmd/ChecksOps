import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, MapPin, Save, Plus, X, Crosshair, Wrench, Globe, Sparkles, Star } from "lucide-react";

type MyProfile = {
  id: string;
  display_name: string | null;
  bio: string | null;
  trades: string[] | null;
  service_zip_prefixes: string[] | null;
  service_states: string[] | null;
  home_base_lat: number | null;
  home_base_lng: number | null;
  service_radius_miles: number | null;
  is_directory_listed: boolean | null;
  directory_opt_in: boolean | null;
  tier: string | null;
  google_business_name: string | null;
  google_reviews_url: string | null;
  google_rating: number | null;
  google_review_count: number | null;
};


const US_STATES: { code: string; name: string }[] = [
  { code: "AL", name: "Alabama" }, { code: "AK", name: "Alaska" }, { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" }, { code: "CA", name: "California" }, { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" }, { code: "DE", name: "Delaware" }, { code: "DC", name: "District of Columbia" },
  { code: "FL", name: "Florida" }, { code: "GA", name: "Georgia" }, { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" }, { code: "IL", name: "Illinois" }, { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" }, { code: "KS", name: "Kansas" }, { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" }, { code: "ME", name: "Maine" }, { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" }, { code: "MI", name: "Michigan" }, { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" }, { code: "MO", name: "Missouri" }, { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" }, { code: "NV", name: "Nevada" }, { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" }, { code: "NM", name: "New Mexico" }, { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" }, { code: "ND", name: "North Dakota" }, { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" }, { code: "OR", name: "Oregon" }, { code: "PA", name: "Pennsylvania" },
  { code: "RI", name: "Rhode Island" }, { code: "SC", name: "South Carolina" }, { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" }, { code: "TX", name: "Texas" }, { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" }, { code: "VA", name: "Virginia" }, { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" }, { code: "WI", name: "Wisconsin" }, { code: "WY", name: "Wyoming" },
];


// Preset trades / specialties homeowners can filter on.
// Values are stored lowercase-snake in `trades[]`; labels are the display strings.
const PRESET_TRADES: { value: string; label: string }[] = [
  { value: "roofing", label: "Roofing" },
  { value: "water_mitigation", label: "Water Mitigation" },
  { value: "mold_remediation", label: "Mold Remediation" },
  { value: "fire_restoration", label: "Fire / Smoke Restoration" },
  { value: "general_contractor", label: "General Contractor" },
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "hvac", label: "HVAC" },
  { value: "flooring", label: "Flooring" },
  { value: "windows_siding", label: "Windows & Siding" },
  { value: "public_adjuster", label: "Public Adjuster" },
  { value: "attorney", label: "Attorney (Insurance)" },
];

export function ContractorServiceAreaCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: profile, isLoading } = useQuery({
    queryKey: ["my-contractor-profile", user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<MyProfile | null> => {
      const { data, error } = await supabase
        .from("contractor_profiles")
        .select(
          "id, display_name, bio, trades, service_zip_prefixes, service_states, home_base_lat, home_base_lng, service_radius_miles, is_directory_listed, directory_opt_in, tier, google_business_name, google_reviews_url, google_rating, google_review_count",
        )
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as MyProfile | null;
    },
  });


  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [newPrefix, setNewPrefix] = useState("");
  const [states, setStates] = useState<string[]>([]);
  const [deriving, setDeriving] = useState(false);
  const [homeZip, setHomeZip] = useState("");
  const [lat, setLat] = useState<string>("");
  const [lng, setLng] = useState<string>("");
  const [radius, setRadius] = useState<string>("");
  const [geocoding, setGeocoding] = useState(false);
  const [trades, setTrades] = useState<string[]>([]);
  const [newTrade, setNewTrade] = useState("");
  const [bio, setBio] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [published, setPublished] = useState(false);
  const [googleUrl, setGoogleUrl] = useState("");
  const [googleRating, setGoogleRating] = useState<string>("");
  const [googleReviewCount, setGoogleReviewCount] = useState<string>("");

  useEffect(() => {
    if (profile) {
      setPrefixes(profile.service_zip_prefixes ?? []);
      setStates(profile.service_states ?? []);
      setLat(profile.home_base_lat != null ? String(profile.home_base_lat) : "");
      setLng(profile.home_base_lng != null ? String(profile.home_base_lng) : "");
      setRadius(profile.service_radius_miles != null ? String(profile.service_radius_miles) : "");
      setTrades(profile.trades ?? []);
      setBio(profile.bio ?? "");
      setBusinessName(profile.display_name ?? "");
      setPublished(!!(profile.is_directory_listed && profile.directory_opt_in));
      setGoogleUrl(profile.google_reviews_url ?? "");
      setGoogleRating(profile.google_rating != null ? String(profile.google_rating) : "");
      setGoogleReviewCount(profile.google_review_count != null ? String(profile.google_review_count) : "");
    }
  }, [profile]);


  const addPrefix = () => {
    const p = newPrefix.trim();
    if (!/^\d{3}$/.test(p)) {
      toast({ title: "Enter a 3-digit ZIP prefix", description: "e.g. 331 for Miami", variant: "destructive" });
      return;
    }
    if (prefixes.includes(p)) return;
    if (prefixes.length >= 25) {
      toast({ title: "Maximum 25 ZIP prefixes", variant: "destructive" });
      return;
    }
    setPrefixes([...prefixes, p]);
    setNewPrefix("");
  };
  const removePrefix = (p: string) => setPrefixes(prefixes.filter((x) => x !== p));

  const toggleState = (code: string) =>
    setStates((prev) => (prev.includes(code) ? prev.filter((s) => s !== code) : [...prev, code].sort()));

  const deriveStatesFromZips = async () => {
    if (prefixes.length === 0) {
      toast({ title: "Add at least one ZIP prefix first", variant: "destructive" });
      return;
    }
    setDeriving(true);
    try {
      const found = new Set<string>(states);
      for (const p of prefixes) {
        // Try a handful of trailing digits until we find a valid ZIP for the prefix
        for (const suffix of ["01", "10", "00", "50", "20", "05"]) {
          try {
            const r = await fetch(`https://api.zippopotam.us/us/${p}${suffix}`);
            if (!r.ok) continue;
            const j = await r.json();
            const abbr = j?.places?.[0]?.["state abbreviation"];
            if (abbr) { found.add(String(abbr).toUpperCase()); break; }
          } catch { /* try next */ }
        }
      }
      const next = Array.from(found).sort();
      setStates(next);
      toast({ title: `Detected ${next.length} state${next.length !== 1 ? "s" : ""} from ZIP prefixes` });
    } catch (e: any) {
      toast({ title: "Couldn't derive states", description: e.message, variant: "destructive" });
    } finally {
      setDeriving(false);
    }
  };

  const toggleTrade = (v: string) =>
    setTrades((prev) => (prev.includes(v) ? prev.filter((t) => t !== v) : [...prev, v]));

  const addCustomTrade = () => {
    const v = newTrade.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    if (!v) return;
    if (trades.includes(v)) return;
    setTrades([...trades, v]);
    setNewTrade("");
  };

  const geocodeHome = async () => {
    if (!/^\d{5}$/.test(homeZip.trim())) {
      toast({ title: "Enter a 5-digit ZIP", variant: "destructive" });
      return;
    }
    setGeocoding(true);
    try {
      const r = await fetch(`https://api.zippopotam.us/us/${homeZip.trim()}`);
      if (!r.ok) throw new Error("ZIP not found");
      const j = await r.json();
      const place = j?.places?.[0];
      if (!place) throw new Error("No location for ZIP");
      setLat(String(Number(place.latitude).toFixed(6)));
      setLng(String(Number(place.longitude).toFixed(6)));
      toast({ title: `Home base set to ${place["place name"]}, ${place["state abbreviation"]}` });
    } catch (e: any) {
      toast({ title: "Couldn't look up ZIP", description: e.message, variant: "destructive" });
    } finally {
      setGeocoding(false);
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      if (!profile) throw new Error("No contractor profile");
      const latN = lat ? Number(lat) : null;
      const lngN = lng ? Number(lng) : null;
      const radN = radius ? Math.round(Number(radius)) : null;
      if ((latN != null && !Number.isFinite(latN)) || (lngN != null && !Number.isFinite(lngN))) {
        throw new Error("Invalid coordinates");
      }
      if (radN != null && (radN < 1 || radN > 500)) {
        throw new Error("Radius must be 1-500 miles");
      }
      const cleanName = businessName.trim();
      if (published && cleanName.length < 2) {
        throw new Error("Enter your business name before publishing");
      }
      const gRating = googleRating.trim() ? Number(googleRating) : null;
      const gCount = googleReviewCount.trim() ? Math.round(Number(googleReviewCount)) : null;
      if (gRating != null && (!Number.isFinite(gRating) || gRating < 0 || gRating > 5)) {
        throw new Error("Google rating must be between 0 and 5");
      }
      if (gCount != null && (!Number.isFinite(gCount) || gCount < 0)) {
        throw new Error("Google review count must be a positive number");
      }
      const gUrl = googleUrl.trim();
      if (gUrl && !/^https?:\/\//i.test(gUrl)) {
        throw new Error("Google reviews URL must start with https://");
      }
      const { error } = await supabase
        .from("contractor_profiles")
        .update({
          display_name: cleanName || profile.display_name,
          service_zip_prefixes: prefixes,
          service_states: states,
          home_base_lat: latN,
          home_base_lng: lngN,
          service_radius_miles: radN,
          trades,
          bio: bio.trim() || null,
          is_directory_listed: published,
          directory_opt_in: published,
          tier: published ? "pro" : profile.tier ?? "guest",
          google_reviews_url: gUrl || null,
          google_rating: gRating,
          google_review_count: gCount,
        })
        .eq("id", profile.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Profile saved" });
      qc.invalidateQueries({ queryKey: ["my-contractor-profile"] });
      qc.invalidateQueries({ queryKey: ["contractor-directory"] });
    },

    onError: (e: any) =>
      toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const createProfile = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Not signed in");
      const displayName =
        (user.user_metadata as any)?.full_name ||
        (user.user_metadata as any)?.name ||
        user.email?.split("@")[0] ||
        "New contractor";
      const { error } = await supabase.from("contractor_profiles").insert({
        user_id: user.id,
        display_name: displayName,
        service_zip_prefixes: [],
        service_states: [],
        trades: [],
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Directory listing created" });
      qc.invalidateQueries({ queryKey: ["my-contractor-profile"] });
    },
    onError: (e: any) =>
      toast({ title: "Couldn't create listing", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return null;
  if (!profile) {
    return (
      <Card className="border-dashed">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <MapPin className="h-4 w-4 text-primary" /> Create your Find-a-Pro listing
          </CardTitle>
          <CardDescription className="text-xs">
            You don't have a public directory listing yet. Create one to start setting your service area and appear on{" "}
            <code>checksops.com/find-a-pro</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button size="sm" onClick={() => createProfile.mutate()} disabled={createProfile.isPending}>
            {createProfile.isPending ? (
              <Loader2 className="h-3 w-3 mr-2 animate-spin" />
            ) : (
              <Plus className="h-3 w-3 mr-2" />
            )}
            Create my listing
          </Button>
        </CardContent>
      </Card>
    );
  }

  const isLive = !!(profile.is_directory_listed && profile.directory_opt_in) && profile.tier === "pro";

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MapPin className="h-4 w-4 text-primary" /> My directory profile
        </CardTitle>
        <CardDescription className="text-xs">
          Homeowners on the public directory only see you when your listing is published AND their ZIP matches one of
          your prefixes or falls inside your radius.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Publish toggle */}
        <div className="flex items-center justify-between rounded-md border border-border bg-muted/30 p-3">
          <div className="space-y-0.5">
            <div className="text-sm font-semibold flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" />
              Publish to checksops.com/find-a-pro
            </div>
            <div className="text-[11px] text-muted-foreground">
              {isLive ? "Live — homeowners can see you now." : "Draft — not visible to homeowners yet."}
            </div>
          </div>
          <Switch checked={published} onCheckedChange={setPublished} />
        </div>

        {/* Currently saved summary */}
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs space-y-1">
          <div className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">
            Currently saved
          </div>
          <div>
            <span className="text-muted-foreground">Status: </span>
            {isLive ? (
              <Badge className="h-4 px-1.5 text-[10px]">Live</Badge>
            ) : (
              <Badge variant="outline" className="h-4 px-1.5 text-[10px]">Draft</Badge>
            )}
          </div>
          <div>
            <span className="text-muted-foreground">Trades: </span>
            {(profile.trades?.length ?? 0) > 0
              ? profile.trades!.join(", ")
              : <span className="text-muted-foreground italic">none</span>}
          </div>
          <div>
            <span className="text-muted-foreground">ZIP prefixes: </span>
            {(profile.service_zip_prefixes?.length ?? 0) > 0
              ? profile.service_zip_prefixes!.map((p) => `${p}*`).join(", ")
              : <span className="text-muted-foreground italic">none</span>}
          </div>
          <div>
            <span className="text-muted-foreground">States: </span>
            {(profile.service_states?.length ?? 0) > 0
              ? profile.service_states!.join(", ")
              : <span className="text-muted-foreground italic">none</span>}
          </div>
          <div>
            <span className="text-muted-foreground">Home base: </span>
            {profile.home_base_lat != null && profile.home_base_lng != null
              ? `${Number(profile.home_base_lat).toFixed(4)}, ${Number(profile.home_base_lng).toFixed(4)}`
              : <span className="text-muted-foreground italic">not set</span>}
          </div>
          <div>
            <span className="text-muted-foreground">Service radius: </span>
            {profile.service_radius_miles != null
              ? `${profile.service_radius_miles} mi`
              : <span className="text-muted-foreground italic">not set</span>}
          </div>
        </div>

        {/* Trades / specialties */}
        <div className="space-y-2 border-t border-border pt-4">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Wrench className="h-3 w-3" /> Trades &amp; specialties
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_TRADES.map((t) => {
              const active = trades.includes(t.value);
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => toggleTrade(t.value)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-muted"
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          {trades.filter((t) => !PRESET_TRADES.some((p) => p.value === t)).length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {trades
                .filter((t) => !PRESET_TRADES.some((p) => p.value === t))
                .map((t) => (
                  <Badge key={t} variant="secondary" className="gap-1 pr-1">
                    {t}
                    <button
                      onClick={() => toggleTrade(t)}
                      className="hover:text-destructive"
                      aria-label={`Remove ${t}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="Add custom trade…"
              value={newTrade}
              onChange={(e) => setNewTrade(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addCustomTrade())}
              className="h-9 w-56"
              maxLength={40}
            />
            <Button size="sm" variant="outline" onClick={addCustomTrade}>
              <Plus className="h-3 w-3 mr-1" /> Add
            </Button>
          </div>
        </div>

        {/* Business name + short bio */}
        <div className="space-y-3 border-t border-border pt-4">
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Business name (shown on your directory card)
            </Label>
            <Input
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value.slice(0, 120))}
              placeholder="e.g. Sunrise Restoration LLC"
              className="h-9"
              maxLength={120}
            />
            <p className="text-[10px] text-muted-foreground">
              This replaces your user name on <code>checksops.com/find-a-pro</code>. Homeowners never see the sign-in
              email.
            </p>
          </div>
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Short bio (shown on your card)
            </Label>
            <Textarea
              value={bio}
              onChange={(e) => setBio(e.target.value.slice(0, 400))}
              placeholder="A sentence or two homeowners will see — years in business, service area, specialties, licenses/certs…"
              className="min-h-[70px] text-sm"
            />
            <p className="text-[10px] text-muted-foreground text-right">{bio.length}/400</p>
          </div>
        </div>

        {/* Google reviews */}
        <div className="space-y-3 border-t border-border pt-4">
          <div>
            <Label className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <Star className="h-3 w-3" /> Google reviews (optional)
            </Label>
            <p className="text-[11px] text-muted-foreground mt-1">
              Show your Google star rating on your Find-a-Pro card so homeowners see your reputation
              instantly. Find these numbers on your Google Business Profile.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <div>
              <Label className="text-[10px] text-muted-foreground">Rating (0–5)</Label>
              <Input
                value={googleRating}
                onChange={(e) => setGoogleRating(e.target.value.replace(/[^0-9.]/g, "").slice(0, 3))}
                className="h-9"
                placeholder="4.8"
                inputMode="decimal"
              />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">Review count</Label>
              <Input
                value={googleReviewCount}
                onChange={(e) => setGoogleReviewCount(e.target.value.replace(/\D/g, "").slice(0, 5))}
                className="h-9"
                placeholder="127"
                inputMode="numeric"
              />
            </div>
            <div className="md:col-span-1">
              <Label className="text-[10px] text-muted-foreground">Reviews page URL</Label>
              <Input
                value={googleUrl}
                onChange={(e) => setGoogleUrl(e.target.value.slice(0, 500))}
                className="h-9"
                placeholder="https://g.page/r/..."
              />
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Tip: on Google Maps, open your business → "Reviews" tab → Share → copy link. Keeping these
            numbers current is on you (there's no live sync).
          </p>
        </div>




        {/* ZIP prefixes */}
        <div className="space-y-2 border-t border-border pt-4">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Service ZIP prefixes (first 3 digits)
          </Label>
          <div className="flex flex-wrap gap-1.5 min-h-[28px]">
            {prefixes.length === 0 && (
              <span className="text-xs text-muted-foreground">None yet — add prefixes like 331, 330, 334</span>
            )}
            {prefixes.map((p) => (
              <Badge key={p} variant="secondary" className="gap-1 pr-1">
                {p}*
                <button
                  onClick={() => removePrefix(p)}
                  className="hover:text-destructive"
                  aria-label={`Remove ${p}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. 331"
              value={newPrefix}
              onChange={(e) => setNewPrefix(e.target.value.replace(/\D/g, "").slice(0, 3))}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addPrefix())}
              className="h-9 w-32"
              maxLength={3}
            />
            <Button size="sm" variant="outline" onClick={addPrefix}>
              <Plus className="h-3 w-3 mr-1" /> Add prefix
            </Button>
          </div>
        </div>

        {/* States served */}
        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              States served
            </Label>
            <Button
              size="sm"
              variant="outline"
              onClick={deriveStatesFromZips}
              disabled={deriving || prefixes.length === 0}
              className="h-7 text-xs"
            >
              {deriving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
              Auto-detect from ZIPs
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Pick states you serve, or auto-detect them from your ZIP prefixes above. Homeowners can filter the directory
            by state, and your card shows the states you cover.
          </p>
          {states.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {states.map((s) => (
                <Badge key={s} variant="secondary" className="gap-1 pr-1">
                  {s}
                  <button
                    onClick={() => toggleState(s)}
                    className="hover:text-destructive"
                    aria-label={`Remove ${s}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1 pt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-muted/20 p-2">
            {US_STATES.map((st) => {
              const active = states.includes(st.code);
              return (
                <button
                  key={st.code}
                  type="button"
                  onClick={() => toggleState(st.code)}
                  title={st.name}
                  className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background hover:bg-muted"
                  }`}
                >
                  {st.code}
                </button>
              );
            })}
          </div>
        </div>



        {/* Home base + radius */}
        <div className="space-y-2 border-t border-border pt-4">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">
            Home base &amp; drive radius
          </Label>
          <div className="flex gap-2">
            <Input
              placeholder="Enter ZIP to auto-fill"
              value={homeZip}
              onChange={(e) => setHomeZip(e.target.value.replace(/\D/g, "").slice(0, 5))}
              className="h-9 w-40"
              maxLength={5}
            />
            <Button size="sm" variant="outline" onClick={geocodeHome} disabled={geocoding}>
              {geocoding ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Crosshair className="h-3 w-3 mr-1" />}
              Look up
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label className="text-[10px] text-muted-foreground">Latitude</Label>
              <Input value={lat} onChange={(e) => setLat(e.target.value)} className="h-9" placeholder="25.7617" />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">Longitude</Label>
              <Input value={lng} onChange={(e) => setLng(e.target.value)} className="h-9" placeholder="-80.1918" />
            </div>
            <div>
              <Label className="text-[10px] text-muted-foreground">Radius (mi)</Label>
              <Input
                value={radius}
                onChange={(e) => setRadius(e.target.value.replace(/\D/g, "").slice(0, 3))}
                className="h-9"
                placeholder="50"
                inputMode="numeric"
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Homeowners within your radius (from the ZIP they entered) will see you as a match, with an approximate
            distance shown on your card.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending} size="sm">
            {save.isPending ? <Loader2 className="h-3 w-3 mr-2 animate-spin" /> : <Save className="h-3 w-3 mr-2" />}
            Save profile
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
