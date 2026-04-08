import { useState, useEffect } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { ExecutionTask, getTaskActivityEvents, computeGravityScore } from "@/services/taskExecutionService";
import { format } from "date-fns";
import { useToast } from "@/hooks/use-toast";

interface Props {
  task: ExecutionTask | null;
  open: boolean;
  onClose: () => void;
  onRefetch: () => void;
}

const EVENT_LABELS: Record<string, string> = {
  created: "Created",
  activated: "Activated",
  started: "Started",
  paused: "Paused",
  resumed: "Resumed",
  reprioritized: "Reprioritized",
  moved_to_backlog: "Moved to Backlog",
  blocked: "Blocked",
  completed: "Completed",
  dropped: "Dropped",
  nudged: "Nudged",
  reviewed: "Reviewed",
  stale_flagged: "Flagged Stale",
  daily_reset: "Daily Reset",
};

export function TaskDetailDrawer({ task, open, onClose, onRefetch }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [doneDefinition, setDoneDefinition] = useState("");
  const [priorityLevel, setPriorityLevel] = useState("medium");
  const [urgencyScore, setUrgencyScore] = useState(0);
  const [impactScore, setImpactScore] = useState(0);
  const [blockedReason, setBlockedReason] = useState("");
  const [events, setEvents] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description || "");
      setDoneDefinition(task.done_definition || "");
      setPriorityLevel(task.priority_level || "medium");
      setUrgencyScore(task.urgency_score || 0);
      setImpactScore(task.impact_score || 0);
      setBlockedReason(task.blocked_reason || "");
      getTaskActivityEvents(task.id).then(setEvents).catch(() => {});
    }
  }, [task]);

  const handleSave = async () => {
    if (!task) return;
    setSaving(true);
    const gravity = computeGravityScore({
      priority_level: priorityLevel,
      urgency_score: urgencyScore,
      impact_score: impactScore,
      age_score: task.age_score,
      last_touched_at: task.last_touched_at,
      created_at: task.created_at,
      due_date: task.due_date,
    });

    const { error } = await supabase
      .from('tasks')
      .update({
        title,
        description: description || null,
        done_definition: doneDefinition || null,
        priority_level: priorityLevel,
        priority: priorityLevel === 'critical' ? 'high' : priorityLevel,
        urgency_score: urgencyScore,
        impact_score: impactScore,
        gravity_score: gravity,
        blocked_reason: blockedReason || null,
        last_touched_at: new Date().toISOString(),
      })
      .eq('id', task.id);

    setSaving(false);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Task updated" });
      onRefetch();
      onClose();
    }
  };

  if (!task) return null;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Task Details</SheetTitle>
        </SheetHeader>

        <div className="space-y-4 mt-4">
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          <div>
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </div>

          <div>
            <Label>Done when:</Label>
            <Input
              value={doneDefinition}
              onChange={(e) => setDoneDefinition(e.target.value)}
              placeholder="Define what 'done' looks like for this task..."
            />
          </div>

          <div>
            <Label>Priority Level</Label>
            <Select value={priorityLevel} onValueChange={setPriorityLevel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Urgency (0–25): {urgencyScore}</Label>
            <Slider value={[urgencyScore]} onValueChange={([v]) => setUrgencyScore(v)} min={0} max={25} step={1} />
          </div>

          <div>
            <Label>Impact (0–20): {impactScore}</Label>
            <Slider value={[impactScore]} onValueChange={([v]) => setImpactScore(v)} min={0} max={20} step={1} />
          </div>

          {task.status === 'blocked' && (
            <div>
              <Label>Blocked Reason</Label>
              <Textarea value={blockedReason} onChange={(e) => setBlockedReason(e.target.value)} rows={2} />
            </div>
          )}

          <Button onClick={handleSave} disabled={saving} className="w-full">
            {saving ? "Saving..." : "Save Changes"}
          </Button>

          <Separator />

          <div>
            <h4 className="text-sm font-medium mb-2">Activity Timeline</h4>
            <ScrollArea className="h-[200px]">
              {events.length === 0 ? (
                <p className="text-xs text-muted-foreground">No activity recorded</p>
              ) : (
                <div className="space-y-2">
                  {events.map((event) => (
                    <div key={event.id} className="flex items-center gap-2 text-xs">
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {EVENT_LABELS[event.event_type] || event.event_type}
                      </Badge>
                      <span className="text-muted-foreground">
                        {format(new Date(event.created_at), "MMM d, h:mm a")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
