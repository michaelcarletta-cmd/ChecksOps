import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Download, FileText, CheckCircle2, AlertTriangle, Clock, Landmark, Scale, BookCheck, Lock } from "lucide-react";
import { format } from "date-fns";

const fmtMoney = (n: number | null | undefined) =>
  n != null ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : "$0.00";

interface CloseoutItem {
  id: string;
  check_number: string | null;
  carrier_name: string | null;
  amount: number;
  status: string;
  provider: string | null;
  created_at: string;
  cleared_at: string | null;
  bank_confirmed_at: string | null;
  bank_reference: string | null;
  reconciled_at: string | null;
  reconciled_amount: number | null;
  variance_amount: number | null;
  accounting_synced_at: string | null;
  closeout_at: string | null;
}

export function CloseoutPacketViewer({ depositItemId }: { depositItemId: string }) {
  const { data: item } = useQuery({
    queryKey: ["closeout-item", depositItemId],
    queryFn: async () => {
      const { data, error } = await supabase.from("deposit_items").select("*").eq("id", depositItemId).single();
      if (error) throw error;
      return data as CloseoutItem;
    },
  });

  const { data: attachments = [] } = useQuery({
    queryKey: ["closeout-attachments", depositItemId],
    queryFn: async () => {
      const { data, error } = await supabase.from("deposit_attachments").select("*").eq("deposit_item_id", depositItemId).order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: exceptions = [] } = useQuery({
    queryKey: ["closeout-exceptions", depositItemId],
    queryFn: async () => {
      const { data, error } = await supabase.from("deposit_exceptions").select("*").eq("deposit_item_id", depositItemId).order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: auditLog = [] } = useQuery({
    queryKey: ["closeout-audit", depositItemId],
    queryFn: async () => {
      const { data, error } = await supabase.from("deposit_audit_log").select("*").eq("deposit_item_id", depositItemId).order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });

  if (!item) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;

  const handlePrint = () => window.print();

  const handleExportJSON = () => {
    const packet = {
      deposit_item: item,
      attachments: attachments.map((a: Record<string, unknown>) => ({ type: a.attachment_type, name: a.file_name, date: a.created_at })),
      exceptions: exceptions.map((e: Record<string, unknown>) => ({ code: e.exception_code, type: e.exception_type, severity: e.severity, description: e.description, resolved: !!e.resolved_at, resolution_notes: e.resolution_notes })),
      audit_trail: auditLog.map((a: Record<string, unknown>) => ({ action: a.action, amount: a.amount, notes: a.notes, date: a.created_at })),
    };
    const blob = new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `closeout-packet-${item.check_number ?? item.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4 print:space-y-2">
      <div className="flex items-center justify-between print:hidden">
        <h3 className="text-sm font-semibold">Closeout Packet — #{item.check_number || item.id.slice(0, 8)}</h3>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={handlePrint}>
            <FileText className="h-3 w-3 mr-1" />Print
          </Button>
          <Button size="sm" variant="outline" className="text-xs h-7" onClick={handleExportJSON}>
            <Download className="h-3 w-3 mr-1" />Export JSON
          </Button>
        </div>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <div><span className="text-muted-foreground text-xs">Check #</span><br />#{item.check_number || "—"}</div>
            <div><span className="text-muted-foreground text-xs">Carrier</span><br />{item.carrier_name || "—"}</div>
            <div><span className="text-muted-foreground text-xs">Amount</span><br />{fmtMoney(item.amount)}</div>
            <div><span className="text-muted-foreground text-xs">Provider</span><br />{item.provider || "—"}</div>
          </div>
          <Separator />
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
            <div className="flex items-center gap-1">
              <CheckCircle2 className={`h-3 w-3 ${item.cleared_at ? "text-emerald-400" : "text-muted-foreground"}`} />
              <span>Deposited {item.cleared_at ? format(new Date(item.cleared_at), "MMM d") : "—"}</span>
            </div>
            <div className="flex items-center gap-1">
              <Landmark className={`h-3 w-3 ${item.bank_confirmed_at ? "text-emerald-400" : "text-muted-foreground"}`} />
              <span>Confirmed {item.bank_confirmed_at ? format(new Date(item.bank_confirmed_at), "MMM d") : "—"}</span>
            </div>
            <div className="flex items-center gap-1">
              <Scale className={`h-3 w-3 ${item.reconciled_at ? "text-emerald-400" : "text-muted-foreground"}`} />
              <span>Reconciled {item.reconciled_at ? format(new Date(item.reconciled_at), "MMM d") : "—"}</span>
            </div>
            <div className="flex items-center gap-1">
              <BookCheck className={`h-3 w-3 ${item.accounting_synced_at ? "text-emerald-400" : "text-muted-foreground"}`} />
              <span>Synced {item.accounting_synced_at ? format(new Date(item.accounting_synced_at), "MMM d") : "—"}</span>
            </div>
            <div className="flex items-center gap-1">
              <Lock className={`h-3 w-3 ${item.closeout_at ? "text-emerald-400" : "text-muted-foreground"}`} />
              <span>Closed {item.closeout_at ? format(new Date(item.closeout_at), "MMM d") : "—"}</span>
            </div>
          </div>
          {item.bank_reference && <p className="text-xs text-muted-foreground">Bank Ref: {item.bank_reference}</p>}
          {item.variance_amount != null && item.variance_amount !== 0 && (
            <p className="text-xs text-amber-400">Variance: {fmtMoney(item.variance_amount)}</p>
          )}
        </CardContent>
      </Card>

      {/* Attachments */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">Attachments ({attachments.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {attachments.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">No attachments</p>
          ) : (
            <div className="divide-y">
              {attachments.map((a: Record<string, unknown>) => (
                <div key={a.id as string} className="px-4 py-2 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[9px]">{(a.attachment_type as string).replace(/_/g, " ")}</Badge>
                    <span className="truncate max-w-[200px]">{a.file_name as string}</span>
                  </div>
                  <span className="text-muted-foreground">{format(new Date(a.created_at as string), "MMM d HH:mm")}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Exceptions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />Exception History ({exceptions.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {exceptions.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">No exceptions</p>
          ) : (
            <div className="divide-y">
              {exceptions.map((e: Record<string, unknown>) => (
                <div key={e.id as string} className="px-4 py-2 text-xs space-y-0.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Badge variant={e.severity === "critical" ? "destructive" : "outline"} className="text-[9px]">
                        {e.exception_code as string}
                      </Badge>
                      <span>{e.description as string}</span>
                    </div>
                    {e.resolved_at ? (
                      <Badge variant="outline" className="text-[9px] text-emerald-400">✓ Resolved</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[9px] text-destructive">Open</Badge>
                    )}
                  </div>
                  {e.resolution_notes && <p className="text-muted-foreground ml-4">→ {e.resolution_notes as string}</p>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Audit Trail */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs flex items-center gap-1">
            <Clock className="h-3 w-3" />Audit Trail ({auditLog.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <ScrollArea className="max-h-60">
            {auditLog.length === 0 ? (
              <p className="p-4 text-xs text-muted-foreground">No entries</p>
            ) : (
              <div className="divide-y">
                {auditLog.map((a: Record<string, unknown>) => (
                  <div key={a.id as string} className="px-4 py-2 text-xs flex items-center justify-between">
                    <div>
                      <span className="font-medium capitalize">{(a.action as string).replace(/_/g, " ")}</span>
                      {a.amount && <span className="ml-2 text-muted-foreground">{fmtMoney(a.amount as number)}</span>}
                      {a.notes && <span className="ml-2 text-muted-foreground">— {a.notes as string}</span>}
                    </div>
                    <span className="text-muted-foreground shrink-0">{format(new Date(a.created_at as string), "MMM d HH:mm")}</span>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
