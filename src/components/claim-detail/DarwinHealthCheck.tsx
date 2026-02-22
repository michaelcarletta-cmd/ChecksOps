import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Loader2, RefreshCw, CheckCircle, AlertTriangle, XCircle,
  FileText, Clock, Shield, MessageSquare, Eye, Copy, ChevronRight,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface DarwinHealthCheckProps {
  claimId: string;
  claim: any;
}

type SectionStatus = "ok" | "warning" | "error" | "info";

const statusIcon = (s: SectionStatus) => {
  switch (s) {
    case "ok": return <CheckCircle className="h-4 w-4 text-emerald-500" />;
    case "warning": return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    case "error": return <XCircle className="h-4 w-4 text-destructive" />;
    case "info": return <AlertTriangle className="h-4 w-4 text-blue-500" />;
  }
};

export const DarwinHealthCheck = ({ claimId, claim }: DarwinHealthCheckProps) => {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const runCheck = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("darwin-health-check", {
        body: { claimId },
      });
      if (error) throw error;
      setResult(data);
      toast.success("Health check complete");
    } catch (err: any) {
      toast.error("Health check failed: " + (err.message || "Unknown error"));
    } finally {
      setLoading(false);
    }
  };

  const copyJSON = () => {
    navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    toast.success("JSON copied to clipboard");
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <CardTitle className="text-lg">Darwin Health Check</CardTitle>
            {result && (
              <Badge
                variant={result.status === "Healthy" ? "default" : "destructive"}
                className={cn(
                  "text-xs",
                  result.status === "Healthy" && "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 hover:bg-emerald-500/20"
                )}
              >
                {result.status}
              </Badge>
            )}
            {result?.ran_at && (
              <span className="text-xs text-muted-foreground">
                {new Date(result.ran_at).toLocaleString()}
              </span>
            )}
          </div>
          <Button size="sm" onClick={runCheck} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            Run Check
          </Button>
        </div>
      </CardHeader>

      {result && (
        <CardContent className="space-y-3">
          {/* Documents */}
          <SectionCard
            icon={<FileText className="h-4 w-4" />}
            title="Documents"
            status={result.documents?.status}
          >
            <div className="text-sm space-y-1">
              <p><span className="text-muted-foreground">Total files:</span> {result.documents?.total_files}</p>
              <p><span className="text-muted-foreground">With extracted text:</span> {result.documents?.files_with_text}</p>
              {result.documents?.missing_text_filenames?.length > 0 && (
                <div>
                  <span className="text-muted-foreground">Missing text:</span>
                  <ul className="list-disc list-inside ml-2 text-amber-600 dark:text-amber-400">
                    {result.documents.missing_text_filenames.map((f: string, i: number) => (
                      <li key={i} className="truncate max-w-sm">{f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </SectionCard>

          {/* Timeline */}
          <SectionCard
            icon={<Clock className="h-4 w-4" />}
            title="Timeline"
            status={result.timeline?.status}
          >
            <div className="text-sm space-y-1">
              <p><span className="text-muted-foreground">Anchor events:</span> {result.timeline?.total_anchor_events}</p>
              <p><span className="text-muted-foreground">Total events:</span> {result.timeline?.total_events}</p>
              {result.timeline?.missing_anchors?.length > 0 && (
                <div>
                  <span className="text-muted-foreground">Missing anchors:</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {result.timeline.missing_anchors.map((a: string) => (
                      <Badge key={a} variant="outline" className="text-xs">{a.replace(/_/g, " ")}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </SectionCard>

          {/* Expert Reports */}
          <SectionCard
            icon={<Shield className="h-4 w-4" />}
            title="Expert Reports"
            status={result.expert_reports?.status}
          >
            <div className="text-sm space-y-1">
              <p>
                <span className="text-muted-foreground">Detected:</span>{" "}
                {result.expert_reports?.detected ? (
                  <span className="text-emerald-600 font-medium">Yes</span>
                ) : (
                  <span className="text-amber-600 font-medium">No</span>
                )}
              </p>
              {result.expert_reports?.filenames?.length > 0 && (
                <div>
                  <span className="text-muted-foreground">Files triggering detection:</span>
                  <ul className="list-disc list-inside ml-2">
                    {result.expert_reports.filenames.map((f: string, i: number) => (
                      <li key={i} className="truncate max-w-sm">{f}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </SectionCard>

          {/* Comms */}
          <SectionCard
            icon={<MessageSquare className="h-4 w-4" />}
            title="Communications"
            status={result.comms?.status}
          >
            <div className="text-sm space-y-1">
              {result.comms?.last_email ? (
                <p>
                  <span className="text-muted-foreground">Last email:</span>{" "}
                  {result.comms.last_email.subject || "(no subject)"}{" "}
                  <span className="text-xs text-muted-foreground">
                    ({result.comms.last_email.direction} · {new Date(result.comms.last_email.date).toLocaleDateString()})
                  </span>
                </p>
              ) : (
                <p className="text-muted-foreground">No emails logged</p>
              )}
              {result.comms?.last_sms ? (
                <p>
                  <span className="text-muted-foreground">Last SMS:</span>{" "}
                  {result.comms.last_sms.body}{" "}
                  <span className="text-xs text-muted-foreground">
                    ({result.comms.last_sms.status} · {new Date(result.comms.last_sms.date).toLocaleDateString()})
                  </span>
                </p>
              ) : (
                <p className="text-muted-foreground">No SMS logged</p>
              )}
            </div>
          </SectionCard>

          {/* Warnings Integrity */}
          <SectionCard
            icon={<Eye className="h-4 w-4" />}
            title="Warnings Integrity"
            status="info"
          >
            <div className="text-sm space-y-2">
              {result.warnings_integrity?.map((w: any, i: number) => (
                <div key={i} className="border rounded p-2 bg-muted/30">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium">{w.warning}</span>
                    <Badge variant="outline" className="text-xs">
                      {w.suppressed ? "Suppressed ✅" : "Active ⚠️"}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <p>Files by classification: {w.why?.files_by_classification?.join(", ") || "none"}</p>
                    <p>Files by name: {w.why?.files_by_name?.join(", ") || "none"}</p>
                    <p>Files by text markers: {w.why?.files_by_text_markers?.join(", ") || "none"}</p>
                    <p>Events matched: {w.why?.events_matched?.length || 0}</p>
                    <p>Rule result: {String(w.why?.rule_result)}</p>
                  </div>
                </div>
              ))}
            </div>
          </SectionCard>

          {/* Denial Truth Layer */}
          {result.denial_truth_layer?.raw_denial_count > 0 && (
            <SectionCard
              icon={<FileText className="h-4 w-4" />}
              title={`Denial Truth Layer (${result.denial_truth_layer.raw_denial_count} raw → ${result.denial_truth_layer.merged_denial_count} merged)`}
              status={result.denial_truth_layer.merge_log?.length > 0 ? "warning" : "ok"}
            >
              <div className="text-sm space-y-1">
                {result.denial_truth_layer.merged_denials?.map((d: any, i: number) => (
                  <div key={i} className="border rounded p-2 bg-muted/30">
                    <p className="font-medium">{d.summary || "Denial"}</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(d.occurred_at).toLocaleDateString()}
                      {d.amended_by?.length > 0 && " · Denial (amended)"}
                    </p>
                  </div>
                ))}
                {result.denial_truth_layer.merge_log?.map((m: any, i: number) => (
                  <p key={`ml-${i}`} className="text-xs text-muted-foreground">
                    Merged: {m.merged_event} → {m.into} ({m.reason})
                  </p>
                ))}
              </div>
            </SectionCard>
          )}

          {/* Advanced JSON Collapsible */}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="w-full justify-start text-xs text-muted-foreground">
                <ChevronRight className={cn("h-3 w-3 mr-1 transition-transform", advancedOpen && "rotate-90")} />
                Advanced
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 space-y-2">
                <Button variant="outline" size="sm" onClick={copyJSON}>
                  <Copy className="h-3 w-3 mr-1" /> Copy JSON
                </Button>
                <ScrollArea className="h-64 rounded border bg-muted/40 p-2">
                  <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                    {JSON.stringify(result, null, 2)}
                  </pre>
                </ScrollArea>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      )}

      {!result && !loading && (
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Click "Run Check" to diagnose this claim's data integrity, timeline anchors, expert report detection, and more.
          </p>
        </CardContent>
      )}
    </Card>
  );
};

function SectionCard({ icon, title, status, children }: {
  icon: React.ReactNode;
  title: string;
  status: SectionStatus;
  children: React.ReactNode;
}) {
  return (
    <div className="border rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        {statusIcon(status)}
        <span className="flex items-center gap-1.5 text-sm font-medium">
          {icon} {title}
        </span>
      </div>
      {children}
    </div>
  );
}

export default DarwinHealthCheck;
