import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import {
  FileBarChart,
  Plus,
  Loader2,
  RefreshCw,
  ExternalLink,
  ShieldAlert,
  Clock,
  CheckCircle2,
  XCircle,
} from "lucide-react";

interface OneEsxOrdersPanelProps {
  claimId: string;
  claim: any;
}

type ProductCatalog = {
  expedited_delivery_amount?: number;
  roof_report_types?: Array<{ id?: string; name?: string; label?: string; price?: number } | string>;
  facets?: Array<{ id?: string; label?: string; value?: string } | string | number>;
  primary_pitch?: Array<{ id?: string; label?: string; value?: string } | string>;
  secondary_pitch?: Array<{ id?: string; label?: string; value?: string } | string>;
};

type OnesxOrder = {
  id: string;
  claim_id: string;
  onesx_order_id: string | null;
  status: string;
  report_types: string[];
  address: string | null;
  total: number | null;
  expedited_delivery: boolean;
  notes: string | null;
  last_status_at: string | null;
  last_error: string | null;
  report_files: any;
  created_at: string;
  completed_at: string | null;
};

const STATUS_STYLES: Record<string, { label: string; cls: string; icon: any }> = {
  submitting: { label: "Submitting", cls: "bg-muted text-muted-foreground", icon: Loader2 },
  pending: { label: "Pending", cls: "bg-amber-500/15 text-amber-400", icon: Clock },
  processing: { label: "Processing", cls: "bg-blue-500/15 text-blue-400", icon: Loader2 },
  completed: { label: "Completed", cls: "bg-emerald-500/15 text-emerald-400", icon: CheckCircle2 },
  cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground", icon: XCircle },
  error: { label: "Error", cls: "bg-destructive/15 text-destructive", icon: XCircle },
};

function asLabel(item: unknown): string {
  if (item == null) return "";
  if (typeof item === "string" || typeof item === "number") return String(item);
  if (typeof item === "object") {
    const o = item as any;
    return o.label ?? o.name ?? o.value ?? o.id ?? "";
  }
  return "";
}
function asValue(item: unknown): string {
  if (item == null) return "";
  if (typeof item === "string" || typeof item === "number") return String(item);
  if (typeof item === "object") {
    const o = item as any;
    return String(o.value ?? o.id ?? o.name ?? o.label ?? "");
  }
  return "";
}

export const OneEsxOrdersPanel = ({ claimId, claim }: OneEsxOrdersPanelProps) => {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isAdmin } = useUserRole();

  const [open, setOpen] = useState(false);
  const [reportType, setReportType] = useState<string>("");
  const [facets, setFacets] = useState<string>("");
  const [primaryPitch, setPrimaryPitch] = useState<string>("");
  const [secondaryPitch, setSecondaryPitch] = useState<string>("");
  const [expedited, setExpedited] = useState(false);
  const [notes, setNotes] = useState<string>("");
  const [address, setAddress] = useState<string>(claim?.policyholder_address ?? "");
  const [latitude, setLatitude] = useState<string>(claim?.latitude != null ? String(claim.latitude) : "");
  const [longitude, setLongitude] = useState<string>(claim?.longitude != null ? String(claim.longitude) : "");

  useEffect(() => {
    setAddress(claim?.policyholder_address ?? "");
    setLatitude(claim?.latitude != null ? String(claim.latitude) : "");
    setLongitude(claim?.longitude != null ? String(claim.longitude) : "");
  }, [claim?.policyholder_address, claim?.latitude, claim?.longitude]);

  // Catalog (cached 30 min)
  const { data: catalog, isLoading: catalogLoading, refetch: refetchCatalog } = useQuery({
    queryKey: ["onesx-products"],
    enabled: isAdmin && open,
    staleTime: 30 * 60 * 1000,
    queryFn: async (): Promise<ProductCatalog | null> => {
      const { data, error } = await supabase.functions.invoke("onesx-products");
      if (error) throw error;
      return (data as any)?.data ?? null;
    },
  });

  // Orders for this claim
  const { data: orders = [], isLoading: ordersLoading } = useQuery({
    queryKey: ["onesx-orders", claimId],
    enabled: isAdmin && !!claimId,
    refetchInterval: 30000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("onesx_orders")
        .select("*")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as OnesxOrder[];
    },
  });

  const reportTypeOptions = useMemo(() => catalog?.roof_report_types ?? [], [catalog]);
  const facetOptions = useMemo(() => catalog?.facets ?? [], [catalog]);
  const primaryPitchOptions = useMemo(() => catalog?.primary_pitch ?? [], [catalog]);
  const secondaryPitchOptions = useMemo(() => catalog?.secondary_pitch ?? [], [catalog]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!reportType) throw new Error("Pick a report type");
      if (!address) throw new Error("Address is required");
      if (!latitude || !longitude) throw new Error("Latitude and longitude are required");

      const { data, error } = await supabase.functions.invoke("onesx-create-order", {
        body: {
          claim_id: claimId,
          report_types: [reportType],
          address,
          latitude: Number(latitude),
          longitude: Number(longitude),
          number_of_facets: facets ? Number(facets) : undefined,
          primary_pitch: primaryPitch || undefined,
          secondary_pitch: secondaryPitch || undefined,
          expedited_delivery: expedited,
          notes: notes || undefined,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: () => {
      toast({ title: "1ESX order submitted", description: "We'll notify you when the report is ready." });
      qc.invalidateQueries({ queryKey: ["onesx-orders", claimId] });
      setOpen(false);
      setNotes("");
    },
    onError: (e: any) => {
      toast({ title: "Order failed", description: e.message ?? "Unknown error", variant: "destructive" });
    },
  });

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="p-6 flex items-center gap-3 text-muted-foreground text-sm">
          <ShieldAlert className="h-4 w-4" />
          1ESX roof report ordering is restricted to admins.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <FileBarChart className="h-4 w-4 text-primary" />
          1ESX Roof Reports
        </CardTitle>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => qc.invalidateQueries({ queryKey: ["onesx-orders", claimId] })}
            disabled={ordersLoading}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${ordersLoading ? "animate-spin" : ""}`} />
          </Button>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Order Report
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {ordersLoading && (
          <div className="text-xs text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading orders…
          </div>
        )}
        {!ordersLoading && orders.length === 0 && (
          <div className="text-xs text-muted-foreground border border-dashed border-border rounded-md p-4 text-center">
            No 1ESX orders yet for this claim.
          </div>
        )}
        {orders.map((o) => {
          const style = STATUS_STYLES[o.status] ?? STATUS_STYLES.pending;
          const Icon = style.icon;
          const files = Array.isArray(o.report_files) ? o.report_files : [];
          return (
            <div key={o.id} className="border border-border rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge className={`${style.cls} text-[10px]`}>
                    <Icon className={`h-3 w-3 mr-1 ${o.status === "submitting" || o.status === "processing" ? "animate-spin" : ""}`} />
                    {style.label}
                  </Badge>
                  <span className="text-xs font-medium truncate">
                    {o.report_types?.join(", ") || "Report"}
                  </span>
                  {o.expedited_delivery && (
                    <Badge variant="outline" className="text-[10px]">Expedited</Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                  {o.total != null && <span>${Number(o.total).toFixed(2)}</span>}
                  <span>{new Date(o.created_at).toLocaleDateString()}</span>
                </div>
              </div>
              {o.address && <div className="text-[11px] text-muted-foreground truncate">{o.address}</div>}
              {o.last_error && (
                <div className="text-[11px] text-destructive">Error: {o.last_error}</div>
              )}
              {files.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {files.map((f: any, i: number) => {
                    const url = typeof f === "string" ? f : f?.url ?? f?.file_url ?? f?.href;
                    const label = typeof f === "string" ? `File ${i + 1}` : f?.name ?? f?.label ?? `File ${i + 1}`;
                    if (!url) return null;
                    return (
                      <a
                        key={i}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {label}
                      </a>
                    );
                  })}
                </div>
              )}
              {o.onesx_order_id && (
                <div className="text-[10px] text-muted-foreground font-mono">{o.onesx_order_id}</div>
              )}
            </div>
          );
        })}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Order 1ESX Roof Report</DialogTitle>
          </DialogHeader>

          {catalogLoading ? (
            <div className="py-6 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading product catalog…
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label className="text-xs">Report Type *</Label>
                <Select value={reportType} onValueChange={setReportType}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Select a report" /></SelectTrigger>
                  <SelectContent>
                    {reportTypeOptions.length === 0 ? (
                      <SelectItem value="Residential Roof ESX Only" className="text-xs">
                        Residential Roof ESX Only
                      </SelectItem>
                    ) : (
                      reportTypeOptions.map((rt, i) => {
                        const v = asValue(rt) || asLabel(rt);
                        const l = asLabel(rt);
                        return <SelectItem key={`${v}-${i}`} value={v} className="text-xs">{l}</SelectItem>;
                      })
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Address *</Label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} className="h-9 text-xs" />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Latitude *</Label>
                  <Input value={latitude} onChange={(e) => setLatitude(e.target.value)} className="h-9 text-xs" placeholder="25.7617" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Longitude *</Label>
                  <Input value={longitude} onChange={(e) => setLongitude(e.target.value)} className="h-9 text-xs" placeholder="-80.1918" />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Facets</Label>
                  {facetOptions.length === 0 ? (
                    <Input value={facets} onChange={(e) => setFacets(e.target.value)} className="h-9 text-xs" placeholder="10" />
                  ) : (
                    <Select value={facets} onValueChange={setFacets}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>
                        {facetOptions.map((f, i) => {
                          const v = asValue(f) || asLabel(f);
                          return <SelectItem key={`${v}-${i}`} value={v} className="text-xs">{asLabel(f)}</SelectItem>;
                        })}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Primary Pitch</Label>
                  {primaryPitchOptions.length === 0 ? (
                    <Input value={primaryPitch} onChange={(e) => setPrimaryPitch(e.target.value)} className="h-9 text-xs" placeholder="5/12" />
                  ) : (
                    <Select value={primaryPitch} onValueChange={setPrimaryPitch}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>
                        {primaryPitchOptions.map((p, i) => {
                          const v = asValue(p) || asLabel(p);
                          return <SelectItem key={`${v}-${i}`} value={v} className="text-xs">{asLabel(p)}</SelectItem>;
                        })}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Secondary Pitch</Label>
                  {secondaryPitchOptions.length === 0 ? (
                    <Input value={secondaryPitch} onChange={(e) => setSecondaryPitch(e.target.value)} className="h-9 text-xs" placeholder="7/12" />
                  ) : (
                    <Select value={secondaryPitch} onValueChange={setSecondaryPitch}>
                      <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="—" /></SelectTrigger>
                      <SelectContent>
                        {secondaryPitchOptions.map((p, i) => {
                          const v = asValue(p) || asLabel(p);
                          return <SelectItem key={`${v}-${i}`} value={v} className="text-xs">{asLabel(p)}</SelectItem>;
                        })}
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md border border-border p-2">
                <div>
                  <Label className="text-xs">Expedited Delivery</Label>
                  {catalog?.expedited_delivery_amount != null && (
                    <p className="text-[10px] text-muted-foreground">+${catalog.expedited_delivery_amount}</p>
                  )}
                </div>
                <Switch checked={expedited} onCheckedChange={setExpedited} />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Notes</Label>
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="text-xs"
                  rows={2}
                  placeholder="Anything 1ESX should know…"
                />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={() => submitMutation.mutate()} disabled={submitMutation.isPending || catalogLoading}>
              {submitMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Submitting…</>
              ) : (
                "Submit Order"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
