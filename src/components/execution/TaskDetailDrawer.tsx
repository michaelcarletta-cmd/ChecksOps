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
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import {
  ExecutionTask,
  getTaskActivityEvents,
  computeGravityScore,
  markTaskImmediate,
  downgradeImmediateTask,
  snoozeImmediateTask,
  isTaskSnoozed,
} from "@/services/taskExecutionService";
import { format } from "date-fns";
import { AlarmClock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Zap } from "lucide-react";

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
  marked_immediate: "⚡ Marked Immediate",
  snoozed: "😴 Snoozed",
  escalation_sent: "🔺 Escalation Sent",
  acknowledged: "✓ Acknowledged",
  override_started: "⚡ Override Started",
  downgraded_from_immediate: "↓ Downgraded",
  deadline_breached: "🚨 Deadline Breached",
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

  // Immediate task fields
  const [urgentReason, setUrgentReason] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [countdownEnabled, setCountdownEnabled] = useState(false);
  const [notificationStrategy, setNotificationStrategy] = useState("standard");
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [snoozeAllowed, setSnoozeAllowed] = useState(true);
  const [maxSnoozeCount, setMaxSnoozeCount] = useState(2);

  const isImmediate = task?.immediate_enabled || task?.priority_level === 'immediate';

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description || "");
      setDoneDefinition(task.done_definition || "");
      setPriorityLevel(task.priority_level || "medium");
      setUrgencyScore(task.urgency_score || 0);
      setImpactScore(task.impact_score || 0);
      setBlockedReason(task.blocked_reason || "");
      setUrgentReason(task.urgent_reason || "");
      setDueAt(task.due_at ? task.due_at.slice(0, 16) : "");
      setCountdownEnabled(task.countdown_enabled || false);
      setNotificationStrategy(task.notification_strategy || "standard");
      setSmsEnabled(task.sms_enabled || false);
      setEmailEnabled(task.email_enabled || false);
      setSnoozeAllowed(task.snooze_allowed ?? true);
      setMaxSnoozeCount(task.max_snooze_count || 2);
      getTaskActivityEvents(task.id).then(setEvents).catch(() => {});
    }
  }, [task]);

  const handleMarkImmediate = async () => {
    if (!task) return;
    setSaving(true);
    const result = await markTaskImmediate(task.id, {
      urgent_reason: urgentReason || undefined,
      due_at: dueAt ? new Date(dueAt).toISOString() : undefined,
      countdown_enabled: countdownEnabled,
      sms_enabled: smsEnabled,
      email_enabled: emailEnabled,
    });
    setSaving(false);
    if (result.success) {
      toast({ title: "⚡ Task marked as immediate" });
      onRefetch();
      onClose();
    } else {
      toast({ title: "Error", description: result.error, variant: "destructive" });
    }
  };

  const handleDowngrade = async () => {
    if (!task) return;
    setSaving(true);
    const result = await downgradeImmediateTask(task.id, 'critical');
    setSaving(false);
    if (result.success) {
      toast({ title: "Task downgraded from immediate" });
      onRefetch();
      onClose();
    } else {
      toast({ title: "Error", description: result.error, variant: "destructive" });
    }
  };

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
        priority: priorityLevel === 'critical' || priorityLevel === 'immediate' ? 'high' : priorityLevel,
        urgency_score: urgencyScore,
        impact_score: impactScore,
        gravity_score: gravity,
        blocked_reason: blockedReason || null,
        urgent_reason: urgentReason || null,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        countdown_enabled: countdownEnabled,
        notification_strategy: notificationStrategy,
        sms_enabled: smsEnabled,
        email_enabled: emailEnabled,
        snooze_allowed: snoozeAllowed,
        max_snooze_count: maxSnoozeCount,
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
          <SheetTitle className="flex items-center gap-2">
            Task Details
            {isImmediate && (
              <Badge variant="destructive" className="text-[10px] gap-0.5">
                <Zap className="h-3 w-3" /> IMMEDIATE
              </Badge>
            )}
          </SheetTitle>
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
                <SelectItem value="immediate">⚡ Immediate</SelectItem>
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

          <Separator />

          {/* Immediate Task Configuration */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-destructive" />
              Urgent Interrupt Settings
            </h4>

            <div>
              <Label>Urgent Reason</Label>
              <Input
                value={urgentReason}
                onChange={(e) => setUrgentReason(e.target.value)}
                placeholder="Why is this urgent?"
              />
            </div>

            <div>
              <Label>Due At</Label>
              <Input
                type="datetime-local"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between">
              <Label>Show Countdown</Label>
              <Switch checked={countdownEnabled} onCheckedChange={setCountdownEnabled} />
            </div>

            <div>
              <Label>Notification Strategy</Label>
              <Select value={notificationStrategy} onValueChange={setNotificationStrategy}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="immediate_interrupt">Immediate Interrupt</SelectItem>
                  <SelectItem value="escalating">Escalating</SelectItem>
                  <SelectItem value="deadline_sensitive">Deadline Sensitive</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <Label>SMS Notifications</Label>
              <Switch checked={smsEnabled} onCheckedChange={setSmsEnabled} />
            </div>

            <div className="flex items-center justify-between">
              <Label>Email Notifications</Label>
              <Switch checked={emailEnabled} onCheckedChange={setEmailEnabled} />
            </div>

            <div className="flex items-center justify-between">
              <Label>Allow Snooze</Label>
              <Switch checked={snoozeAllowed} onCheckedChange={setSnoozeAllowed} />
            </div>

            {snoozeAllowed && (
              <div>
                <Label>Max Snooze Count: {maxSnoozeCount}</Label>
                <Slider value={[maxSnoozeCount]} onValueChange={([v]) => setMaxSnoozeCount(v)} min={1} max={5} step={1} />
              </div>
            )}

            {!isImmediate && task.status !== 'completed' && task.status !== 'dropped' && (
              <Button
                variant="destructive"
                onClick={handleMarkImmediate}
                disabled={saving}
                className="w-full gap-1.5"
              >
                <Zap className="h-4 w-4" />
                Mark as Immediate
              </Button>
            )}

            {isImmediate && (
              <Button
                variant="outline"
                onClick={handleDowngrade}
                disabled={saving}
                className="w-full"
              >
                Downgrade from Immediate
              </Button>
            )}
          </div>

          <Separator />

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
