import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Search, Filter, Plus, Edit2, Save, X, FileText, Mail, DollarSign,
  Calendar, AlertTriangle, CheckCircle2, Clock, Camera, Gavel,
  Shield, Send, Loader2, ExternalLink
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

const EVENT_TYPES = [
  "inspection", "estimate", "payment", "denial", "supplement",
  "communication", "document_upload", "carrier_action", "pa_action",
  "legal_escalation", "file_uploaded", "email_sent", "payment_received",
  "fnol_received", "acknowledgement_issued", "ror_issued", "denial_issued",
  "payment_issued", "estimate_issued"
] as const;

const EVENT_TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  inspection:        { label: "Inspection",       icon: <Calendar className="h-3.5 w-3.5" />,      color: "bg-chart-1/20 text-chart-1 border-chart-1/30" },
  estimate:          { label: "Estimate",         icon: <FileText className="h-3.5 w-3.5" />,      color: "bg-chart-2/20 text-chart-2 border-chart-2/30" },
  estimate_issued:   { label: "Estimate Issued",  icon: <FileText className="h-3.5 w-3.5" />,      color: "bg-chart-2/20 text-chart-2 border-chart-2/30" },
  payment:           { label: "Payment",          icon: <DollarSign className="h-3.5 w-3.5" />,    color: "bg-success/20 text-success border-success/30" },
  payment_received:  { label: "Payment Received", icon: <DollarSign className="h-3.5 w-3.5" />,    color: "bg-success/20 text-success border-success/30" },
  payment_issued:    { label: "Payment Issued",   icon: <DollarSign className="h-3.5 w-3.5" />,    color: "bg-success/20 text-success border-success/30" },
  denial:            { label: "Denial",           icon: <AlertTriangle className="h-3.5 w-3.5" />, color: "bg-destructive/20 text-destructive border-destructive/30" },
  denial_issued:     { label: "Denial Issued",    icon: <AlertTriangle className="h-3.5 w-3.5" />, color: "bg-destructive/20 text-destructive border-destructive/30" },
  supplement:        { label: "Supplement",       icon: <Plus className="h-3.5 w-3.5" />,          color: "bg-primary/20 text-primary border-primary/30" },
  communication:     { label: "Communication",    icon: <Mail className="h-3.5 w-3.5" />,          color: "bg-chart-4/20 text-chart-4 border-chart-4/30" },
  email_sent:        { label: "Email Sent",       icon: <Send className="h-3.5 w-3.5" />,          color: "bg-chart-4/20 text-chart-4 border-chart-4/30" },
  document_upload:   { label: "Document Upload",  icon: <FileText className="h-3.5 w-3.5" />,      color: "bg-muted text-muted-foreground border-border" },
  file_uploaded:     { label: "File Uploaded",    icon: <FileText className="h-3.5 w-3.5" />,      color: "bg-muted text-muted-foreground border-border" },
  carrier_action:    { label: "Carrier Action",   icon: <Shield className="h-3.5 w-3.5" />,        color: "bg-warning/20 text-warning border-warning/30" },
  pa_action:         { label: "PA Action",        icon: <CheckCircle2 className="h-3.5 w-3.5" />,  color: "bg-primary/20 text-primary border-primary/30" },
  legal_escalation:  { label: "Legal Escalation", icon: <Gavel className="h-3.5 w-3.5" />,         color: "bg-destructive/20 text-destructive border-destructive/30" },
  fnol_received:     { label: "FNOL Received",    icon: <Clock className="h-3.5 w-3.5" />,         color: "bg-chart-3/20 text-chart-3 border-chart-3/30" },
  acknowledgement_issued: { label: "Acknowledgement", icon: <CheckCircle2 className="h-3.5 w-3.5" />, color: "bg-chart-3/20 text-chart-3 border-chart-3/30" },
  ror_issued:        { label: "ROR Issued",       icon: <FileText className="h-3.5 w-3.5" />,      color: "bg-warning/20 text-warning border-warning/30" },
};

const getEventMeta = (type: string) =>
  EVENT_TYPE_META[type] || { label: type.replace(/_/g, " "), icon: <Clock className="h-3.5 w-3.5" />, color: "bg-muted text-muted-foreground border-border" };

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
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ summary: "", event_type: "", occurred_at: "" });
  const { toast } = useToast();

  const loadEvents = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch from edge function which aggregates all sources
      const { data, error } = await supabase.functions.invoke("get-claim-timeline", {
        body: { claimId },
      });
      if (error) throw error;

      // Also fetch manual events from claim_events directly
      const { data: manualEvents } = await supabase
        .from("claim_events")
        .select("id, event_type, occurred_at, summary, actor, source_artifact_id, source_artifact_type, metadata_json, date_source, is_manual, is_editable")
        .eq("claim_id", claimId)
        .eq("is_manual", true)
        .order("occurred_at", { ascending: false });

      const merged: TimelineEvent[] = [...(data?.events || [])];
      // Add manual events not already in the timeline
      const existingIds = new Set(merged.map((e: TimelineEvent) => e.id));
      manualEvents?.forEach((e: any) => {
        if (!existingIds.has(e.id)) {
          merged.push({ ...e, is_manual: true, is_editable: true });
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

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Subscribe to real-time changes
  useEffect(() => {
    const channel = supabase
      .channel(`timeline-${claimId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_events", filter: `claim_id=eq.${claimId}` }, () => loadEvents())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "claim_files", filter: `claim_id=eq.${claimId}` }, () => loadEvents())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [claimId, loadEvents]);

  const filteredEvents = events.filter((e) => {
    if (filterType !== "all" && e.event_type !== filterType) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        (e.summary?.toLowerCase().includes(q)) ||
        e.event_type.toLowerCase().includes(q) ||
        (e.actor?.toLowerCase().includes(q))
      );
    }
    return true;
  });

  // Group by date
  const grouped = filteredEvents.reduce<Record<string, TimelineEvent[]>>((acc, e) => {
    const day = e.occurred_at?.split("T")[0] || "Unknown";
    (acc[day] = acc[day] || []).push(e);
    return acc;
  }, {});
  const sortedDates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

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
    setEditForm({
      summary: e.summary || "",
      event_type: e.event_type,
      occurred_at: e.occurred_at?.split("T")[0] || "",
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search events..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-7 text-xs"
          />
        </div>
        <Select value={filterType} onValueChange={setFilterType}>
          <SelectTrigger className="h-8 w-[140px] text-xs">
            <Filter className="h-3 w-3 mr-1" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {EVENT_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="text-xs capitalize">
                {getEventMeta(t).label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AddEventDialog open={showAddDialog} onOpenChange={setShowAddDialog} onSubmit={handleAddEvent} />
      </div>

      <div className="text-[10px] text-muted-foreground">
        {filteredEvents.length} events • {sortedDates.length} dates
      </div>

      {/* Timeline */}
      <ScrollArea className="h-[500px]">
        <div className="space-y-4">
          {sortedDates.map((date) => (
            <div key={date}>
              <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm py-1 mb-2">
                <Badge variant="outline" className="text-[10px] font-medium">
                  {date !== "Unknown" ? format(parseISO(date), "EEEE, MMMM d, yyyy") : "Unknown Date"}
                </Badge>
              </div>
              <div className="space-y-1.5 pl-3 border-l-2 border-border ml-2">
                {grouped[date].map((event) => {
                  const meta = getEventMeta(event.event_type);
                  const isEditing = editingId === event.id;

                  return (
                    <div key={event.id} className="relative group">
                      {/* Dot on timeline */}
                      <div className="absolute -left-[calc(0.75rem+1.5px)] top-2.5 w-2.5 h-2.5 rounded-full border-2 border-background bg-primary" />

                      {isEditing ? (
                        <div className="p-2.5 rounded-lg border border-primary bg-primary/5 space-y-2">
                          <div className="flex gap-2">
                            <Input
                              value={editForm.occurred_at}
                              onChange={(e) => setEditForm((f) => ({ ...f, occurred_at: e.target.value }))}
                              type="date"
                              className="h-7 text-xs w-[140px]"
                            />
                            <Select value={editForm.event_type} onValueChange={(v) => setEditForm((f) => ({ ...f, event_type: v }))}>
                              <SelectTrigger className="h-7 text-xs flex-1">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {EVENT_TYPES.map((t) => (
                                  <SelectItem key={t} value={t} className="text-xs">{getEventMeta(t).label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <Input
                            value={editForm.summary}
                            onChange={(e) => setEditForm((f) => ({ ...f, summary: e.target.value }))}
                            placeholder="Event summary"
                            className="h-7 text-xs"
                          />
                          <div className="flex gap-1">
                            <Button size="sm" className="h-6 text-[10px]" onClick={handleSaveEdit}>
                              <Save className="h-3 w-3 mr-1" /> Save
                            </Button>
                            <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setEditingId(null)}>
                              <X className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="p-2 rounded-lg border border-border hover:bg-accent/30 transition-colors">
                          <div className="flex items-start gap-2">
                            <div className={cn("mt-0.5 p-1 rounded", meta.color)}>
                              {meta.icon}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Badge variant="outline" className={cn("text-[9px] border", meta.color)}>
                                  {meta.label}
                                </Badge>
                                <span className="text-[10px] text-muted-foreground">
                                  {format(parseISO(event.occurred_at), "h:mm a")}
                                </span>
                                {event.actor && (
                                  <span className="text-[10px] text-muted-foreground">• {event.actor}</span>
                                )}
                                {event.is_manual && (
                                  <Badge variant="secondary" className="text-[8px]">Manual</Badge>
                                )}
                              </div>
                              <p className="text-xs mt-0.5 leading-snug">{event.summary || "No summary"}</p>
                              {event.source_artifact_id && event.source_artifact_type && (
                                <button
                                  className="text-[10px] text-primary hover:underline flex items-center gap-0.5 mt-0.5"
                                  onClick={() => {
                                    toast({ title: "Source", description: `${event.source_artifact_type}: ${event.source_artifact_id}` });
                                  }}
                                >
                                  <ExternalLink className="h-2.5 w-2.5" />
                                  View source {event.source_artifact_type}
                                </button>
                              )}
                            </div>
                            {(event.is_manual || event.is_editable) && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => startEdit(event)}
                              >
                                <Edit2 className="h-3 w-3" />
                              </Button>
                            )}
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
  );
};

// Add Event Dialog
const AddEventDialog = ({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (form: { event_type: string; occurred_at: string; summary: string; actor: string }) => void;
}) => {
  const [form, setForm] = useState({ event_type: "communication", occurred_at: "", summary: "", actor: "" });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1">
          <Plus className="h-3 w-3" /> Add Event
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Add Timeline Event</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Event Type</Label>
            <Select value={form.event_type} onValueChange={(v) => setForm((f) => ({ ...f, event_type: v }))}>
              <SelectTrigger className="h-8 text-xs mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t} className="text-xs">{getEventMeta(t).label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Date</Label>
            <Input
              type="date"
              value={form.occurred_at}
              onChange={(e) => setForm((f) => ({ ...f, occurred_at: e.target.value }))}
              className="h-8 text-xs mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Summary</Label>
            <Textarea
              value={form.summary}
              onChange={(e) => setForm((f) => ({ ...f, summary: e.target.value }))}
              placeholder="Describe what happened..."
              className="text-xs mt-1 min-h-[60px]"
            />
          </div>
          <div>
            <Label className="text-xs">Actor (optional)</Label>
            <Input
              value={form.actor}
              onChange={(e) => setForm((f) => ({ ...f, actor: e.target.value }))}
              placeholder="Who performed this action?"
              className="h-8 text-xs mt-1"
            />
          </div>
          <Button
            size="sm"
            className="w-full"
            disabled={!form.summary || !form.occurred_at}
            onClick={() => onSubmit(form)}
          >
            Add Event
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
