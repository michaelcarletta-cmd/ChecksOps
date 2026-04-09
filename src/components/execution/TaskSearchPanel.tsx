import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, X, SearchX, Plus, Flame, Clock, ExternalLink } from "lucide-react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { ExecutionTask, activateTask, MAX_ACTIVE_TASKS, getStaleStatus } from "@/services/taskExecutionService";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { Link } from "react-router-dom";

const priorityColors: Record<string, string> = {
  critical: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  high: "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30",
  medium: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  low: "bg-muted text-muted-foreground border-border",
};

const gravityColor = (score: number) => {
  if (score >= 70) return "text-red-500";
  if (score >= 45) return "text-orange-500";
  if (score >= 20) return "text-blue-500";
  return "text-muted-foreground";
};

interface TaskSearchPanelProps {
  onQueueUpdated: () => void;
}

export function TaskSearchPanel({ onQueueUpdated }: TaskSearchPanelProps) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 250);
  const { toast } = useToast();

  const { data: allTasks = [], isLoading } = useQuery({
    queryKey: ["all-searchable-tasks"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];
      const { data, error } = await supabase
        .from("tasks")
        .select("*, claims(claim_number, policyholder_name), profiles:assigned_to(full_name)")
        .or(`assigned_to.eq.${user.id},assigned_to.is.null`)
        .not("status", "eq", "completed")
        .order("gravity_score", { ascending: false });
      if (error) {
        console.error("Task search query error:", error);
        return [];
      }
      return (data || []).map((t: any) => ({
        ...t,
        claim_number: t.claims?.claim_number,
        policyholder_name: t.claims?.policyholder_name,
        assigned_name: t.profiles?.full_name,
      }));
    },
  });

  const filtered = useMemo(() => {
    if (!debouncedSearch.trim()) return allTasks;
    const q = debouncedSearch.toLowerCase();
    return allTasks.filter((t: any) =>
      (t.claim_number && t.claim_number.toLowerCase().includes(q)) ||
      (t.title && t.title.toLowerCase().includes(q)) ||
      (t.description && t.description.toLowerCase().includes(q)) ||
      (t.priority && t.priority.toLowerCase().includes(q)) ||
      (t.priority_level && t.priority_level.toLowerCase().includes(q)) ||
      (t.assigned_name && t.assigned_name.toLowerCase().includes(q)) ||
      (t.policyholder_name && t.policyholder_name.toLowerCase().includes(q))
    );
  }, [allTasks, debouncedSearch]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAddToQueue = async () => {
    if (selectedIds.size === 0) return;
    setAdding(true);
    let added = 0;
    let lastError = "";
    for (const id of selectedIds) {
      const result = await activateTask(id);
      if (result.success) added++;
      else lastError = result.error || "Unknown error";
    }
    setAdding(false);
    setSelectedIds(new Set());
    if (added > 0) {
      toast({ title: `${added} task${added > 1 ? "s" : ""} added to queue` });
      onQueueUpdated();
    }
    if (lastError && added < selectedIds.size) {
      toast({ title: "Some tasks couldn't be added", description: lastError, variant: "destructive" });
    }
  };

  const showResults = debouncedSearch.trim().length > 0;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search tasks by claim #, description, category..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 pr-9"
        />
        {search && (
          <button
            onClick={() => { setSearch(""); setSelectedIds(new Set()); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {showResults && (
        <>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <SearchX className="h-10 w-10 mb-2 opacity-50" />
              <p className="text-sm">No tasks found for "{debouncedSearch}"</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((task: any) => (
                <Card
                  key={task.id}
                  className={`p-3 transition-all hover:shadow-md ${selectedIds.has(task.id) ? "border-primary ring-1 ring-primary/20" : ""}`}
                >
                  <div className="flex items-start gap-3">
                    <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selectedIds.has(task.id)}
                        onCheckedChange={() => toggleSelect(task.id)}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="text-sm font-medium truncate text-foreground">{task.title}</h4>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs mt-1">
                        {task.claim_number && (
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {task.claim_number}
                          </Badge>
                        )}
                        <Badge className={`text-[10px] px-1.5 py-0 border ${priorityColors[task.priority_level] || priorityColors.medium}`}>
                          {task.priority_level}
                        </Badge>
                        {task.gravity_score > 0 && (
                          <span className={`flex items-center gap-0.5 ${gravityColor(task.gravity_score)}`}>
                            <Flame className="h-3 w-3" />
                            {task.gravity_score}
                          </span>
                        )}
                        {task.last_touched_at && (
                          <span className="text-muted-foreground flex items-center gap-0.5">
                            <Clock className="h-3 w-3" />
                            {formatDistanceToNow(new Date(task.last_touched_at), { addSuffix: true })}
                          </span>
                        )}
                        {task.policyholder_name && (
                          <span className="text-muted-foreground truncate max-w-[120px]">{task.policyholder_name}</span>
                        )}
                      </div>
                      {task.description && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{task.description}</p>
                      )}
                    </div>
                    {task.claim_id && (
                      <Link to={`/claims/${task.claim_id}`} onClick={(e) => e.stopPropagation()}>
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
                          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      </Link>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}

          {selectedIds.size > 0 && (
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <span className="text-sm text-muted-foreground">
                {selectedIds.size} of {filtered.length} selected
              </span>
              <Button onClick={handleAddToQueue} disabled={adding} size="sm">
                <Plus className="h-4 w-4 mr-1" />
                {adding ? "Adding..." : "Add to Queue"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
