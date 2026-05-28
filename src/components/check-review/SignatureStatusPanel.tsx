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

interface PayeeRow {
  id: string;
  payee_name: string;
  payee_type: string | null;
  endorsement_status: string | null;
  endorsed_at: string | null;
}

const PAYEE_TYPE_LABEL: Record<string, string> = {
  insured: "Insured",
  public_adjuster: "Public Adjuster",
  mortgage_company: "Mortgage Co.",
  contractor: "Contractor",
  other: "Other",
};

const normalizeName = (value?: string | null) => (value ?? "").trim().toLowerCase();
const normalizeType = (value?: string | null) => (value ?? "other").trim().toLowerCase();

const normalizeStatus = (status?: string | null, signedAt?: string | null) => {
  if (signedAt) return "signed";

  const value = (status ?? "").trim().toLowerCase();
  if (["signed", "endorsed", "complete", "completed"].includes(value)) return "signed";
  if (value === "waived") return "waived";
  if (value === "manual_required") return "manual_required";
  if (["declined", "rejected"].includes(value)) return "rejected";
  if (["sent", "requested", "awaiting", "in_progress", "viewed", "opened"].includes(value)) return "sent";
  if (value === "expired") return "expired";
  return "pending";
};

export function SignatureStatusPanel({ checkId }: SignatureStatusPanelProps) {
  const { data: rows, isLoading } = useQuery<EndorsementRow[]>({
    queryKey: ["check-endorsement-signatures", checkId],
    queryFn: async () => {
      const [{ data: endorsements, error: endorsementError }, { data: payees, error: payeeError }] = await Promise.all([
        supabase
          .from("check_endorsements")
          .select("id, payee_name, payee_type, status, signed_at")
          .eq("check_id", checkId)
          .order("created_at", { ascending: true }),
        supabase
          .from("check_payees")
          .select("id, payee_name, payee_type, endorsement_status, endorsed_at")
          .eq("check_id", checkId)
          .order("created_at", { ascending: true }),
      ]);

      if (endorsementError) throw endorsementError;
      if (payeeError) throw payeeError;

      const endorsementRows = (endorsements ?? []) as EndorsementRow[];
      const payeeRows = (payees ?? []) as PayeeRow[];

      if (payeeRows.length === 0) return endorsementRows;

      const usedEndorsements = new Set<string>();
      const byExactKey = new Map<string, EndorsementRow[]>();
      const byName = new Map<string, EndorsementRow[]>();

      for (const row of endorsementRows) {
        const exactKey = `${normalizeName(row.payee_name)}::${normalizeType(row.payee_type)}`;
        const nameKey = normalizeName(row.payee_name);
        byExactKey.set(exactKey, [...(byExactKey.get(exactKey) ?? []), row]);
        byName.set(nameKey, [...(byName.get(nameKey) ?? []), row]);
      }

      const merged = payeeRows.map((payee) => {
        const exactKey = `${normalizeName(payee.payee_name)}::${normalizeType(payee.payee_type)}`;
        const nameKey = normalizeName(payee.payee_name);
        const match =
          byExactKey.get(exactKey)?.find((row) => !usedEndorsements.has(row.id)) ??
          byName.get(nameKey)?.find((row) => !usedEndorsements.has(row.id));

        if (match) {
          usedEndorsements.add(match.id);
          return match;
        }

        return {
          id: `payee-${payee.id}`,
          payee_name: payee.payee_name,
          payee_type: payee.payee_type ?? "other",
          status: normalizeStatus(payee.endorsement_status, payee.endorsed_at),
          signed_at: payee.endorsed_at,
        } satisfies EndorsementRow;
      });

      for (const row of endorsementRows) {
        if (!usedEndorsements.has(row.id)) merged.push(row);
      }

      return merged;
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
