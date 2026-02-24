import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  Clock, 
  CheckCircle2, 
  AlertTriangle, 
  Calendar, 
  Sparkles, 
  Loader2,
  FileText,
  Mail,
  Camera,
  ClipboardCheck,
  DollarSign,
  ArrowRight,
  MessageSquare,
  UploadCloud,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { format, differenceInDays } from "date-fns";

interface ClaimTimelineProps {
  claimId: string;
  claim?: any;
}

interface Milestone {
  id: string;
  title: string;
  description: string;
  date: string | null;
  status: "completed" | "pending" | "upcoming" | "overdue";
  type: "inspection" | "document" | "communication" | "payment" | "task" | "milestone";
  icon: any;
}

interface AIInsight {
  nextStep: string;
  priority: "high" | "medium" | "low";
  reasoning: string;
  deadline?: string;
}

export const ClaimTimeline = ({ claimId, claim }: ClaimTimelineProps) => {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [aiInsights, setAiInsights] = useState<AIInsight | null>(null);
  const [loading, setLoading] = useState(true);
  const [generatingInsights, setGeneratingInsights] = useState(false);
  const [claimData, setClaimData] = useState<any>(claim);
  const refreshDebounceRef = useRef<number | null>(null);

  const fetchTimelineData = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch claim if not provided
      let currentClaim = claim;
      if (!currentClaim) {
        const { data } = await supabase
          .from("claims")
          .select("*")
          .eq("id", claimId)
          .single();
        currentClaim = data;
        setClaimData(data);
      }

      // Fetch all relevant data in parallel
      const [
        { data: tasks },
        { data: inspections },
        { data: emails },
        { data: checks },
        { data: updates },
        { data: files },
        { data: analyses },
        { data: aiEvents },
      ] = await Promise.all([
        supabase.from("tasks").select("*").eq("claim_id", claimId).order("due_date"),
        supabase.from("inspections").select("*").eq("claim_id", claimId).order("inspection_date"),
        supabase.from("emails").select("*").eq("claim_id", claimId).order("sent_at", { ascending: false }).limit(5),
        supabase.from("claim_checks").select("*").eq("claim_id", claimId).order("check_date"),
        supabase.from("claim_updates").select("id, content, update_type, created_at").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(10),
        supabase.from("claim_files").select("id, file_name, uploaded_at").eq("claim_id", claimId).order("uploaded_at", { ascending: false }).limit(10),
        supabase.from("darwin_analysis_results").select("id, analysis_type, input_summary, created_at").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(10),
        supabase.from("claim_events").select("id, event_type, summary, occurred_at").eq("claim_id", claimId).order("occurred_at", { ascending: false }).limit(12),
      ]);

      const timelineItems: Milestone[] = [];
      const today = new Date();

      // Add claim creation milestone
      if (currentClaim) {
        timelineItems.push({
          id: "claim-created",
          title: "Claim Created",
          description: `Claim ${currentClaim.claim_number || "opened"} for ${currentClaim.loss_type || "property damage"}`,
          date: currentClaim.created_at,
          status: "completed",
          type: "milestone",
          icon: FileText,
        });

        // Add loss date milestone
        if (currentClaim.loss_date) {
          timelineItems.push({
            id: "loss-date",
            title: "Date of Loss",
            description: `${currentClaim.loss_type || "Damage"} occurred at property`,
            date: currentClaim.loss_date,
            status: "completed",
            type: "milestone",
            icon: AlertTriangle,
          });
        }
      }

      // Add inspections
      inspections?.forEach((insp) => {
        const inspDate = new Date(insp.inspection_date);
        let status: Milestone["status"] = "pending";
        if (insp.status === "completed") status = "completed";
        else if (inspDate < today) status = "overdue";
        else if (differenceInDays(inspDate, today) <= 7) status = "upcoming";

        timelineItems.push({
          id: `insp-${insp.id}`,
          title: `${insp.inspection_type || "Inspection"} ${insp.status === "completed" ? "Completed" : "Scheduled"}`,
          description: insp.inspector_name ? `Inspector: ${insp.inspector_name}` : "Property inspection",
          date: insp.inspection_date,
          status,
          type: "inspection",
          icon: Camera,
        });
      });

      // Add tasks
      tasks?.forEach((task) => {
        let status: Milestone["status"] = "pending";
        if (task.status === "completed") status = "completed";
        else if (task.due_date && new Date(task.due_date) < today) status = "overdue";
        else if (task.due_date && differenceInDays(new Date(task.due_date), today) <= 3) status = "upcoming";

        timelineItems.push({
          id: `task-${task.id}`,
          title: task.title,
          description: task.description || "Task pending",
          date: task.due_date || task.created_at,
          status,
          type: "task",
          icon: ClipboardCheck,
        });
      });

      // Add checks received
      checks?.forEach((check) => {
        timelineItems.push({
          id: `check-${check.id}`,
          title: `Check Received: $${Number(check.amount).toLocaleString()}`,
          description: `${check.check_type} - ${check.check_number || "No check number"}`,
          date: check.received_date || check.check_date,
          status: "completed",
          type: "payment",
          icon: DollarSign,
        });
      });

      // Add recent emails
      emails?.slice(0, 3).forEach((email) => {
        timelineItems.push({
          id: `email-${email.id}`,
          title: `Email: ${email.subject}`,
          description: `To: ${email.recipient_name || email.recipient_email}`,
          date: email.sent_at,
          status: "completed",
          type: "communication",
          icon: Mail,
        });
      });

      // Add recent claim notes/messages
      updates?.slice(0, 6).forEach((update) => {
        timelineItems.push({
          id: `update-${update.id}`,
          title: `Claim Note (${update.update_type || "update"})`,
          description: String(update.content || "").substring(0, 120),
          date: update.created_at,
          status: "completed",
          type: "communication",
          icon: MessageSquare,
        });
      });

      // Add file uploads
      files?.slice(0, 6).forEach((f) => {
        timelineItems.push({
          id: `upload-${f.id}`,
          title: "File Uploaded",
          description: f.file_name || "Claim file",
          date: f.uploaded_at,
          status: "completed",
          type: "document",
          icon: UploadCloud,
        });
      });

      // Add AI-detected/derived claim events
      aiEvents?.forEach((evt) => {
        timelineItems.push({
          id: `event-${evt.id}`,
          title: `AI Event: ${String(evt.event_type || "timeline_event").replace(/_/g, " ")}`,
          description: evt.summary || "Timeline event extracted from claim evidence",
          date: evt.occurred_at,
          status: "completed",
          type: "milestone",
          icon: Sparkles,
        });
      });

      // Add AI analyses performed on the claim
      analyses?.slice(0, 6).forEach((analysisRow) => {
        timelineItems.push({
          id: `ai-${analysisRow.id}`,
          title: `Darwin Analysis: ${String(analysisRow.analysis_type || "analysis").replace(/_/g, " ")}`,
          description: analysisRow.input_summary || "AI analysis generated",
          date: analysisRow.created_at,
          status: "completed",
          type: "milestone",
          icon: Sparkles,
        });
      });

      // Sort by date
      timelineItems.sort((a, b) => {
        if (!a.date) return 1;
        if (!b.date) return -1;
        return new Date(b.date).getTime() - new Date(a.date).getTime();
      });

      setMilestones(timelineItems);
    } catch (error) {
      console.error("Error fetching timeline data:", error);
    } finally {
      setLoading(false);
    }
  }, [
    claimId,
    claim?.id,
    claim?.claim_number,
    claim?.loss_type,
    claim?.loss_date,
    claim?.status,
    claim?.created_at,
  ]);

  useEffect(() => {
    fetchTimelineData();
  }, [fetchTimelineData]);

  useEffect(() => {
    const scheduleRefresh = () => {
      if (refreshDebounceRef.current) {
        window.clearTimeout(refreshDebounceRef.current);
      }
      refreshDebounceRef.current = window.setTimeout(() => {
        fetchTimelineData();
      }, 500);
    };

    const channel = supabase
      .channel(`claim-story-${claimId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_updates", filter: `claim_id=eq.${claimId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_files", filter: `claim_id=eq.${claimId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "inspections", filter: `claim_id=eq.${claimId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "emails", filter: `claim_id=eq.${claimId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_checks", filter: `claim_id=eq.${claimId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "darwin_analysis_results", filter: `claim_id=eq.${claimId}` }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "claim_events", filter: `claim_id=eq.${claimId}` }, scheduleRefresh)
      .subscribe();

    return () => {
      if (refreshDebounceRef.current) {
        window.clearTimeout(refreshDebounceRef.current);
        refreshDebounceRef.current = null;
      }
      supabase.removeChannel(channel);
    };
  }, [claimId, fetchTimelineData]);

  const generateAIInsights = async () => {
    setGeneratingInsights(true);
    try {
      const pendingTasks = milestones.filter(m => m.status === "pending" || m.status === "overdue");
      const completedTasks = milestones.filter(m => m.status === "completed");
      
      const { data, error } = await supabase.functions.invoke("claims-ai-assistant", {
        body: {
          question: `Analyze this insurance claim timeline and suggest the most important next step.

Claim Details:
- Claim Number: ${claimData?.claim_number || "Unknown"}
- Loss Type: ${claimData?.loss_type || "Unknown"}
- Loss Date: ${claimData?.loss_date || "Unknown"}
- Status: ${claimData?.status || "Unknown"}
- Days Since Loss: ${claimData?.loss_date ? differenceInDays(new Date(), new Date(claimData.loss_date)) : "Unknown"}

Completed Activities (${completedTasks.length}):
${completedTasks.slice(0, 5).map(t => `- ${t.title}`).join("\n")}

Pending Items (${pendingTasks.length}):
${pendingTasks.map(t => `- ${t.title} (${t.status})`).join("\n")}

Based on typical claim workflows and best practices, what is the single most important next action to take?

Respond with JSON format:
{
  "nextStep": "Brief action description",
  "priority": "high/medium/low",
  "reasoning": "Why this step matters",
  "deadline": "Suggested deadline if applicable"
}`,
          mode: "general",
          messages: [],
        },
      });

      if (error) throw error;

      try {
        const jsonMatch = data.answer.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const insights = JSON.parse(jsonMatch[0]);
          setAiInsights(insights);
        } else {
          setAiInsights({
            nextStep: data.answer.substring(0, 200),
            priority: "medium",
            reasoning: "AI analysis completed",
          });
        }
      } catch {
        setAiInsights({
          nextStep: data.answer.substring(0, 200),
          priority: "medium",
          reasoning: "Review AI recommendation above",
        });
      }

      toast.success("AI insights generated");
    } catch (error: any) {
      console.error("Error generating insights:", error);
      toast.error(error.message || "Failed to generate AI insights");
    } finally {
      setGeneratingInsights(false);
    }
  };

  const getStatusColor = (status: Milestone["status"]) => {
    switch (status) {
      case "completed": return "text-success bg-success/20";
      case "overdue": return "text-destructive bg-destructive/20";
      case "upcoming": return "text-warning bg-warning/20";
      default: return "text-primary bg-primary/20";
    }
  };

  const getStatusIcon = (status: Milestone["status"]) => {
    switch (status) {
      case "completed": return <CheckCircle2 className="h-4 w-4 text-success" />;
      case "overdue": return <AlertTriangle className="h-4 w-4 text-destructive" />;
      case "upcoming": return <Clock className="h-4 w-4 text-warning" />;
      default: return <Clock className="h-4 w-4 text-primary" />;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const overdueCount = milestones.filter(m => m.status === "overdue").length;
  const upcomingCount = milestones.filter(m => m.status === "upcoming").length;
  const completedCount = milestones.filter(m => m.status === "completed").length;
  const pendingCount = milestones.filter(m => m.status === "pending").length;

  return (
    <div className="space-y-4">
      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-2">
        <div className="flex items-center gap-2 p-2 rounded-md bg-success/10 border border-success/20">
          <CheckCircle2 className="h-4 w-4 text-success" />
          <span className="text-sm font-medium text-foreground">{completedCount} Done</span>
        </div>
        <div className="flex items-center gap-2 p-2 rounded-md bg-primary/10 border border-primary/20">
          <Clock className="h-4 w-4 text-primary" />
          <span className="text-sm font-medium text-foreground">{pendingCount} Pending</span>
        </div>
        <div className="flex items-center gap-2 p-2 rounded-md bg-warning/10 border border-warning/20">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <span className="text-sm font-medium text-foreground">{upcomingCount} Soon</span>
        </div>
        <div className="flex items-center gap-2 p-2 rounded-md bg-destructive/10 border border-destructive/20">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <span className="text-sm font-medium text-foreground">{overdueCount} Overdue</span>
        </div>
      </div>

      {/* AI Insights */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              AI Next Step
            </CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={generateAIInsights}
              disabled={generatingInsights}
              className="h-7 gap-1 text-xs"
            >
              {generatingInsights ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              {aiInsights ? "Refresh" : "Analyze"}
            </Button>
          </div>
        </CardHeader>
        {aiInsights && (
          <CardContent className="pt-0">
            <div className="bg-primary/5 rounded-md p-3">
              <div className="flex items-start gap-2">
                <ArrowRight className="h-4 w-4 text-primary mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{aiInsights.nextStep}</span>
                    <Badge variant={
                      aiInsights.priority === "high" ? "destructive" : 
                      aiInsights.priority === "medium" ? "default" : "secondary"
                    } className="text-xs">
                      {aiInsights.priority}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{aiInsights.reasoning}</p>
                  {aiInsights.deadline && (
                    <p className="text-xs text-muted-foreground mt-1">
                      <Calendar className="h-3 w-3 inline mr-1" />
                      {aiInsights.deadline}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Timeline */}
      <ScrollArea className="h-[300px]">
        <div className="relative pl-6">
          <div className="absolute left-2 top-0 bottom-0 w-0.5 bg-border" />
          
          <div className="space-y-3">
            {milestones.slice(0, 15).map((milestone) => {
              const IconComponent = milestone.icon;
              return (
                <div key={milestone.id} className="relative">
                  <div className={`absolute -left-4 w-4 h-4 rounded-full flex items-center justify-center ${getStatusColor(milestone.status)}`}>
                    <IconComponent className="h-2.5 w-2.5" />
                  </div>
                  
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1">
                        <span className="font-medium text-sm truncate">{milestone.title}</span>
                        {getStatusIcon(milestone.status)}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {milestone.description}
                      </p>
                    </div>
                    {milestone.date && (
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {format(new Date(milestone.date), "MMM d")}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
};
