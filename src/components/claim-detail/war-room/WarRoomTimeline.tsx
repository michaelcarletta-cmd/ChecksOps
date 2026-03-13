import { useState, useEffect, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  Search, Filter, Plus, Edit2, Save, X, FileText, Mail, DollarSign,
  Calendar, AlertTriangle, CheckCircle2, Clock, Gavel,
  Shield, Send, Loader2, ExternalLink, Pin, PinOff, Zap,
  ArrowRight, TrendingDown
} from "lucide-react";
import { format, parseISO, differenceInDays } from "date-fns";
import { cn } from "@/lib/utils";

const EVENT_TYPES = [
  "inspection", "estimate", "payment", "denial", "supplement",
  "communication", "document_upload", "carrier_action", "pa_action",
  "legal_escalation", "file_uploaded", "email_sent", "payment_received",
  "fnol_received", "acknowledgement_issued", "ror_issued", "denial_issued",
  "payment_issued", "estimate_issued"
] as const;

// Critical milestone types get higher base importance
const MILESTONE_TYPES = new Set([
  "denial", "denial_issued", "payment", "payment_received", "payment_issued",
  "legal_escalation", "inspection", "supplement", "fnol_received", "estimate_issued"
]);

const EVENT_TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string; importance: number }> = {
  inspection:        { label: "Inspection",       icon: <Calendar className="h-3.5 w-3.5" />,      color: "bg-chart-1/20 text-chart-1 border-chart-1/30", importance: 8 },
  estimate:          { label: "Estimate",         icon: <FileText className="h-3.5 w-3.5" />,      color: "bg-chart-2/20 text-chart-2 border-chart-2/30", importance: 6 },
  estimate_issued:   { label: "Estimate Issued",  icon: <FileText className="h-3.5 w-3.5" />,      color: "bg-chart-2/20 text-chart-2 border-chart-2/30", importance: 7 },
  payment:           { label: "Payment",          icon: <DollarSign className="h-3.5 w-3.5" />,    color: "bg-success/20 text-success border-success/30", importance: 9 },
  payment_received:  { label: "Payment Received", icon: <DollarSign className="h-3.5 w-3.5" />,    color: "bg-success/20 text-success border-success/30", importance: 9 },
  payment_issued:    { label: "Payment Issued",   icon: <DollarSign className="h-3.5 w-3.5" />,    color: "bg-success/20 text-success border-success/30", importance: 9 },
  denial:            { label: "Denial",           icon: <AlertTriangle className="h-3.5 w-3.5" />, color: "bg-destructive/20 text-destructive border-destructive/30", importance: 10 },
  denial_issued:     { label: "Denial Issued",    icon: <AlertTriangle className="h-3.5 w-3.5" />, color: "bg-destructive/20 text-destructive border-destructive/30", importance: 10 },
  supplement:        { label: "Supplement",       icon: <Plus className="h-3.5 w-3.5" />,          color: "bg-primary/20 text-primary border-primary/30", importance: 7 },
  communication:     { label: "Communication",    icon: <Mail className="h-3.5 w-3.5" />,          color: "bg-chart-4/20 text-chart-4 border-chart-4/30", importance: 3 },
  email_sent:        { label: "Email Sent",       icon: <Send className="h-3.5 w-3.5" />,          color: "bg-chart-4/20 text-chart-4 border-chart-4/30", importance: 3 },
  document_upload:   { label: "Document Upload",  icon: <FileText className="h-3.5 w-3.5" />,      color: "bg-muted text-muted-foreground border-border", importance: 2 },
  file_uploaded:     { label: "File Uploaded",    icon: <FileText className="h-3.5 w-3.5" />,      color: "bg-muted text-muted-foreground border-border", importance: 2 },
  carrier_action:    { label: "Carrier Action",   icon: <Shield className="h-3.5 w-3.5" />,        color: "bg-warning/20 text-warning border-warning/30", importance: 7 },
  pa_action:         { label: "PA Action",        icon: <CheckCircle2 className="h-3.5 w-3.5" />,  color: "bg-primary/20 text-primary border-primary/30", importance: 5 },
  legal_escalation:  { label: "Legal Escalation", icon: <Gavel className="h-3.5 w-3.5" />,         color: "bg-destructive/20 text-destructive border-destructive/30", importance: 10 },
  fnol_received:     { label: "FNOL Received",    icon: <Clock className="h-3.5 w-3.5" />,         color: "bg-chart-3/20 text-chart-3 border-chart-3/30", importance: 8 },
  acknowledgement_issued: { label: "Acknowledgement", icon: <CheckCircle2 className="h-3.5 w-3.5" />, color: "bg-chart-3/20 text-chart-3 border-chart-3/30", importance: 5 },
  ror_issued:        { label: "ROR Issued",       icon: <FileText className="h-3.5 w-3.5" />,      color: "bg-warning/20 text-warning border-warning/30", importance: 6 },
};

const getEventMeta = (type: string) =>
  EVENT_TYPE_META[type] || { label: type.replace(/_/g, " "), icon: <Clock className="h-3.5 w-3.5" />, color: "bg-muted text-muted-foreground border-border", importance: 1 };

interface TimelineEvent {
  id: string;
  event_type: string;
  occurred_at: string;
  summary: string | null;
  actor: string | null;
  source_artifact_id: string | null;
  source_artifact_type: string | null;
  metadata_json: Record<string, unknown>;
  date_source?: string;
  is_manual?: boolean;
  is_editable?: boolean;
  is_pinned?: boolean;
  importance_score?: number;
}

interface ChronologyGap {
  type: "carrier_delay" | "payment_delay" | "unresolved_supplement" | "no_response";
  from_event: string;
  to_event: string;
  days: number;
  description: string;
}

interface Contradiction {
  event_a_id: string;
  event_b_id: string;
  description: string;
}

interface WarRoomTimelineProps {
  claimId: string;
  claim: any;
}

export const WarRoomTimeline = ({ claimId, claim }: WarRoomTimelineProps) => {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"date" | "importance">("date");
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ summary: "", event_type: "", occurred_at: "" });
  const { toast } = useToast();

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("get-claim-timeline", {
        body: { claimId },
      });
      if (error) throw error;

      const { data: manualEvents } = await supabase
        .from("claim_events")
        .select("id, event_type, occurred_at, summary, actor, source_artifact_id, source_artifact_type, metadata_json, date_source, is_manual, is_editable, is_pinned, importance_score")
        .eq("claim_id", claimId)
        .order("occurred_at", { ascending: false });

      const merged: TimelineEvent[] = [...(data?.events || [])];
      const existingIds = new Set(merged.map((e: TimelineEvent) => e.id));

      // Merge manual events and sync pin/importance from DB
      const dbEventsMap = new Map((manualEvents || []).map((e: any) => [e.id, e]));
      merged.forEach((e, i) => {
        const dbE = dbEventsMap.get(e.id);
        if (dbE) {
          merged[i] = { ...e, is_pinned: dbE.is_pinned, importance_score: dbE.importance_score, is_editable: dbE.is_editable, is_manual: dbE.is_manual };
        }
      });
      manualEvents?.forEach((e: any) => {
        if (!existingIds.has(e.id)) {
          merged.push({ ...e, is_manual: true, is_editable: true });
        }
      });

      // Assign computed importance if not set
      merged.forEach((e) => {
        if (!e.importance_score) {
          e.importance_score = getEventMeta(e.event_type).importance;
        }
      });

      merged.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());
      setEvents(merged);
    } catch (err) {
      console.error("Timeline load error:", err);
    } finally {
      setLoading(false);
    }
  }, [claimId]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  useEffect(() => {
    const channel = supabase
      .channel(`timeline-${claimId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_events", filter: `claim_id=eq.${claimId}` }, () => loadEvents())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "claim_files", filter: `claim_id=eq.${claimId}` }, () => loadEvents())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [claimId, loadEvents]);

  // Detect chronology gaps
  const gaps = useMemo<ChronologyGap[]>(() => {
    const sorted = [...events].sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime());
    const result: ChronologyGap[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const curr = sorted[i];
      const next = sorted[i + 1];
      if (!next) continue;

      const days = differenceInDays(new Date(next.occurred_at), new Date(curr.occurred_at));

      // Detect carrier response delay (>15 days between PA action and carrier response)
      if ((curr.event_type === "pa_action" || curr.event_type === "supplement" || curr.event_type === "communication") &&
        !["carrier_action", "payment", "payment_received", "payment_issued", "denial", "denial_issued", "estimate_issued"].includes(next.event_type) &&
        days > 15) {
        result.push({
          type: "carrier_delay",
          from_event: curr.id,
          to_event: next.id,
          days,
          description: `${days}-day gap after ${getEventMeta(curr.event_type).label} with no carrier response`,
        });
      }

      // Detect payment delay (>30 days after estimate or approval without payment)
      if ((curr.event_type === "estimate_issued" || curr.event_type === "estimate") &&
        !["payment", "payment_received", "payment_issued"].includes(next.event_type) && days > 30) {
        result.push({
          type: "payment_delay",
          from_event: curr.id,
          to_event: next.id,
          days,
          description: `${days}-day gap after estimate with no payment`,
        });
      }

      // Detect unresolved supplement (>20 days)
      if (curr.event_type === "supplement" &&
        !["payment", "payment_received", "estimate_issued", "denial", "denial_issued"].includes(next.event_type) && days > 20) {
        result.push({
          type: "unresolved_supplement",
          from_event: curr.id,
          to_event: next.id,
          days,
          description: `Supplement unresolved for ${days} days`,
        });
      }
    }
    return result;
  }, [events]);

  // Detect contradictions
  const contradictions = useMemo<Contradiction[]>(() => {
    const result: Contradiction[] = [];
    const denials = events.filter((e) => e.event_type === "denial" || e.event_type === "denial_issued");
    const payments = events.filter((e) => ["payment", "payment_received", "payment_issued"].includes(e.event_type));

    // Payment after denial without supplement/reversal
    for (const denial of denials) {
      for (const payment of payments) {
        if (new Date(payment.occurred_at) > new Date(denial.occurred_at)) {
          const betweenEvents = events.filter(
            (e) => new Date(e.occurred_at) > new Date(denial.occurred_at) &&
              new Date(e.occurred_at) < new Date(payment.occurred_at) &&
              (e.event_type === "supplement" || e.summary?.toLowerCase().includes("revers"))
          );
          if (betweenEvents.length === 0) {
            result.push({
              event_a_id: denial.id,
              event_b_id: payment.id,
              description: "Payment issued after denial with no documented reversal or supplement",
            });
          }
        }
      }
    }
    return result;
  }, [events]);

  const contradictionIds = useMemo(() => new Set(contradictions.flatMap((c) => [c.event_a_id, c.event_b_id])), [contradictions]);
  const gapEventIds = useMemo(() => new Set(gaps.flatMap((g) => [g.from_event, g.to_event])), [gaps]);

  // Sort & filter
  const filteredEvents = useMemo(() => {
    let result = events.filter((e) => {
      if (filterType !== "all" && e.event_type !== filterType) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (e.summary?.toLowerCase().includes(q)) || e.event_type.toLowerCase().includes(q) || (e.actor?.toLowerCase().includes(q));
      }
      return true;
    });

    if (sortBy === "importance") {
      result = [...result].sort((a, b) => {
        // Pinned first
        if (a.is_pinned && !b.is_pinned) return -1;
        if (!a.is_pinned && b.is_pinned) return 1;
        // Then by importance
        return (b.importance_score || 0) - (a.importance_score || 0);
      });
    } else {
      // Date sort with pinned first
      result = [...result].sort((a, b) => {
        if (a.is_pinned && !b.is_pinned) return -1;
        if (!a.is_pinned && b.is_pinned) return 1;
        return new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime();
      });
    }
    return result;
  }, [events, filterType, searchQuery, sortBy]);

  // Group by date
  const grouped = useMemo(() => {
    const acc: Record<string, TimelineEvent[]> = {};
    filteredEvents.forEach((e) => {
      const day = e.is_pinned ? "📌 Pinned" : (e.occurred_at?.split("T")[0] || "Unknown");
      (acc[day] = acc[day] || []).push(e);
    });
    return acc;
  }, [filteredEvents]);

  const sortedDates = useMemo(() => {
    const keys = Object.keys(grouped);
    // Pin group always first
    return keys.sort((a, b) => {
      if (a === "📌 Pinned") return -1;
      if (b === "📌 Pinned") return 1;
      return b.localeCompare(a);
    });
  }, [grouped]);

  const togglePin = async (event: TimelineEvent) => {
    const newPinned = !event.is_pinned;
    // Only pin DB events (not synthetic file/email/payment events)
    if (!event.id.includes("-")) {
      await supabase.from("claim_events").update({ is_pinned: newPinned }).eq("id", event.id);
    }
    setEvents((prev) => prev.map((e) => e.id === event.id ? { ...e, is_pinned: newPinned } : e));
  };

  const handleAddEvent = async (form: { event_type: string; occurred_at: string; summary: string; actor: string }) => {
    try {
      const { error } = await supabase.from("claim_events").insert({
        claim_id: claimId,
        event_type: form.event_type,
        occurred_at: form.occurred_at ? new Date(form.occurred_at).toISOString() : new Date().toISOString(),
        summary: form.summary,
        actor: form.actor || null,
        date_source: "manual",
        is_manual: true,
        is_editable: true,
        importance_score: getEventMeta(form.event_type).importance,
        metadata_json: {},
      });
      if (error) throw error;
      toast({ title: "Event added" });
      setShowAddDialog(false);
      loadEvents();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    try {
      const { error } = await supabase.from("claim_events").update({
        summary: editForm.summary,
        event_type: editForm.event_type,
        occurred_at: new Date(editForm.occurred_at).toISOString(),
      }).eq("id", editingId);
      if (error) throw error;
      toast({ title: "Event updated" });
      setEditingId(null);
      loadEvents();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const startEdit = (e: TimelineEvent) => {
    setEditingId(e.id);
    setEditForm({ summary: e.summary || "", event_type: e.event_type, occurred_at: e.occurred_at?.split("T")[0] || "" });
  };

  // Milestone count
  const milestoneCount = events.filter((e) => MILESTONE_TYPES.has(e.event_type)).length;

  if (loading) {
    return <div className="flex items-center justify-center h-full"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <TooltipProvider>
      <div className="space-y-3">
        {/* Gaps & Contradictions Alerts */}
        {(gaps.length > 0 || contradictions.length > 0) && (
          <div className="space-y-1.5">
            {gaps.slice(0, 3).map((g, i) => (
              <div key={`gap-${i}`} className="flex items-center gap-2 p-2 rounded-lg bg-warning/10 border border-warning/30 text-xs">
                <TrendingDown className="h-3.5 w-3.5 text-warning shrink-0" />
                <span className="text-warning font-medium">{g.type === "carrier_delay" ? "Carrier Delay" : g.type === "payment_delay" ? "Payment Delay" : "Unresolved Supplement"}:</span>
                <span className="text-muted-foreground">{g.description}</span>
                <Badge variant="outline" className="text-[9px] ml-auto border-warning/50 text-warning">{g.days}d</Badge>
              </div>
            ))}
            {contradictions.slice(0, 2).map((c, i) => (
              <div key={`contra-${i}`} className="flex items-center gap-2 p-2 rounded-lg bg-destructive/10 border border-destructive/30 text-xs">
                <Zap className="h-3.5 w-3.5 text-destructive shrink-0" />
                <span className="text-destructive font-medium">Contradiction:</span>
                <span className="text-muted-foreground">{c.description}</span>
              </div>
            ))}
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input placeholder="Search events..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="h-8 pl-7 text-xs" />
          </div>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <Filter className="h-3 w-3 mr-1" /><SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {EVENT_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="text-xs capitalize">{getEventMeta(t).label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as any)}>
            <SelectTrigger className="h-8 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="date" className="text-xs">By Date</SelectItem>
              <SelectItem value="importance" className="text-xs">By Importance</SelectItem>
            </SelectContent>
          </Select>
          <AddEventDialog open={showAddDialog} onOpenChange={setShowAddDialog} onSubmit={handleAddEvent} />
        </div>

        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>{filteredEvents.length} events</span>
          <span>•</span>
          <span>{milestoneCount} milestones</span>
          <span>•</span>
          <span className="text-warning">{gaps.length} gaps detected</span>
          {contradictions.length > 0 && (
            <><span>•</span><span className="text-destructive">{contradictions.length} contradictions</span></>
          )}
        </div>

        {/* Timeline */}
        <ScrollArea className="h-[500px]">
          <div className="space-y-4">
            {sortedDates.map((date) => (
              <div key={date}>
                <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm py-1 mb-2">
                  <Badge variant="outline" className={cn("text-[10px] font-medium", date === "📌 Pinned" && "border-primary text-primary")}>
                    {date === "📌 Pinned" ? "📌 Pinned Events" : date !== "Unknown" ? format(parseISO(date), "EEEE, MMMM d, yyyy") : "Unknown Date"}
                  </Badge>
                </div>
                <div className="space-y-1.5 pl-3 border-l-2 border-border ml-2">
                  {grouped[date].map((event) => {
                    const meta = getEventMeta(event.event_type);
                    const isEditing = editingId === event.id;
                    const isMilestone = MILESTONE_TYPES.has(event.event_type);
                    const isContradiction = contradictionIds.has(event.id);
                    const isGapEvent = gapEventIds.has(event.id);

                    return (
                      <div key={event.id} className="relative group">
                        <div className={cn(
                          "absolute -left-[calc(0.75rem+1.5px)] top-2.5 w-2.5 h-2.5 rounded-full border-2 border-background",
                          event.is_pinned ? "bg-primary ring-2 ring-primary/30" :
                          isMilestone ? "bg-warning" :
                          isContradiction ? "bg-destructive" : "bg-primary"
                        )} />

                        {isEditing ? (
                          <div className="p-2.5 rounded-lg border border-primary bg-primary/5 space-y-2">
                            <div className="flex gap-2">
                              <Input value={editForm.occurred_at} onChange={(e) => setEditForm((f) => ({ ...f, occurred_at: e.target.value }))} type="date" className="h-7 text-xs w-[140px]" />
                              <Select value={editForm.event_type} onValueChange={(v) => setEditForm((f) => ({ ...f, event_type: v }))}>
                                <SelectTrigger className="h-7 text-xs flex-1"><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  {EVENT_TYPES.map((t) => (<SelectItem key={t} value={t} className="text-xs">{getEventMeta(t).label}</SelectItem>))}
                                </SelectContent>
                              </Select>
                            </div>
                            <Input value={editForm.summary} onChange={(e) => setEditForm((f) => ({ ...f, summary: e.target.value }))} placeholder="Event summary" className="h-7 text-xs" />
                            <div className="flex gap-1">
                              <Button size="sm" className="h-6 text-[10px]" onClick={handleSaveEdit}><Save className="h-3 w-3 mr-1" /> Save</Button>
                              <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setEditingId(null)}><X className="h-3 w-3" /></Button>
                            </div>
                          </div>
                        ) : (
                          <div className={cn(
                            "p-2 rounded-lg border transition-colors",
                            event.is_pinned ? "border-primary/50 bg-primary/5" :
                            isContradiction ? "border-destructive/40 bg-destructive/5" :
                            isGapEvent ? "border-warning/40 bg-warning/5" :
                            isMilestone ? "border-primary/30 bg-primary/5" :
                            "border-border hover:bg-accent/30"
                          )}>
                            <div className="flex items-start gap-2">
                              <div className={cn("mt-0.5 p-1 rounded", meta.color)}>
                                {meta.icon}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <Badge variant="outline" className={cn("text-[9px] border", meta.color)}>
                                    {meta.label}
                                  </Badge>
                                  {isMilestone && <Badge className="text-[8px] bg-primary/20 text-primary">Milestone</Badge>}
                                  {isContradiction && (
                                    <Tooltip>
                                      <TooltipTrigger>
                                        <Badge className="text-[8px] bg-destructive/20 text-destructive">⚡ Contradiction</Badge>
                                      </TooltipTrigger>
                                      <TooltipContent className="text-xs max-w-[250px]">
                                        {contradictions.find((c) => c.event_a_id === event.id || c.event_b_id === event.id)?.description}
                                      </TooltipContent>
                                    </Tooltip>
                                  )}
                                  <span className="text-[10px] text-muted-foreground">
                                    {format(parseISO(event.occurred_at), "h:mm a")}
                                  </span>
                                  {event.actor && <span className="text-[10px] text-muted-foreground">• {event.actor}</span>}
                                  {event.is_manual && <Badge variant="secondary" className="text-[8px]">Manual</Badge>}
                                </div>
                                <p className="text-xs mt-0.5 leading-snug">{event.summary || "No summary"}</p>
                                {event.source_artifact_id && event.source_artifact_type && (
                                  <button
                                    className="text-[10px] text-primary hover:underline flex items-center gap-0.5 mt-0.5"
                                    onClick={() => toast({ title: "Source", description: `${event.source_artifact_type}: ${event.source_artifact_id}` })}
                                  >
                                    <ExternalLink className="h-2.5 w-2.5" /> View source {event.source_artifact_type}
                                  </button>
                                )}
                              </div>
                              <div className="flex items-center gap-0.5 shrink-0">
                                {/* Importance indicator */}
                                <Tooltip>
                                  <TooltipTrigger>
                                    <div className={cn(
                                      "text-[9px] font-bold w-5 h-5 rounded flex items-center justify-center",
                                      (event.importance_score || 0) >= 8 ? "bg-destructive/20 text-destructive" :
                                      (event.importance_score || 0) >= 5 ? "bg-warning/20 text-warning" :
                                      "bg-muted text-muted-foreground"
                                    )}>
                                      {event.importance_score || 0}
                                    </div>
                                  </TooltipTrigger>
                                  <TooltipContent className="text-xs">Importance score</TooltipContent>
                                </Tooltip>
                                <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100" onClick={() => togglePin(event)}>
                                  {event.is_pinned ? <PinOff className="h-3 w-3 text-primary" /> : <Pin className="h-3 w-3" />}
                                </Button>
                                {(event.is_manual || event.is_editable) && (
                                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100" onClick={() => startEdit(event)}>
                                    <Edit2 className="h-3 w-3" />
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            {sortedDates.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-8">
                No timeline events found. Add one manually or run document analysis.
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
};

const AddEventDialog = ({
  open, onOpenChange, onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (form: { event_type: string; occurred_at: string; summary: string; actor: string }) => void;
}) => {
  const [form, setForm] = useState({ event_type: "communication", occurred_at: "", summary: "", actor: "" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1"><Plus className="h-3 w-3" /> Add Event</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle className="text-sm">Add Timeline Event</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Event Type</Label>
            <Select value={form.event_type} onValueChange={(v) => setForm((f) => ({ ...f, event_type: v }))}>
              <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {EVENT_TYPES.map((t) => (<SelectItem key={t} value={t} className="text-xs">{getEventMeta(t).label}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Date</Label>
            <Input type="date" value={form.occurred_at} onChange={(e) => setForm((f) => ({ ...f, occurred_at: e.target.value }))} className="h-8 text-xs mt-1" />
          </div>
          <div>
            <Label className="text-xs">Summary</Label>
            <Textarea value={form.summary} onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))} placeholder="Describe what happened..." className="text-xs mt-1 min-h-[60px]" />
          </div>
          <div>
            <Label className="text-xs">Actor (optional)</Label>
            <Input value={form.actor} onChange={(e) => setForm((f) => ({ ...f, actor: e.target.value }))} placeholder="Who performed this action?" className="h-8 text-xs mt-1" />
          </div>
          <Button size="sm" className="w-full" disabled={!form.summary || !form.occurred_at} onClick={() => onSubmit(form)}>
            Add Event
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
