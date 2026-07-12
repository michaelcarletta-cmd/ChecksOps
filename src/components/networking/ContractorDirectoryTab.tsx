import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Search, Star, Briefcase, MapPin, ShieldCheck, Crosshair, Send, Loader2,
  Users, Award, Inbox,
} from "lucide-react";
import { ContractorServiceAreaCard } from "./ContractorServiceAreaCard";

type DirectoryRow = {
  id: string;
  user_id: string;
  display_name: string;
  bio: string | null;
  trades: string[];
  service_states: string[];
  service_metros: string[];
  license_number: string | null;
  coi_expires_at: string | null;
  avatar_url: string | null;
  tier: "guest" | "verified" | "pro";
  jobs_count: number;
  avg_rating: number;
  review_count: number;
};

const TRADE_OPTIONS = [
  "Roofing", "Water Mitigation", "Fire Restoration", "Mold Remediation",
  "General Contracting", "Siding", "Windows", "Gutters", "Interior Repair",
];
const STATE_OPTIONS = [
  "TX", "FL", "GA", "NC", "SC", "TN", "AL", "LA", "OK", "AR", "MS", "VA", "CA",
];

export function ContractorDirectoryTab() {

  const [search, setSearch] = useState("");
  const [trade, setTrade] = useState<string>("any");
  const [state, setState] = useState<string>("any");
  const [minRating, setMinRating] = useState<string>("0");
  const [sortBy, setSortBy] = useState<"rating" | "jobs" | "recent">("rating");
  const [selected, setSelected] = useState<DirectoryRow | null>(null);

  const filters = useMemo(
    () => ({
      trades: trade === "any" ? [] : [trade],
      states: state === "any" ? [] : [state],
      minRating: Number(minRating),
      search,
      sortBy,
      limit: 48,
      offset: 0,
    }),
    [trade, state, minRating, search, sortBy],
  );

  const { data, isLoading } = useQuery({
    queryKey: ["contractor-directory", filters],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("contractor-directory-search", {
        body: filters,
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      return data as { results: DirectoryRow[]; total: number };
    },
  });

  const results = data?.results ?? [];

  return (
    <div className="space-y-4">
      <ContractorServiceAreaCard />
      <Card>
        <CardContent className="p-3 md:p-4">
          <div className="flex flex-col md:flex-row gap-2 md:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search contractors, trades, service area…"
                className="pl-8 h-9"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={trade} onValueChange={setTrade}>
              <SelectTrigger className="h-9 w-full md:w-[160px]">
                <SelectValue placeholder="Trade" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">All trades</SelectItem>
                {TRADE_OPTIONS.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={state} onValueChange={setState}>
              <SelectTrigger className="h-9 w-full md:w-[110px]">
                <SelectValue placeholder="State" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">All states</SelectItem>
                {STATE_OPTIONS.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={minRating} onValueChange={setMinRating}>
              <SelectTrigger className="h-9 w-full md:w-[130px]">
                <SelectValue placeholder="Min rating" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">Any rating</SelectItem>
                <SelectItem value="3">3+ stars</SelectItem>
                <SelectItem value="4">4+ stars</SelectItem>
                <SelectItem value="4.5">4.5+ stars</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
              <SelectTrigger className="h-9 w-full md:w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="rating">Top rated</SelectItem>
                <SelectItem value="jobs">Most jobs</SelectItem>
                <SelectItem value="recent">Newest</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading contractors…
        </div>
      ) : results.length === 0 ? (
        <Card>
          <CardContent className="p-8 flex flex-col items-center text-center text-muted-foreground gap-2">
            <Inbox className="h-8 w-8" />
            <p className="text-sm">No contractors match your filters yet.</p>
            <p className="text-xs">The directory grows as verified Pro contractors opt in.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {results.map((c) => (
            <ContractorCard key={c.id} contractor={c} onView={() => setSelected(c)} />
          ))}
        </div>
      )}

      <ContractorDetailSheet
        contractor={selected}
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
      />
    </div>
  );
}


function ContractorCard({
  contractor,
  onView,
}: {
  contractor: DirectoryRow;
  onView: () => void;
}) {
  const initials = contractor.display_name
    .split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <Card className="hover:border-primary/40 transition-colors">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-3">
          <Avatar className="h-11 w-11">
            {contractor.avatar_url && <AvatarImage src={contractor.avatar_url} />}
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-sm truncate">{contractor.display_name}</h3>
              <TierBadge tier={contractor.tier} />
            </div>
            <div className="flex items-center gap-1 mt-1 text-xs text-muted-foreground">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
              <span className="font-medium text-foreground">
                {contractor.avg_rating ? Number(contractor.avg_rating).toFixed(1) : "—"}
              </span>
              <span>({contractor.review_count})</span>
              <span className="mx-1">·</span>
              <Briefcase className="h-3 w-3" />
              <span>{contractor.jobs_count} jobs</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          {contractor.trades.slice(0, 3).map((t) => (
            <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
          ))}
          {contractor.trades.length > 3 && (
            <Badge variant="outline" className="text-[10px]">+{contractor.trades.length - 3}</Badge>
          )}
        </div>

        {contractor.service_states.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span className="truncate">{contractor.service_states.join(", ")}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" className="flex-1 h-8 text-xs" onClick={onView}>
            View profile
          </Button>
          <InviteToClaimButton contractor={contractor} compact />
        </div>
      </CardContent>
    </Card>
  );
}

function TierBadge({ tier }: { tier: DirectoryRow["tier"] }) {
  if (tier === "pro") {
    return (
      <Badge variant="outline" className="text-[10px] gap-1 bg-amber-500/10 text-amber-600 border-amber-500/30">
        <Award className="h-3 w-3" /> Pro
      </Badge>
    );
  }
  if (tier === "verified") {
    return (
      <Badge variant="outline" className="text-[10px] gap-1 bg-emerald-500/10 text-emerald-600 border-emerald-500/30">
        <Crosshair className="h-3 w-3" strokeWidth={2.5} /> Verified
      </Badge>
    );
  }
  return null;
}

function ContractorDetailSheet({
  contractor,
  open,
  onOpenChange,
}: {
  contractor: DirectoryRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: reviews } = useQuery({
    queryKey: ["contractor-reviews", contractor?.id],
    enabled: !!contractor,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contractor_reviews")
        .select("id, rating, comment, created_at")
        .eq("contractor_id", contractor!.id)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data;
    },
  });

  if (!contractor) return null;
  const initials = contractor.display_name
    .split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Contractor profile</SheetTitle>
        </SheetHeader>
        <div className="space-y-5 mt-4">
          <div className="flex items-center gap-3">
            <Avatar className="h-14 w-14">
              {contractor.avatar_url && <AvatarImage src={contractor.avatar_url} />}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold">{contractor.display_name}</h2>
                <TierBadge tier={contractor.tier} />
              </div>
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
                <span className="text-foreground font-medium">
                  {contractor.avg_rating ? Number(contractor.avg_rating).toFixed(1) : "—"}
                </span>
                <span>({contractor.review_count} reviews)</span>
              </div>
            </div>
          </div>

          {contractor.bio && (
            <p className="text-sm text-muted-foreground">{contractor.bio}</p>
          )}

          <InfoBlock label="Trades" icon={Briefcase}>
            <div className="flex flex-wrap gap-1">
              {contractor.trades.map((t) => (
                <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
              ))}
            </div>
          </InfoBlock>

          {contractor.service_states.length > 0 && (
            <InfoBlock label="Service area" icon={MapPin}>
              <p className="text-sm">{contractor.service_states.join(", ")}</p>
              {contractor.service_metros.length > 0 && (
                <p className="text-xs text-muted-foreground">{contractor.service_metros.join(" · ")}</p>
              )}
            </InfoBlock>
          )}

          <InfoBlock label="On ChecksOps" icon={Users}>
            <p className="text-sm">{contractor.jobs_count} jobs completed on the network</p>
            {contractor.license_number && (
              <p className="text-xs text-muted-foreground">License #{contractor.license_number}</p>
            )}
          </InfoBlock>

          <InviteToClaimButton contractor={contractor} />

          <div>
            <h3 className="text-sm font-semibold mb-2">Reviews</h3>
            {(reviews ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No reviews yet.</p>
            ) : (
              <div className="space-y-3">
                {reviews!.map((r: any) => (
                  <div key={r.id} className="border rounded-md p-3">
                    <div className="flex items-center gap-1 mb-1">
                      {Array.from({ length: 5 }).map((_, i) => (
                        <Star
                          key={i}
                          className={`h-3 w-3 ${
                            i < r.rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40"
                          }`}
                        />
                      ))}
                    </div>
                    {r.comment && <p className="text-xs text-muted-foreground">{r.comment}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function InfoBlock({
  label, icon: Icon, children,
}: { label: string; icon: any; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      {children}
    </div>
  );
}

function InviteToClaimButton({
  contractor,
  compact = false,
}: {
  contractor: DirectoryRow;
  compact?: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [claimId, setClaimId] = useState<string>("");
  const [message, setMessage] = useState("");

  const { data: claims } = useQuery({
    queryKey: ["invite-claim-picker"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claims")
        .select("id, claim_number, client_id, clients!inner(first_name, last_name)")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const invite = useMutation({
    mutationFn: async () => {
      if (!claimId) throw new Error("Pick a claim");
      const { data, error } = await supabase.functions.invoke("contractor-invite-to-claim", {
        body: { contractor_id: contractor.id, claim_id: claimId, message: message || undefined },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: (data: any) => {
      toast({
        title: data?.reused ? "Invite already pending" : "Invite sent",
        description: `${contractor.display_name} was invited to the claim.`,
      });
      setOpen(false);
      setClaimId("");
      setMessage("");
      qc.invalidateQueries({ queryKey: ["contractor-invites"] });
    },
    onError: (e: any) =>
      toast({ title: "Couldn't send invite", description: e.message, variant: "destructive" }),
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size={compact ? "sm" : "default"}
          className={compact ? "flex-1 h-8 text-xs" : "w-full"}
        >
          <Send className={compact ? "h-3 w-3 mr-1" : "h-4 w-4 mr-2"} />
          Invite to claim
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium">Invite {contractor.display_name}</p>
            <p className="text-xs text-muted-foreground">Pick a claim to invite them to.</p>
          </div>
          <Select value={claimId} onValueChange={setClaimId}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder="Select a claim…" />
            </SelectTrigger>
            <SelectContent>
              {(claims ?? []).map((c: any) => {
                const name = c.clients ? `${c.clients.first_name ?? ""} ${c.clients.last_name ?? ""}`.trim() : "";
                return (
                  <SelectItem key={c.id} value={c.id}>
                    {c.claim_number ?? c.id.slice(0, 8)}{name ? ` · ${name}` : ""}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Input
            placeholder="Optional message"
            className="h-9"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <Button
            className="w-full"
            size="sm"
            disabled={!claimId || invite.isPending}
            onClick={() => invite.mutate()}
          >
            {invite.isPending ? (
              <><Loader2 className="h-3 w-3 mr-2 animate-spin" />Sending…</>
            ) : (
              <><Send className="h-3 w-3 mr-2" />Send invite</>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
