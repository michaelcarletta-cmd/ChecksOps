import { useEffect, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, X, SearchX, Plus, Flame, Clock, ExternalLink } from "lucide-react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { activateTask } from "@/services/taskExecutionService";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";
import { Link } from "react-router-dom";

type SearchableTask = {
  id: string;
  title: string;
  description: string | null;
  claim_id: string | null;
  claim_number?: string;
  policyholder_name?: string;
  assigned_to: string | null;
  assigned_name?: string | null;
  status: string;
  priority_level: string;
  priority: string | null;
  gravity_score: number;
  last_touched_at: string | null;
  category?: string | null;
};

const priorityColors: Record<string, string> = {
  critical: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  high: "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-red-500/30",
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

const SEARCH_STORAGE_KEY = "tasks-search-term";

export function TaskSearchPanel({ onQueueUpdated }: TaskSearchPanelProps) {
  const [search, setSearch] = useState(() => window.localStorage.getItem(SEARCH_STORAGE_KEY) ?? "");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 200);
  const { toast } = useToast();

  useEffect(() => {
    window.localStorage.setItem(SEARCH_STORAGE_KEY, search);
  }, [search]);

  const { data: allTasks = [], isLoading } = useQuery({
    queryKey: ["all-searchable-tasks"],
    queryFn: async (): Promise<SearchableTask[]> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];

      const { data: tasks, error } = await supabase
        .from("tasks")
        .select("*, claims(claim_number, policyholder_name)")
        .or(`assigned_to.eq.${user.id},assigned_to.is.null`)
        .not("status", "eq", "completed")
        .order("gravity_score", { ascending: false });

      if (error) {
        console.error("Task search query error:", error);
        return [];
      }

      const assignedIds = Array.from(
        new Set((tasks || []).map((task: any) => task.assigned_to).filter(Boolean))
      ) as string[];

      let assigneeMap = new Map<string, string>();
      if (assignedIds.length > 0) {
        const { data: profiles, error: profilesError } = await supabase
          .from("profiles")
          .select("id, full_name")
          .in("id", assignedIds);

        if (profilesError) {
          console.error("Task assignee lookup error:", profilesError);
        } else {
          assigneeMap = new Map((profiles || []).map((profile: any) => [profile.id, profile.full_name ?? ""]));
        }
      }

      const mapped = (tasks || []).map((task: any) => ({
        ...task,
        claim_number: task.claims?.claim_number ?? "",
        policyholder_name: task.claims?.policyholder_name ?? "",
        assigned_name: task.assigned_to ? assigneeMap.get(task.assigned_to) ?? "" : "",
        category: task.category ?? task.priority ?? "",
      }));

      console.log("Task search loaded", {
        taskCount: mapped.length,
        sample: mapped.slice(0, 3).map((task) => ({
          id: task.id,
          title: task.title,
          claim_number: task.claim_number,
          description: task.description,
          category: task.category,
          assigned_name: task.assigned_name,
        })),
      });

      return mapped;
    },
  });

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return allTasks;

    return allTasks.filter((task) => {
      const fields = [
        task.claim_number,
        task.title,
        task.description,
        task.category,
        task.assigned_name,
        task.policyholder_name,
      ];

      return fields.some((value) => (value ?? "").toString().toLowerCase().includes(q));
    });
  }, [allTasks, debouncedSearch]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAddToQueue = async () => {
    if (selectedIds.size === 0) return;

    setAdding(true);
    const totalSelected = selectedIds.size;
    let added = 0;
    let lastError = "";

    for (const id of selectedIds) {
      const result = await activateTask(id);
      if (result.success) added += 1;
      else lastError = result.error || "Unknown error";
    }

    setAdding(false);
    setSelectedIds(new Set());

    if (added > 0) {
      toast({ title: `${added} task${added > 1 ? "s" : ""} added to queue` });
      onQueueUpdated();
    }

    if (lastError && added < totalSelected) {
      toast({ title: "Some tasks couldn't be added", description: lastError, variant: "destructive" });
    }
  };

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
            type="button"
            onClick={() => {
              setSearch("");
              setSelectedIds(new Set());
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
          <SearchX className="mb-2 h-10 w-10 opacity-50" />
          <p className="text-sm">No tasks match "{debouncedSearch.trim() || search.trim()}"</p>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {filtered.map((task) => (
              <Card
                key={task.id}
                className={`p-3 transition-all hover:shadow-md ${selectedIds.has(task.id) ? "border-primary ring-1 ring-primary/20" : ""}`}
              >
                <div className="flex items-start gap-3">
                  <div className="pt-0.5" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selectedIds.has(task.id)} onCheckedChange={() => toggleSelect(task.id)} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <h4 className="truncate text-sm font-medium text-foreground">{task.title}</h4>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      {task.claim_number && (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                          {task.claim_number}
                        </Badge>
                      )}
                      <Badge className={`border px-1.5 py-0 text-[10px] ${priorityColors[task.priority_level] || priorityColors.medium}`}>
                        {task.category || task.priority_level}
                      </Badge>
                      {task.gravity_score > 0 && (
                        <span className={`flex items-center gap-0.5 ${gravityColor(task.gravity_score)}`}>
                          <Flame className="h-3 w-3" />
                          {task.gravity_score}
                        </span>
                      )}
                      {task.last_touched_at && (
                        <span className="flex items-center gap-0.5 text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatDistanceToNow(new Date(task.last_touched_at), { addSuffix: true })}
                        </span>
                      )}
                      {task.assigned_name && (
                        <span className="truncate text-muted-foreground max-w-[140px]">{task.assigned_name}</span>
                      )}
                    </div>
                    {task.description && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{task.description}</p>}
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

          {selectedIds.size > 0 && (
            <div className="flex items-center justify-between border-t border-border pt-2">
              <span className="text-sm text-muted-foreground">
                {selectedIds.size} of {filtered.length} selected
              </span>
              <Button onClick={handleAddToQueue} disabled={adding} size="sm">
                <Plus className="mr-1 h-4 w-4" />
                {adding ? "Adding..." : "Add to Queue"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

