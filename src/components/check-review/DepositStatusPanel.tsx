import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Hourglass } from "lucide-react";
import { format } from "date-fns";

interface DepositStatusPanelProps {
  checkId: string;
  depositedAt: string | null;
  depositedByTenantId: string | null;
  lastUpdated?: string | null;
}

export function DepositStatusPanel({ checkId, depositedAt, depositedByTenantId, lastUpdated }: DepositStatusPanelProps) {
  const { data: tenant, isLoading } = useQuery({
    queryKey: ["deposit-tenant", depositedByTenantId],
    enabled: !!depositedByTenantId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select("name, partner_code")
        .eq("id", depositedByTenantId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const isDeposited = !!depositedAt;

  return (
    <div
      className={
        "rounded-md border-l-4 px-3 py-2.5 text-sm transition-colors " +
        (isDeposited
          ? "bg-green-50 border-green-500 dark:bg-green-950/20"
          : "bg-slate-50 border-slate-300 dark:bg-slate-900/30 dark:border-slate-700")
      }
      data-checkid={checkId}
    >
      <div className="flex items-center gap-2 font-medium">
        {isDeposited ? (
          <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
        ) : (
          <Hourglass className="h-4 w-4 text-slate-500 shrink-0" />
        )}
        <span className={isDeposited ? "text-green-800 dark:text-green-300" : "text-slate-700 dark:text-slate-300"}>
          Deposit Status
        </span>
      </div>
      <div className="mt-1 pl-6 flex flex-col gap-0.5 text-xs">
        {isDeposited ? (
          <>
            <span className="text-green-700 dark:text-green-400">
              Deposited on {format(new Date(depositedAt!), "MMM d, yyyy 'at' h:mm a")}
            </span>
            <span className="text-slate-600 dark:text-slate-400">
              Deposited by:{" "}
              {isLoading
                ? "…"
                : tenant
                ? `${tenant.name} (${tenant.partner_code})`
                : "Unknown organization"}
            </span>
          </>
        ) : (
          <>
            <span className="text-slate-600 dark:text-slate-400">⏳ Not yet deposited</span>
            {lastUpdated && (
              <span className="text-slate-500 dark:text-slate-500">
                Last updated: {format(new Date(lastUpdated), "MMM d, h:mm a")}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
