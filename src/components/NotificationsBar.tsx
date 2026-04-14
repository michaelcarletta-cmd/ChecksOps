import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Bell, AlertCircle, Clock } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { format, differenceInDays, isPast, isFuture } from "date-fns";
import { Link } from "react-router-dom";

interface Task {
  id: string;
  title: string;
  due_date: string;
  claim_id: string;
  claim_number: string;
}

export function NotificationsBar() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTasks();
    
    // Subscribe to task changes
    const channel = supabase
      .channel('tasks-notifications')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tasks',
        },
        () => {
          fetchTasks();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchTasks = async () => {
    try {
      const today = new Date();
      const threeDaysFromNow = new Date();
      threeDaysFromNow.setDate(today.getDate() + 3);

      const { data, error } = await supabase
        .from("tasks")
        .select(`
          id,
          title,
          due_date,
          status,
          claim_id,
          claims!inner(claim_number)
        `)
        .eq("status", "pending")
        .not("due_date", "is", null)
        .lte("due_date", threeDaysFromNow.toISOString().split("T")[0])
        .order("due_date", { ascending: true });

      if (error) throw error;

      const tasksWithClaimNumber = data?.map((task: any) => ({
        id: task.id,
        title: task.title,
        due_date: task.due_date,
        claim_id: task.claim_id,
        claim_number: task.claims.claim_number,
      })) || [];

      // Guard: log if backend returned completed tasks (stale read)
      const stale = tasksWithClaimNumber.filter((t: any) => {
        const orig = data?.find((d: any) => d.id === t.id);
        return orig && orig.status === 'completed';
      });
      if (stale.length > 0) {
        console.error('[NotificationsBar] Backend returned completed tasks as pending — stale read detected:', stale.map((s: any) => s.id));
      }

      setTasks(tasksWithClaimNumber);
    } catch (error: any) {
      console.error("Error fetching tasks:", error);
    } finally {
      setLoading(false);
    }
  };

  const overdueTask = tasks.filter((task) => isPast(new Date(task.due_date)));
  const dueSoonTasks = tasks.filter(
    (task) => isFuture(new Date(task.due_date)) || differenceInDays(new Date(task.due_date), new Date()) === 0
  );

  if (loading || tasks.length === 0) return null;

  return (
    <div className="mb-6 space-y-3">
      {overdueTask.length > 0 && (
        <Alert className="border-red-500 bg-red-50 dark:bg-red-950/20">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
          <AlertDescription className="text-red-800 dark:text-red-300">
            <div className="flex items-center gap-2 mb-2">
              <strong className="font-semibold">
                {overdueTask.length} Overdue Task{overdueTask.length > 1 ? "s" : ""}
              </strong>
            </div>
            <div className="space-y-1">
              {overdueTask.map((task) => (
                <Link
                  key={task.id}
                  to={`/claims/${task.claim_id}`}
                  className="block text-sm hover:underline"
                >
                  • {task.title} ({task.claim_number}) - Due{" "}
                  {format(new Date(task.due_date), "MMM d, yyyy")}
                </Link>
              ))}
            </div>
          </AlertDescription>
        </Alert>
      )}

      {dueSoonTasks.length > 0 && (
        <Alert className="border-amber-500 bg-amber-50 dark:bg-amber-950/20">
          <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <AlertDescription className="text-amber-800 dark:text-amber-300">
            <div className="flex items-center gap-2 mb-2">
              <strong className="font-semibold">
                {dueSoonTasks.length} Task{dueSoonTasks.length > 1 ? "s" : ""} Due Soon
              </strong>
            </div>
            <div className="space-y-1">
              {dueSoonTasks.map((task) => {
                const daysUntilDue = differenceInDays(new Date(task.due_date), new Date());
                return (
                  <Link
                    key={task.id}
                    to={`/claims/${task.claim_id}`}
                    className="block text-sm hover:underline"
                  >
                    • {task.title} ({task.claim_number}) - Due in{" "}
                    {daysUntilDue === 0 ? "today" : `${daysUntilDue} day${daysUntilDue > 1 ? "s" : ""}`}
                  </Link>
                );
              })}
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
