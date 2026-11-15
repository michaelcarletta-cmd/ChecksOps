import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { ChevronDown, Copy, Download, MapPin, Truck } from "lucide-react";
import { format } from "date-fns";

/**
 * Tenant-facing view of the shipping details the ChecksOps Mortgage Desk
 * recorded for a check: where the check is being mailed, and the shipping
 * label (if Mortgage Ops bought one) so the tenant can print it — or use the
 * address to buy their own label instead.
 */
export function MortgageDeskShippingCard({ checkIntakeItemId }: { checkIntakeItemId: string }) {
  const [expanded, setExpanded] = useState(false);
  const { data: req } = useQuery({
    queryKey: ["mortgage-desk-shipping", checkIntakeItemId],
    enabled: !!checkIntakeItemId,
    queryFn: async () => {
      const { data } = await supabase
        .from("mortgage_handling_requests")
        .select(
          "id,status,mortgage_company,mail_to_name,mail_to_address,shipping_label_path,shipping_label_name,shipping_label_carrier,shipping_label_tracking,shipping_label_uploaded_at" as any
        )
        .eq("check_intake_item_id", checkIntakeItemId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data as any;
    },
  });

  if (!req || (!req.mail_to_address && !req.shipping_label_path)) return null;

  const copyAddress = async () => {
    const text = [req.mail_to_name, req.mail_to_address].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Address copied" });
    } catch {
      toast({ title: "Could not copy", variant: "destructive" });
    }
  };

  const openLabel = async () => {
    const { data, error } = await supabase.storage
      .from("claim-files")
      .createSignedUrl(req.shipping_label_path, 3600);
    if (error || !data?.signedUrl) {
      toast({ title: "Could not open label", description: error?.message, variant: "destructive" });
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener");
  };

  const addressLine = [req.mail_to_name, req.mail_to_address]
    .filter(Boolean)
    .join(", ")
    .replace(/\s*\n\s*/g, ", ");
  const summary = req.mail_to_address
    ? `Mailing to ${addressLine}`
    : req.shipping_label_name || "Shipping label ready";

  // Compact (owner 2026-11-15): one line with an amber accent, the "Mortgage Desk" label, the
  // address on a single truncated line and Copy as an icon; tap for the full details.
  return (
    <div
      className="w-full rounded-md border border-border/60 border-l-2 border-l-amber-400 bg-muted/30 px-2 py-1.5 text-xs"
      data-testid="mortgage-desk-shipping-card"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Truck className="h-3 w-3 shrink-0 text-amber-400" />
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={expanded}
          aria-label={expanded ? "Hide shipping details" : "Show shipping details"}
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="shrink-0 text-[11px] font-semibold">Mortgage Desk</span>
          <span className="min-w-0 truncate text-[10px] text-muted-foreground">{summary}</span>
          <ChevronDown
            className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        {req.shipping_label_carrier && (
          <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[9px]">{req.shipping_label_carrier}</Badge>
        )}
        {req.mail_to_address && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0"
            onClick={copyAddress}
            aria-label="Copy mailing address"
            title="Copy address"
          >
            <Copy className="h-3 w-3" />
          </Button>
        )}
        {req.shipping_label_path && (
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6 shrink-0"
            onClick={openLabel}
            aria-label="Print shipping label"
            title="Print label"
          >
            <Download className="h-3 w-3" />
          </Button>
        )}
      </div>

      {expanded && (
        <div className="mt-1.5 space-y-1.5 border-t border-border/40 pt-1.5" data-testid="mortgage-desk-shipping-details">
          {req.mail_to_address && (
            <div className="space-y-0.5">
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <MapPin className="h-3 w-3" /> Check is being mailed to
              </span>
              <div className="whitespace-pre-wrap text-[11px] font-medium leading-snug">
                {req.mail_to_name && <div>{req.mail_to_name}</div>}
                {req.mail_to_address}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Prefer your own label? Use this address — just tell the desk your tracking number.
              </p>
            </div>
          )}

          {req.shipping_label_tracking && (
            <div className="text-[11px] text-muted-foreground">
              Tracking: <span className="font-medium text-foreground">{req.shipping_label_tracking}</span>
            </div>
          )}

          {req.shipping_label_path && (
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px]">
                {req.shipping_label_name || "Shipping label"}
                {req.shipping_label_uploaded_at && (
                  <span className="text-muted-foreground">
                    {" "}· {format(new Date(req.shipping_label_uploaded_at), "MMM d")}
                  </span>
                )}
              </span>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={openLabel}>
                <Download className="mr-1 h-3 w-3" /> Print label
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
