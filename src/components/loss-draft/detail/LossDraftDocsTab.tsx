import { ViewCheckImageButton } from "@/components/checks/ViewCheckImageButton";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LossDraftDocsManager } from "@/components/loss-draft/LossDraftDocsManager";
import type { LossDraftDoc } from "@/hooks/queries/useLossDraft";
import { useEffect, useState } from "react";

interface Props {
  lossDraftId: string;
  claimId: string;
  checkIntakeItemId?: string | null;
  docs: LossDraftDoc[];
  onChanged: () => void;
}

interface ClaimCtx {
  homeowner_name?: string | null;
  homeowner_email?: string | null;
  property_address?: string | null;
  claim_number?: string | null;
  policy_number?: string | null;
  carrier?: string | null;
  loss_date?: string | null;
  loan_number?: string | null;
}

export function LossDraftDocsTab({ lossDraftId, claimId, checkIntakeItemId, docs, onChanged }: Props) {
  const { user } = useAuth();
  const [ctx, setCtx] = useState<ClaimCtx>({});

  useEffect(() => {
    if (!claimId) return;
    void (async () => {
      const { data } = await supabase
        .from("claims")
        .select("policyholder_name,policyholder_email,policyholder_address,claim_number,policy_number,insurance_company,loss_date,loan_number")
        .eq("id", claimId)
        .maybeSingle();
      if (data) {
        setCtx({
          homeowner_name: data.policyholder_name,
          homeowner_email: data.policyholder_email,
          property_address: data.policyholder_address,
          claim_number: data.claim_number,
          policy_number: data.policy_number,
          carrier: data.insurance_company,
          loss_date: data.loss_date,
          loan_number: data.loan_number,
        });
      }
    })();
  }, [claimId]);

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="p-4 space-y-3">
        {checkIntakeItemId && (
          <div className="flex justify-end">
            <ViewCheckImageButton
              checkId={checkIntakeItemId}
              className="w-full text-xs h-8"
            />
          </div>
        )}
        <LossDraftDocsManager
          supabaseClient={supabase}
          lossDraftId={lossDraftId}
          claimId={claimId}
          actorId={user?.id ?? null}
          docs={docs as any}
          onChanged={onChanged}
          canSendSignature={false}
          claimContext={ctx}
        />
      </div>
    </ScrollArea>
  );
}
