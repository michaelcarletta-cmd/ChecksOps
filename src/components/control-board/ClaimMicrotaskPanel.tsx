import { useState } from "react";
import { useClaimMicrotasks } from "@/hooks/useClaimMicrotasks";
import {
  ClaimMicrotask,
  MicrotaskPriority,
  MicrotaskStatus,
  PRIORITY_CONFIG,
  isOverdueMicrotask,
  isOpenMicrotask,
  summarizeMicrotasks,
} from "@/services/claimOperationsService";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  Zap,
  Ban,
  Clock,
  CheckCircle2,
  Trash2,
  Edit,
  X,
} from "lucide-react";
import { format } from "date-fns";

interface ClaimMicrotaskPanelProps {
  claimId: string;
}

export function ClaimMicrotaskPanel({ claimId }: ClaimMicrotaskPanelProps) {
  const { microtasks, loading, createMicrotask, updateMicrotask, deleteMicrotask } = useClaimMicrotasks(claimId);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ClaimMicrotask | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);

  const summary = summarizeMicrotasks(microtasks);

  const openTasks = microtasks.filter(isOpenMicrotask);
  const completedTasks = microtasks.filter(t => t.status === "done" || t.status === "cancelled");

  // Sort: blocking first, then immediate, then by due date
  const sortedOpen = [...openTasks].sort((a, b) => {
    if (a.is_blocking !== b.is_blocking) return a.is_blocking ? -1 : 1;
    const priorityOrder: Record<string, number> = { immediate: 0, high: 1, normal: 2, low: 3 };
    const pa = priorityOrder[a.priority] ?? 2;
    const pb = priorityOrder[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    if (a.due_at && b.due_at) return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
    if (a.due_at) return -1;
    if (b.due_at) return 1;
    return 0;
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold text-foreground">Microtasks</h3>
          {summary.immediateOpen > 0 && (
            <Badge variant="destructive" className="text-xs">
              <Zap className="h-3 w-3 mr-1" />{summary.immediateOpen} immediate
            </Badge>
          )}
          {summary.blockingOpen > 0 && (
            <Badge variant="outline" className="text-xs border-orange-500 text-orange-600 dark:text-orange-400">
              <Ban className="h-3 w-3 mr-1" />{summary.blockingOpen} blocking
            </Badge>
          )}
        </div>
        <MicrotaskComposer
          open={composerOpen}
          onOpenChange={setComposerOpen}
          editingTask={editingTask}
          onSubmit={(data) => {
            if (editingTask) {
              updateMicrotask.mutate({ id: editingTask.id, ...data });
            } else {
              createMicrotask.mutate(data);
            }
            setComposerOpen(false);
            setEditingTask(null);
          }}
          onCancel={() => {
            setComposerOpen(false);
            setEditingTask(null);
          }}
        />
      </div>

      {/* Task list */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : sortedOpen.length === 0 ? (
        <Card className="p-6 text-center border-border bg-card">
          <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">No open microtasks</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {sortedOpen.map(task => (
            <MicrotaskRow
              key={task.id}
              task={task}
              onComplete={() => updateMicrotask.mutate({ id: task.id, status: "done" })}
              onCancel={() => updateMicrotask.mutate({ id: task.id, status: "cancelled" })}
              onEdit={() => {
                setEditingTask(task);
                setComposerOpen(true);
              }}
              onDelete={() => deleteMicrotask.mutate(task.id)}
            />
          ))}
        </div>
      )}

      {/* Completed toggle */}
      {completedTasks.length > 0 && (
        <div>
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setShowCompleted(!showCompleted)}
          >
            {showCompleted ? "Hide" : "Show"} {completedTasks.length} completed
          </button>
          {showCompleted && (
            <div className="space-y-1 mt-2">
              {completedTasks.map(task => (
                <MicrotaskRow key={task.id} task={task} completed />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ======================== Row ========================

function MicrotaskRow({
  task,
  completed,
  onComplete,
  onCancel,
  onEdit,
  onDelete,
}: {
  task: ClaimMicrotask;
  completed?: boolean;
  onComplete?: () => void;
  onCancel?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const overdue = isOverdueMicrotask(task);
  const pConfig = PRIORITY_CONFIG[task.priority as MicrotaskPriority] || PRIORITY_CONFIG.normal;

  return (
    <Card
      className={`p-3 flex items-start gap-3 ${
        completed ? "opacity-50" : ""
      } ${task.is_blocking ? "border-orange-500/50" : ""} ${
        overdue ? "border-red-500/50" : ""
      } ${task.priority === "immediate" ? "bg-red-50/30 dark:bg-red-950/10" : ""}`}
    >
      {!completed && (
        <Checkbox
          checked={false}
          onCheckedChange={() => onComplete?.()}
          className="mt-0.5"
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-sm font-medium ${completed ? "line-through text-muted-foreground" : "text-foreground"}`}>
            {task.title}
          </span>
          <Badge variant="outline" className={`text-[10px] ${pConfig.color} ${pConfig.bgColor} border-0`}>
            {pConfig.label}
          </Badge>
          {task.is_blocking && (
            <Badge variant="outline" className="text-[10px] text-orange-500 border-orange-500/30">
              <Ban className="h-2.5 w-2.5 mr-0.5" /> Blocking
            </Badge>
          )}
          {overdue && (
            <Badge variant="destructive" className="text-[10px]">
              <Clock className="h-2.5 w-2.5 mr-0.5" /> Overdue
            </Badge>
          )}
        </div>
        {task.description && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{task.description}</p>
        )}
        {task.due_at && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Due: {format(new Date(task.due_at), "MMM d, yyyy h:mm a")}
          </p>
        )}
      </div>
      {!completed && (
        <div className="flex items-center gap-1 shrink-0">
          {onEdit && (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onEdit}>
              <Edit className="h-3 w-3" />
            </Button>
          )}
          {onCancel && (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onCancel}>
              <X className="h-3 w-3" />
            </Button>
          )}
          {onDelete && (
            <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={onDelete}>
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

// ======================== Composer ========================

interface ComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingTask: ClaimMicrotask | null;
  onSubmit: (data: {
    title: string;
    description?: string;
    task_type?: string;
    priority?: MicrotaskPriority;
    due_at?: string;
    is_blocking?: boolean;
  }) => void;
  onCancel: () => void;
}

function MicrotaskComposer({ open, onOpenChange, editingTask, onSubmit, onCancel }: ComposerProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<MicrotaskPriority>("normal");
  const [dueAt, setDueAt] = useState("");
  const [isBlocking, setIsBlocking] = useState(false);

  // Sync form when editing
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen && editingTask) {
      setTitle(editingTask.title);
      setDescription(editingTask.description || "");
      setPriority(editingTask.priority);
      setDueAt(editingTask.due_at ? editingTask.due_at.slice(0, 16) : "");
      setIsBlocking(editingTask.is_blocking);
    } else if (isOpen) {
      setTitle("");
      setDescription("");
      setPriority("normal");
      setDueAt("");
      setIsBlocking(false);
    }
    onOpenChange(isOpen);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      due_at: dueAt || undefined,
      is_blocking: isBlocking,
    });
    setTitle("");
    setDescription("");
    setPriority("normal");
    setDueAt("");
    setIsBlocking(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Add Microtask
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editingTask ? "Edit Microtask" : "New Microtask"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Title *</Label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="e.g. Call adjuster today"
              required
            />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional details..."
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={v => setPriority(v as MicrotaskPriority)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="immediate">Immediate</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Due Date</Label>
              <Input
                type="datetime-local"
                value={dueAt}
                onChange={e => setDueAt(e.target.value)}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={isBlocking} onCheckedChange={setIsBlocking} />
            <Label>Blocking — prevents claim progress</Label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit">{editingTask ? "Update" : "Create"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
