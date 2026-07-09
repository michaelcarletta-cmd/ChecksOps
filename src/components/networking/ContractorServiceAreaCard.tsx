import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Loader2, MapPin, Save, Plus, X, Crosshair } from "lucide-react";

type MyProfile = {
  id: string;
  display_name: string | null;
  service_zip_prefixes: string[] | null;
  home_base_lat: number | null;
  home_base_lng: number | null;
  service_radius_miles: number | null;
};

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
        .select("id, display_name, service_zip_prefixes, home_base_lat, home_base_lng, service_radius_miles")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as MyProfile | null;
    },
  });

  const [prefixes, setPrefixes] = useState<string[]>([]);
  const [newPrefix, setNewPrefix] = useState("");
  const [homeZip, setHomeZip] = useState("");
  const [lat, setLat] = useState<string>("");
  const [lng, setLng] = useState<string>("");
  const [radius, setRadius] = useState<string>("");
  const [geocoding, setGeocoding] = useState(false);

  useEffect(() => {
    if (profile) {
      setPrefixes(profile.service_zip_prefixes ?? []);
      setLat(profile.home_base_lat != null ? String(profile.home_base_lat) : "");
      setLng(profile.home_base_lng != null ? String(profile.home_base_lng) : "");
      setRadius(profile.service_radius_miles != null ? String(profile.service_radius_miles) : "");
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
      const { error } = await supabase
        .from("contractor_profiles")
        .update({
          service_zip_prefixes: prefixes,
          home_base_lat: latN,
          home_base_lng: lngN,
          service_radius_miles: radN,
        })
        .eq("id", profile.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Service area saved" });
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

  return (
    <Card className="border-primary/30">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MapPin className="h-4 w-4 text-primary" /> My service area
        </CardTitle>
        <CardDescription className="text-xs">
          Homeowners on the public directory only see you if their ZIP matches one of your prefixes or falls inside your radius.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Currently saved summary */}
        <div className="rounded-md border border-border bg-muted/30 p-3 text-xs space-y-1">
          <div className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px]">
            Currently saved
          </div>
          <div>
            <span className="text-muted-foreground">ZIP prefixes: </span>
            {(profile.service_zip_prefixes?.length ?? 0) > 0
              ? profile.service_zip_prefixes!.map((p) => `${p}*`).join(", ")
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

        {/* ZIP prefixes */}
        <div className="space-y-2">
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
            Homeowners within your radius (from the ZIP they entered) will see you as a match, with an
            approximate distance shown on your card.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={() => save.mutate()} disabled={save.isPending} size="sm">
            {save.isPending ? <Loader2 className="h-3 w-3 mr-2 animate-spin" /> : <Save className="h-3 w-3 mr-2" />}
            Save service area
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
