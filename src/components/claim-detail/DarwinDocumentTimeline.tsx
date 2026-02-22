import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Loader2, Copy, Clock, RefreshCw, FileText, Calendar, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface DarwinDocumentTimelineProps {
  claimId: string;
  claim: any;
}

interface TimelineEntry {
  date: string;
  event: string;
  source_document: string;
  significance: string;
  date_source: string;
  confidence: number;
  deadline_triggered?: string | null;
}

interface TimingRiskFlag {
  flag_type: string;
  description: string;
  severity: string;
  relevant_dates: string[];
  regulation?: string;
}

interface MissingDateEvidence {
  needed: string;
  why_critical: string;
  priority: string;
}

interface TimelineResult {
  timeline: TimelineEntry[];
  timing_risk_flags: TimingRiskFlag[];
  missing_date_evidence: MissingDateEvidence[];
  deadline_compliance?: {
    summary: string;
    violations: string[];
  };
  gap_analysis?: {
    inactive_periods: Array<{ start: string; end: string; days: number; concern: string }>;
  };
}

interface ClaimEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  summary: string | null;
  date_source: string;
  date_confidence: number | null;
  doc_type: string | null;
}

export const DarwinDocumentTimeline = ({ claimId, claim }: DarwinDocumentTimelineProps) => {
  const [loading, setLoading] = useState(false);
  const [timeline, setTimeline] = useState<TimelineResult | null>(null);
  const [rawText, setRawText] = useState<string | null>(null);
  const [lastGenerated, setLastGenerated] = useState<Date | null>(null);
  const [claimEvents, setClaimEvents] = useState<ClaimEvent[]>([]);

  useEffect(() => {
    loadPreviousTimeline();
    loadClaimEvents();
  }, [claimId]);

  // Anchor event types - only these are used for timeline and strategic analysis
  const ANCHOR_EVENT_TYPES = [
    'fnol_received', 'acknowledgement_issued', 'ror_issued', 'denial_issued',
    'inspection', 'payment_issued', 'estimate_issued', 'loss_event',
    'document_received', 'engineer_report_issued', 'deadline',
    'prior_loss_mentioned',
  ];

  const loadClaimEvents = async () => {
    const { data } = await supabase
      .from('claim_events')
      .select('id, event_type, occurred_at, summary, date_source, date_confidence, doc_type')
      .eq('claim_id', claimId)
      .in('event_type', ANCHOR_EVENT_TYPES)
      .order('occurred_at', { ascending: true });
    if (data) setClaimEvents(data as ClaimEvent[]);
  };

  const loadPreviousTimeline = async () => {
    const { data } = await supabase
      .from('darwin_analysis_results')
      .select('*')
      .eq('claim_id', claimId)
      .eq('analysis_type', 'document_timeline')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (data) {
      tryParseResult(data.result);
      setLastGenerated(new Date(data.created_at));
    }
  };

  const tryParseResult = (result: string) => {
    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as TimelineResult;
        if (parsed.timeline && Array.isArray(parsed.timeline)) {
          setTimeline(parsed);
          setRawText(null);
          return;
        }
      }
    } catch { /* fall through */ }
    setTimeline(null);
    setRawText(result);
  };

  const rebuildTimeline = async () => {
    setLoading(true);
    try {
      // 1) Wipe only document-extracted claim_events (preserve manual/CRM entries)
      await supabase.from('claim_events').delete()
        .eq('claim_id', claimId)
        .in('date_source', ['document_extracted', 'document_text_regex', 'system_upload']);
      console.log('[RebuildTimeline] Wiped all claim_events for claim', claimId);

      // 2) Reset all files to unprocessed so darwin-process-document re-extracts
      await supabase.from('claim_files')
        .update({ processed_by_darwin: false })
        .eq('claim_id', claimId);

      // 3) Get all files and re-trigger processing
      const { data: files } = await supabase
        .from('claim_files')
        .select('id, file_name')
        .eq('claim_id', claimId);

      let processed = 0;
      for (const f of (files || [])) {
        try {
          await supabase.functions.invoke('darwin-process-document', {
            body: { fileId: f.id, claimId }
          });
          processed++;
        } catch (err) {
          console.error(`[RebuildTimeline] Failed to process file ${f.file_name}:`, err);
        }
      }

      // 4) Reload events and regenerate AI timeline
      await loadClaimEvents();
      toast.success(`Timeline rebuilt: ${processed} files reprocessed`);

      // 5) Now generate the AI-driven timeline summary
      await generateTimeline();
    } catch (err: any) {
      console.error('Rebuild timeline error:', err);
      toast.error(err.message || 'Failed to rebuild timeline');
    } finally {
      setLoading(false);
    }
  };

  const generateTimeline = async () => {
    setLoading(true);
    try {
      const { data: files } = await supabase
        .from('claim_files')
        .select('id, file_name, file_path, file_type, extracted_text, uploaded_at, document_classification, claim_folders(name)')
        .eq('claim_id', claimId);

      const filesWithText = (files || []).filter(f => f.extracted_text && f.extracted_text.length > 50);

      const { data: emails } = await supabase
        .from('emails')
        .select('id, subject, recipient_email, created_at, body')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: true });

      const docSummaries = filesWithText.map(f => ({
        file_name: f.file_name,
        classification: (f as any).document_classification || 'unknown',
        folder: (f as any).claim_folders?.name || 'Unfiled',
        uploaded_at: f.uploaded_at,
        text_excerpt: f.extracted_text!.substring(0, 2000),
      }));

      const emailSummaries = (emails || []).map(e => ({
        subject: e.subject,
        recipient: e.recipient_email,
        date: e.created_at,
        body_excerpt: (e.body || '').substring(0, 500),
      }));

      const { data, error } = await supabase.functions.invoke('darwin-ai-analysis', {
        body: {
          claimId,
          analysisType: 'document_timeline',
          additionalContext: {
            documents: docSummaries,
            emails: emailSummaries,
            totalFiles: files?.length || 0,
            filesWithText: filesWithText.length,
          }
        }
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      tryParseResult(data.result);
      setLastGenerated(new Date());

      const { data: userData } = await supabase.auth.getUser();
      await supabase.from('darwin_analysis_results').insert({
        claim_id: claimId,
        analysis_type: 'document_timeline',
        input_summary: `${files?.length || 0} files, ${emails?.length || 0} emails, ${claimEvents.length} events`,
        result: data.result,
        created_by: userData.user?.id
      });

      await loadClaimEvents();
      toast.success(`Timeline built from ${claimEvents.length} events + ${filesWithText.length} docs`);
    } catch (err: any) {
      console.error("Timeline generation error:", err);
      toast.error(err.message || "Failed to generate timeline");
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = () => {
    const text = timeline
      ? timeline.timeline.map(t => `${t.date} — ${t.event} (${t.source_document})`).join('\n')
      : rawText || '';
    navigator.clipboard.writeText(text);
    toast.success("Timeline copied");
  };

  const severityColor = (s: string) => {
    if (s === 'high') return 'text-red-600 bg-red-50 border-red-200';
    if (s === 'medium') return 'text-amber-600 bg-amber-50 border-amber-200';
    return 'text-blue-600 bg-blue-50 border-blue-200';
  };

  const confidenceBadge = (c: number) => {
    if (c >= 0.9) return <Badge variant="default" className="text-[10px] px-1.5 py-0 bg-green-600">High</Badge>;
    if (c >= 0.7) return <Badge variant="secondary" className="text-[10px] px-1.5 py-0">Med</Badge>;
    return <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-amber-600 border-amber-300">Low</Badge>;
  };

  const hasContent = timeline || rawText;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              Document-Driven Claim Timeline
              {claimEvents.length > 0 && (
                <Badge variant="secondary" className="text-xs gap-1">
                  {claimEvents.length} events
                </Badge>
              )}
              {timeline && (
                <Badge variant="secondary" className="text-xs gap-1">
                  <Clock className="h-3 w-3" />
                  Generated
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Dates extracted from inside documents (denial letters, estimates, reports) — not upload timestamps
            </CardDescription>
          </div>
          {hasContent && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={rebuildTimeline} disabled={loading}>
                <RefreshCw className={cn("h-4 w-4 mr-1", loading && "animate-spin")} />
                Rebuild
              </Button>
              <Button variant="outline" size="sm" onClick={copyToClipboard}>
                <Copy className="h-4 w-4 mr-1" />
                Copy
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!hasContent ? (
          <div className="text-center py-6 space-y-3">
            <FileText className="h-10 w-10 mx-auto text-muted-foreground/30" />
            <p className="text-sm text-muted-foreground">
              Darwin extracts dates from inside uploaded documents to build a true chronological timeline anchored to the loss date.
            </p>
            {claimEvents.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {claimEvents.length} date events already extracted from documents.
              </p>
            )}
            <Button onClick={generateTimeline} disabled={loading} className="gap-2">
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Analyzing documents...
                </>
              ) : (
                <>
                  <Calendar className="h-4 w-4" />
                  Build Document-Driven Timeline
                </>
              )}
            </Button>
          </div>
        ) : rawText ? (
          <div className="space-y-3">
            {lastGenerated && (
              <div className="text-xs text-muted-foreground">
                Last generated: {lastGenerated.toLocaleString()}
              </div>
            )}
            <ScrollArea className="h-[400px] border rounded-md">
              <pre className="p-4 text-sm whitespace-pre-wrap font-mono bg-muted/30">
                {rawText}
              </pre>
            </ScrollArea>
          </div>
        ) : timeline ? (
          <div className="space-y-4">
            {lastGenerated && (
              <div className="text-xs text-muted-foreground">
                Last generated: {lastGenerated.toLocaleString()}
              </div>
            )}

            {/* Timeline Table */}
            <ScrollArea className="h-[320px] border rounded-md">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium w-[100px]">Date</th>
                    <th className="text-left px-3 py-2 font-medium">Event</th>
                    <th className="text-left px-3 py-2 font-medium w-[160px]">Source</th>
                    <th className="text-left px-3 py-2 font-medium w-[60px]">Conf.</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.timeline.map((entry, i) => (
                    <tr key={i} className="border-t hover:bg-muted/30">
                      <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{entry.date}</td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-xs">{entry.event}</div>
                        {entry.significance && (
                          <div className="text-[11px] text-muted-foreground mt-0.5">{entry.significance}</div>
                        )}
                        {entry.deadline_triggered && (
                          <div className="text-[11px] text-red-600 mt-0.5 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            {entry.deadline_triggered}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[160px]" title={entry.source_document}>
                        {entry.source_document}
                      </td>
                      <td className="px-3 py-2">
                        {confidenceBadge(entry.confidence)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollArea>

            {/* Timing Risk Flags */}
            {timeline.timing_risk_flags && timeline.timing_risk_flags.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Timing Risk Flags
                </h4>
                <div className="grid gap-2">
                  {timeline.timing_risk_flags.map((flag, i) => (
                    <div key={i} className={cn("border rounded-md px-3 py-2 text-xs", severityColor(flag.severity))}>
                      <div className="font-medium">{flag.flag_type.replace(/_/g, ' ').toUpperCase()}: {flag.description}</div>
                      {flag.regulation && <div className="mt-0.5 opacity-80">Regulation: {flag.regulation}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Deadline Compliance */}
            {timeline.deadline_compliance && (
              <div className="space-y-1.5">
                <h4 className="text-sm font-medium flex items-center gap-1.5">
                  {timeline.deadline_compliance.violations?.length ? (
                    <XCircle className="h-4 w-4 text-red-500" />
                  ) : (
                    <CheckCircle className="h-4 w-4 text-green-500" />
                  )}
                  Deadline Compliance
                </h4>
                <p className="text-xs text-muted-foreground">{timeline.deadline_compliance.summary}</p>
                {timeline.deadline_compliance.violations?.map((v, i) => (
                  <div key={i} className="text-xs text-red-600 pl-5">• {v}</div>
                ))}
              </div>
            )}

            {/* Missing Date Evidence */}
            {timeline.missing_date_evidence && timeline.missing_date_evidence.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Missing Date Evidence</h4>
                <div className="grid gap-1.5">
                  {timeline.missing_date_evidence.map((m, i) => (
                    <div key={i} className="flex items-start gap-2 text-xs">
                      <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0 shrink-0", m.priority === 'high' ? 'border-red-300 text-red-600' : m.priority === 'medium' ? 'border-amber-300 text-amber-600' : '')}>
                        {m.priority}
                      </Badge>
                      <div>
                        <span className="font-medium">{m.needed}</span>
                        <span className="text-muted-foreground ml-1">— {m.why_critical}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Gap Analysis */}
            {timeline.gap_analysis?.inactive_periods && timeline.gap_analysis.inactive_periods.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-sm font-medium">Inactivity Gaps</h4>
                {timeline.gap_analysis.inactive_periods.map((gap, i) => (
                  <div key={i} className="text-xs text-muted-foreground pl-3 border-l-2 border-amber-300">
                    {gap.start} → {gap.end} ({gap.days} days): {gap.concern}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

export default DarwinDocumentTimeline;
