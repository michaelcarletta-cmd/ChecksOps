import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type FeedbackType = 'thumbs_up' | 'thumbs_down' | 'edit' | 'override' | 'used_as_is';
type OutputType = 'estimate_analysis' | 'photo_finding' | 'strategy_sim' | 'rebuttal' | 'copilot_answer' | 'demand_package';

export async function submitDarwinFeedback({
  claimId,
  outputType,
  outputId,
  feedbackType,
  feedbackDetail,
}: {
  claimId: string;
  outputType: OutputType;
  outputId?: string;
  feedbackType: FeedbackType;
  feedbackDetail?: string;
}) {
  try {
    await supabase.functions.invoke('darwin-cross-claim-learning', {
      body: {
        action: 'record_feedback',
        claimId,
        outcomeData: {
          outputType,
          outputId,
          feedbackType,
          feedbackDetail,
        },
      },
    });
  } catch (err) {
    console.error('Darwin feedback error:', err);
  }
}

export async function recordClaimOutcome({
  claimId,
  outcome,
  finalSettlement,
  initialCarrierOffer,
  denialRationale,
  keyTurningPoint,
  lessonsLearned,
}: {
  claimId: string;
  outcome: string;
  finalSettlement?: number;
  initialCarrierOffer?: number;
  denialRationale?: string;
  keyTurningPoint?: string;
  lessonsLearned?: string;
}) {
  try {
    const recoveryDelta = finalSettlement && initialCarrierOffer
      ? finalSettlement - initialCarrierOffer
      : undefined;

    await supabase.functions.invoke('darwin-cross-claim-learning', {
      body: {
        action: 'record_outcome',
        claimId,
        outcomeData: {
          outcome,
          final_settlement: finalSettlement,
          initial_carrier_offer: initialCarrierOffer,
          recovery_delta: recoveryDelta,
          denial_rationale: denialRationale,
          key_turning_point: keyTurningPoint,
          lessons_learned: lessonsLearned,
        },
      },
    });
    toast.success("Claim outcome recorded for learning");
  } catch (err: any) {
    toast.error(err.message || "Failed to record outcome");
  }
}
