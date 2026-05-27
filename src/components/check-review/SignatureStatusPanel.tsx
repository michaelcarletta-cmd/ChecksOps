import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckCircle2, Hourglass } from "lucide-react";
import { format } from "date-fns";

interface SignatureStatusPanelProps {
  checkId: string;
}

interface EndorsementRow {
  id: string;
  payee_name: string;
  payee_type: string;
  status: string;
  signed_at: string | null;
}

const PAYEE_TYPE_LABEL: Record<string, string> = {
  insured: "Insured",
  public_adjuster: "Public Adjuster",
  mortgage_company: "Mortgage Co.",
  contractor: "Contractor",
  other: "Other",
};

export function SignatureStatusPanel({ checkId }: SignatureStatusPanelProps) {
  const { data: rows, isLoading } = useQuery<EndorsementRow[]>({
    queryKey: ["check-endorsement-signatures", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_endorsements")
        .select("id, payee_name, payee_type, status, signed_at")
        .eq("check_id", checkId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as EndorsementRow[];
    },
  });

  return (
    <div className="rounded-md border border-border bg-card/50 px-3 py-2.5">
      <div className="text-sm font-medium mb-2">Signature Status</div>
      {isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-3/4" />
        </div>
      ) : !rows || rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">Awaiting all partner signatures</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const signed = r.status === "signed" || r.status === "waived";
            return (
              <li
                key={r.id}
                className={
                  "flex flex-wrap items-center gap-2 rounded-sm px-2 py-1 text-xs transition-colors hover:brightness-95 " +
                  (signed
                    ? "bg-green-50 text-green-700 dark:bg-green-950/20 dark:text-green-400"
                    : "bg-yellow-50 text-yellow-700 dark:bg-yellow-950/20 dark:text-yellow-400")
                }
              >
                {signed ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <Hourglass className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="font-medium truncate">{r.payee_name}</span>
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {PAYEE_TYPE_LABEL[r.payee_type] ?? r.payee_type}
                </span>
                <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">
                  {signed
                    ? r.signed_at
                      ? `✓ Signed ${format(new Date(r.signed_at), "MMM d, yyyy h:mm a")}`
                      : "✓ Signed"
                    : "⏳ Pending signature"}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
