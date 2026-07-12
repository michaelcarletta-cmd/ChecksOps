import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, ImageIcon, CheckCircle2, XCircle, Send } from "lucide-react";
import { toast } from "sonner";

type PendingUpload = {
  id: string;
  tenant_id: string;
  token_id: string | null;
  claim_id: string | null;
  front_path: string;
  back_path: string | null;
  amount_estimate: number | null;
  homeowner_note: string | null;
  status: string;
  created_at: string;
};

export function HomeownerSubmittedChecksInbox({ tenantId }: { tenantId?: string }) {
  const [items, setItems] = useState<PendingUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [signed, setSigned] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    let q = supabase
      .from("homeowner_ledger_check_uploads")
      .select("*")
      .eq("status", "pending_review")
      .order("created_at", { ascending: false })
      .limit(50);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const { data } = await q;
    const rows = (data ?? []) as PendingUpload[];
    setItems(rows);

    const paths = rows.flatMap((r) => [r.front_path, r.back_path].filter(Boolean) as string[]);
    if (paths.length) {
      const { data: signedList } = await supabase.storage
        .from("homeowner-uploads")
        .createSignedUrls(paths, 60 * 30);
      const map: Record<string, string> = {};
      (signedList ?? []).forEach((s: any) => { if (s.path && s.signedUrl) map[s.path] = s.signedUrl; });
      setSigned(map);
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tenantId]);

  const reject = async (id: string) => {
    await supabase.from("homeowner_ledger_check_uploads")
      .update({ status: "rejected", reviewed_at: new Date().toISOString() })
      .eq("id", id);
    toast.success("Marked rejected");
    load();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Send className="h-4 w-4 rotate-180" /> Homeowner-Submitted Checks
          {items.length > 0 && <Badge className="ml-1 text-[10px]">{items.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : items.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-6">Nothing pending triage.</div>
        ) : (
          <ul className="space-y-3">
            {items.map((it) => (
              <li key={it.id} className="border border-border rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <div>
                    <div className="font-medium">
                      {it.amount_estimate != null
                        ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(it.amount_estimate))
                        : "No amount"}
                      {it.claim_id ? " • linked to claim" : " • pre-claim"}
                    </div>
                    <div className="text-muted-foreground">{new Date(it.created_at).toLocaleString()}</div>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">Pending</Badge>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Thumb path={it.front_path} url={signed[it.front_path]} label="Front" />
                  {it.back_path && <Thumb path={it.back_path} url={signed[it.back_path]} label="Back" />}
                </div>
                {it.homeowner_note && (
                  <div className="text-xs bg-muted p-2 rounded"><strong>Note:</strong> {it.homeowner_note}</div>
                )}
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => toast.info("Open the claim's Checks tab to attach this image.")}>
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Attach to claim
                  </Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => reject(it.id)}>
                    <XCircle className="h-3 w-3 mr-1" /> Reject
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Thumb({ path, url, label }: { path: string; url?: string; label: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className="block border border-border rounded overflow-hidden hover:border-primary">
      {url ? (
        <img src={url} alt={label} className="w-full h-32 object-cover" />
      ) : (
        <div className="w-full h-32 flex items-center justify-center bg-muted text-muted-foreground">
          <ImageIcon className="h-5 w-5" />
        </div>
      )}
      <div className="text-[10px] text-center py-1 bg-muted/50">{label}</div>
    </a>
  );
}
