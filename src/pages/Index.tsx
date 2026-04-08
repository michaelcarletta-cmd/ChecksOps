import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FileText, DollarSign, ListTodo, TrendingUp } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatDistanceToNow, startOfMonth, endOfMonth } from "date-fns";
import { useNavigate } from "react-router-dom";
import { DashboardCalendar } from "@/components/dashboard/DashboardCalendar";
import { DashboardNotepad } from "@/components/dashboard/DashboardNotepad";
import { useRenderCount } from "@/hooks/useRenderCount";
import { ExecutionQueuePanel } from "@/components/execution/ExecutionQueuePanel";
import { DailyExecutionResetModal } from "@/components/execution/DailyExecutionResetModal";

const Index = () => {
  useRenderCount("DashboardIndex");
  const navigate = useNavigate();
  const now = new Date();
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);

  const { data: claims } = useQuery({
    queryKey: ["dashboard-claims"],
    queryFn: async () => {
      const start = performance.now();
      const { data, error } = await supabase
        .from("claims")
        .select("id, claim_number, policyholder_name, status, updated_at, loss_date, created_at")
        .eq("is_closed", false)
        .order("updated_at", { ascending: false });
      console.log(`[query] dashboard-claims: ${(performance.now() - start).toFixed(2)}ms, rows: ${data?.length ?? 0}`);
      if (error) throw error;
      return data;
    },
  });

  const { data: tasks } = useQuery({
    queryKey: ["dashboard-tasks"],
    queryFn: async () => {
      const start = performance.now();
      const fortyEightHoursFromNow = new Date();
      fortyEightHoursFromNow.setHours(fortyEightHoursFromNow.getHours() + 48);
      
      const { data, error } = await supabase
        .from("tasks")
        .select("id, title, due_date, status, claim_id, claims(claim_number, policyholder_name)")
        .eq("status", "pending")
        .not("due_date", "is", null)
        .lte("due_date", fortyEightHoursFromNow.toISOString())
        .order("due_date", { ascending: true });
      console.log(`[query] dashboard-tasks: ${(performance.now() - start).toFixed(2)}ms`);
      if (error) throw error;
      return data;
    },
  });

  const { data: settlements } = useQuery({
    queryKey: ["dashboard-settlements", monthStart.toISOString()],
    queryFn: async () => {
      const start = performance.now();
      const { data, error } = await supabase
        .from("claim_settlements")
        .select("replacement_cost_value, created_at");
      console.log(`[query] dashboard-settlements: ${(performance.now() - start).toFixed(2)}ms`);
      if (error) throw error;
      return data;
    },
  });

  const { data: checks } = useQuery({
    queryKey: ["dashboard-checks"],
    queryFn: async () => {
      const start = performance.now();
      const { data, error } = await supabase
        .from("claim_checks")
        .select("amount, check_date");
      console.log(`[query] dashboard-checks: ${(performance.now() - start).toFixed(2)}ms`);
      if (error) throw error;
      return data;
    },
  });

  const { data: expenses } = useQuery({
    queryKey: ["dashboard-expenses"],
    queryFn: async () => {
      const start = performance.now();
      const { data, error } = await supabase
        .from("claim_expenses")
        .select("amount, expense_date");
      console.log(`[query] dashboard-expenses: ${(performance.now() - start).toFixed(2)}ms`);
      if (error) throw error;
      return data;
    },
  });

  const { data: payments } = useQuery({
    queryKey: ["dashboard-payments"],
    queryFn: async () => {
      const start = performance.now();
      const { data, error } = await supabase
        .from("claim_payments")
        .select("amount, payment_date");
      console.log(`[query] dashboard-payments: ${(performance.now() - start).toFixed(2)}ms`);
      if (error) throw error;
      return data;
    },
  });

  const { data: fees } = useQuery({
    queryKey: ["dashboard-fees"],
    queryFn: async () => {
      const start = performance.now();
      const { data, error } = await supabase
        .from("claim_fees")
        .select("adjuster_fee_amount");
      console.log(`[query] dashboard-fees: ${(performance.now() - start).toFixed(2)}ms`);
      if (error) throw error;
      return data;
    },
  });

  // Calculations
  const activeClaims = claims?.length || 0;
  const totalTasks = tasks?.length || 0;

  // Monthly RCV
  const monthlyRCV = settlements?.reduce((sum, s) => {
    const createdAt = new Date(s.created_at);
    if (createdAt >= monthStart && createdAt <= monthEnd) {
      return sum + (s.replacement_cost_value || 0);
    }
    return sum;
  }, 0) || 0;

  // Net profit calculation (checks - expenses - payments - adjuster fees)
  const totalChecks = checks?.reduce((sum, c) => sum + (c.amount || 0), 0) || 0;
  const totalExpenses = expenses?.reduce((sum, e) => sum + (e.amount || 0), 0) || 0;
  const totalPayments = payments?.reduce((sum, p) => sum + (p.amount || 0), 0) || 0;
  const totalAdjusterFees = fees?.reduce((sum, f) => sum + (f.adjuster_fee_amount || 0), 0) || 0;
  const netProfit = totalChecks - totalExpenses - totalPayments - totalAdjusterFees;

  const formatCurrency = (amount: number) => {
    if (amount >= 1000000) {
      return `$${(amount / 1000000).toFixed(2)}M`;
    } else if (amount >= 1000) {
      return `$${(amount / 1000).toFixed(1)}K`;
    }
    return `$${amount.toLocaleString()}`;
  };

  const stats = [
    {
      title: "Active Claims",
      value: activeClaims.toString(),
      icon: FileText,
      color: "text-blue-500",
    },
    {
      title: "Pending Tasks",
      value: totalTasks.toString(),
      icon: ListTodo,
      color: "text-amber-500",
    },
    {
      title: "Monthly RCV",
      value: formatCurrency(monthlyRCV),
      icon: TrendingUp,
      color: "text-emerald-500",
    },
    {
      title: "Net Profit",
      value: formatCurrency(netProfit),
      icon: DollarSign,
      color: netProfit >= 0 ? "text-emerald-500" : "text-red-500",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Welcome back! Here's your overview</p>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat, index) => (
          <Card key={index} className="transition-all hover:shadow-lg">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.title}
              </CardTitle>
              <stat.icon className={`h-5 w-5 ${stat.color}`} />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-foreground">{stat.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Notepad and Calendar Section */}
      <div className="grid gap-6 lg:grid-cols-2">
        <DashboardNotepad />
        <DashboardCalendar />
      </div>

      {/* Tasks and Quick Stats */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Upcoming Tasks */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListTodo className="h-5 w-5" />
              Upcoming Tasks
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!tasks || tasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending tasks</p>
            ) : (
              <div className="space-y-3">
                {tasks.slice(0, 5).map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center justify-between p-3 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors"
                    onClick={() => navigate(`/claims/${task.claim_id}`)}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{task.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {(task.claims as any)?.policyholder_name || (task.claims as any)?.claim_number}
                      </p>
                    </div>
                    {task.due_date && (
                      <span className="text-xs text-muted-foreground ml-2 shrink-0">
                        {formatDistanceToNow(new Date(task.due_date), { addSuffix: true })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Financial Summary */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="h-5 w-5" />
              Financial Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between py-2 border-b">
                <span className="text-sm text-muted-foreground">Total Checks Received</span>
                <span className="font-medium">{formatCurrency(totalChecks)}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b">
                <span className="text-sm text-muted-foreground">Total Expenses</span>
                <span className="font-medium text-red-500">-{formatCurrency(totalExpenses)}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b">
                <span className="text-sm text-muted-foreground">Total Payments</span>
                <span className="font-medium text-red-500">-{formatCurrency(totalPayments)}</span>
              </div>
              <div className="flex items-center justify-between py-2 border-b">
                <span className="text-sm text-muted-foreground">Adjuster Fees</span>
                <span className="font-medium text-red-500">-{formatCurrency(totalAdjusterFees)}</span>
              </div>
              <div className="flex items-center justify-between py-2">
                <span className="text-sm font-medium">Net Profit</span>
                <span className={`font-bold text-lg ${netProfit >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {formatCurrency(netProfit)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default Index;
