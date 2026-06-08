import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ClaimLedgerCard } from "@/components/payments/ClaimLedgerCard";

interface ReviewSettlementTabProps {
  checkId: string;
}

export function ReviewSettlementTab({ checkId }: ReviewSettlementTabProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["review-settlement-check", checkId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, claim_id, detected_claim_number")
        .eq("id", checkId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!checkId,
  });

  if (isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading settlement…</div>;
  }

  return (
    <ClaimLedgerCard
      checkIntakeItemId={checkId}
      claimId={data?.claim_id ?? null}
      detectedClaimNumber={data?.detected_claim_number ?? null}
    />
  );
}
