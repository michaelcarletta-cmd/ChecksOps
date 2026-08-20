import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, Home, DollarSign, Clock, CheckCircle2, AlertCircle, Hammer } from "lucide-react";
import { format } from "date-fns";
import { CashJobDetail } from "./CashJobDetail";
import { CashJobForm } from "./CashJobForm";

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: any }> = {
  estimate:          { label: "Estimate",           color: "text-muted-foreground border-border bg-muted/30",              icon: Clock },
  deposit_received:  { label: "Deposit Received",   color: "text-blue-600 border-blue-500/30 bg-blue-500/10",             icon: DollarSign },
  in_progress:       { label: "In Progress",        color: "text-amber-600 border-amber-500/30 bg-amber-500/10",          icon: Hammer },
  final_payment_due: { label: "Final Payment Due",  color: "text-orange-600 border-orange-500/30 bg-orange-500/10",       icon: AlertCircle },
  paid_in_full:      { label: "Paid in Full",       color: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10",    icon: CheckCircle2 },
  cancelled:         { label: "Cancelled",          color: "text-red-600 border-red-500/30 bg-red-500/10",                icon: AlertCircle },
};

const WORK_TYPE_LABELS: Record<string, string> = {
  roof: "Roof", siding: "Siding", gutters: "Gutters", windows: "Windows",
  doors: "Doors", interior: "Interior", painting: "Painting", flooring: "Flooring",
  hvac: "HVAC", plumbing: "Plumbing", electrical: "Electrical",
  landscaping: "Landscaping", other: "Other",
};

export default function CashJobsPage() {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ["cash-jobs", tenant?.id],
    enabled: !!tenant?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cash_jobs")
        .select("*")
        .eq("tenant_id", tenant!.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const filteredJobs = jobs.filter((j: any) => {
    const matchSearch = !search ||
      j.customer_name?.toLowerCase().includes(search.toLowerCase()) ||
      j.job_name?.toLowerCase().includes(search.toLowerCase()) ||
      j.property_address?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === "all" || j.status === statusFilter;
    return matchSearch && matchStatus;
  });

  // Summary stats
  const totalRevenue = jobs
    .filter((j: any) => j.status === "paid_in_full")
    .reduce((s: number, j: any) => s + Number(j.contract_amount), 0);

  const outstanding = jobs
    .filter((j: any) => !["paid_in_full", "cancelled", "estimate"].includes(j.status))
    .reduce((s: number, j: any) => s + Number(j.balance_due ?? 0), 0);

  const activeJobs = jobs.filter((j: any) =>
    ["deposit_received", "in_progress", "final_payment_due"].includes(j.status)
  ).length;

  if (showForm) {
    return (
      <CashJobForm
        onSave={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ["cash-jobs"] });
        }}
        onCancel={() => setShowForm(false)}
      />
    );
  }

  if (selectedJobId) {
    return (
      <CashJobDetail
        jobId={selectedJobId}
        onBack={() => setSelectedJobId(null)}
      />
    );
  }

  return (
    <SettingsPageShell className="px-4">
      <SettingsHero
        title="Cash Jobs"
        description="Track non-insurance work, contract amounts, and customer payments in one place."
        badge="Direct Pay Work"
        icon={<Hammer className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Job Overview"
        accent="bg-gradient-to-r from-amber-500/60 to-amber-500/10"
        icon={<Hammer className="h-4 w-4 text-amber-500" />}
        description="Pipeline health across all cash jobs"
      >
        <div className="flex justify-end -mt-2 mb-2">
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4 mr-1" />
            New job
          </Button>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 shadow-sm backdrop-blur-sm">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <Hammer className="h-3 w-3" /> Active Jobs
            </div>
            <div className="text-2xl font-bold tracking-tight text-primary">{activeJobs}</div>
          </div>
          <div className="rounded-xl border border-border/50 bg-card/30 p-4 shadow-sm backdrop-blur-sm">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <AlertCircle className="h-3 w-3" /> Outstanding
            </div>
            <div className="text-2xl font-bold tracking-tight text-amber-500">
              ${outstanding.toLocaleString("en-US", { minimumFractionDigits: 0 })}
            </div>
          </div>
          <div className="rounded-xl border border-border/50 bg-card/30 p-4 shadow-sm backdrop-blur-sm">
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3" /> Collected
            </div>
            <div className="text-2xl font-bold tracking-tight text-emerald-500">
              ${totalRevenue.toLocaleString("en-US", { minimumFractionDigits: 0 })}
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="All Jobs"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<Home className="h-4 w-4 text-primary" />}
        description="Search, filter and open any cash job"
      >
        {/* Filters */}
        <div className="flex gap-2 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="h-8 text-sm pl-8"
              placeholder="Search customer, job, address..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 text-sm w-44"><SelectValue placeholder="All status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All status</SelectItem>
              {Object.entries(STATUS_CONFIG).map(([v, c]) => (
                <SelectItem key={v} value={v} className="text-xs">{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Job list */}
        {isLoading ? (
          <div className="text-sm text-muted-foreground text-center py-8">Loading jobs...</div>
        ) : filteredJobs.length === 0 ? (
          <div className="text-center py-12 space-y-2">
            <Hammer className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">No cash jobs yet.</p>
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add your first job
            </Button>
          </div>
        ) : (
          <div className="space-y-2">

          {filteredJobs.map((job: any) => {
            const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.estimate;
            const StatusIcon = cfg.icon;
            const pctPaid = job.contract_amount > 0
              ? Math.min(100, (job.total_paid / job.contract_amount) * 100)
              : 0;

            return (
              <Card
                key={job.id}
                className="cursor-pointer hover:bg-accent/30 transition-colors"
                onClick={() => setSelectedJobId(job.id)}
              >
                <CardContent className="pt-3 pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-sm">{job.job_name}</p>
                        <Badge variant="outline" className={`text-[10px] ${cfg.color}`}>
                          <StatusIcon className="h-2.5 w-2.5 mr-0.5" />
                          {cfg.label}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {WORK_TYPE_LABELS[job.work_type] ?? job.work_type}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <Home className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                        <p className="text-xs text-muted-foreground truncate">{job.customer_name}</p>
                        {job.property_address && (
                          <p className="text-xs text-muted-foreground truncate hidden sm:block">
                            · {job.property_address}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="font-semibold text-sm">
                        ${Number(job.contract_amount).toLocaleString("en-US", { minimumFractionDigits: 0 })}
                      </p>
                      {job.balance_due > 0 && (
                        <p className="text-xs text-amber-500">
                          ${Number(job.balance_due).toLocaleString("en-US", { minimumFractionDigits: 0 })} due
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Progress bar */}
                  {job.contract_amount > 0 && job.status !== "estimate" && (
                    <div className="mt-2">
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${
                            pctPaid >= 100 ? "bg-emerald-500" :
                            pctPaid >= 50 ? "bg-blue-500" : "bg-amber-500"
                          }`}
                          style={{ width: `${pctPaid}%` }}
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        ${Number(job.total_paid).toLocaleString("en-US", { minimumFractionDigits: 0 })} of ${Number(job.contract_amount).toLocaleString("en-US", { minimumFractionDigits: 0 })} paid ({Math.round(pctPaid)}%)
                      </p>
                    </div>
                  )}

                  {job.start_date && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Started {format(new Date(job.start_date), "MMM d, yyyy")}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
