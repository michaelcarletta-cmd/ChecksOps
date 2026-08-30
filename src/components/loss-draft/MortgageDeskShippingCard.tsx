import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { Copy, Download, MapPin, Truck } from "lucide-react";
import { format } from "date-fns";

/**
 * Tenant-facing view of the shipping details the ChecksOps Mortgage Desk
 * recorded for a check: where the check is being mailed, and the shipping
 * label (if Mortgage Ops bought one) so the tenant can print it — or use the
 * address to buy their own label instead.
 */
export function MortgageDeskShippingCard({ checkIntakeItemId }: { checkIntakeItemId: string }) {
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

  return (
    <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs space-y-2">
      <div className="flex items-center gap-2">
        <Truck className="h-3.5 w-3.5 text-amber-400" />
        <span className="font-semibold">Mortgage Desk shipping</span>
        {req.shipping_label_carrier && (
          <Badge variant="secondary" className="text-[10px]">{req.shipping_label_carrier}</Badge>
        )}
      </div>

      {req.mail_to_address && (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              <MapPin className="h-3 w-3" /> Check is being mailed to
            </span>
            <Button size="sm" variant="ghost" className="h-6 px-1 text-[10px]" onClick={copyAddress}>
              <Copy className="mr-1 h-3 w-3" /> Copy
            </Button>
          </div>
          <div className="whitespace-pre-wrap font-medium leading-snug">
            {req.mail_to_name && <div>{req.mail_to_name}</div>}
            {req.mail_to_address}
          </div>
          <p className="text-[10px] text-muted-foreground">
            Prefer your own label? Use this address — just tell the desk your tracking number.
          </p>
        </div>
      )}

      {req.shipping_label_tracking && (
        <div className="text-muted-foreground">
          Tracking: <span className="font-medium text-foreground">{req.shipping_label_tracking}</span>
        </div>
      )}

      {req.shipping_label_path && (
        <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2">
          <span className="truncate">
            🏷️ {req.shipping_label_name || "Shipping label"}
            {req.shipping_label_uploaded_at && (
              <span className="text-muted-foreground">
                {" "}· {format(new Date(req.shipping_label_uploaded_at), "MMM d")}
              </span>
            )}
          </span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={openLabel}>
            <Download className="mr-1 h-3 w-3" /> Print label
          </Button>
        </div>
      )}
    </div>
  );
}
