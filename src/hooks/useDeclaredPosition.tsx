import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import {
  DarwinDeclaredPosition,
  PositionLockStatus,
} from "@/types/darwinDeclaredPosition";
import {
  buildMasterPositionStatement,
  scoreDeclaredPosition,
  validateDeclaredPosition,
} from "@/lib/declared-position/positionEngine";

const emptyPosition = (claimId: string): DarwinDeclaredPosition => ({
  claim_id: claimId,
  claim_type: null,
  observed_damage_condition: "",
  primary_loss_mechanism: "",
  coverage_trigger_theory: "",
  specific_carrier_failure: "",
  decisive_contradiction: "",
  requested_remedy: "",
  key_supporting_evidence: [],
  policy_standard_support: [],
  carrier_evidence_rebutted: [],
  known_weaknesses: [],
  missing_proof_needed: [],
  position_strength_score: null,
  position_strength_label: null,
  drift_risk: null,
  lock_status: "draft",
  master_position_statement: null,
  strategic_notes: null,
  provisional_reason: null,
});

async function writeAuditLog(
  claimId: string,
  action: string,
  beforeJson: any,
  afterJson: any
) {
  try {
    const { data: userData } = await supabase.auth.getUser();
    await supabase.from("darwin_declared_position_audit_logs" as any).insert({
      claim_id: claimId,
      user_id: userData.user?.id ?? null,
      action,
      before_json: beforeJson ? JSON.parse(JSON.stringify(beforeJson)) : null,
      after_json: afterJson ? JSON.parse(JSON.stringify(afterJson)) : null,
    } as any);
  } catch (err) {
    console.error("Audit log write failed:", err);
  }
}

export function useDeclaredPosition(claimId?: string) {
  const [position, setPosition] = useState<DarwinDeclaredPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const fetchPosition = useCallback(async () => {
    if (!claimId) {
      setLoading(false);
      return;
    }
    setLoading(true);

    const { data, error } = await supabase
      .from("darwin_declared_positions")
      .select("*")
      .eq("claim_id", claimId)
      .maybeSingle();

    if (error) {
      console.error("Error fetching declared position:", error);
      setPosition(null);
    } else {
      setPosition((data as unknown as DarwinDeclaredPosition | null) ?? null);
    }
    setLoading(false);
  }, [claimId]);

  useEffect(() => {
    fetchPosition();
  }, [fetchPosition]);

  const savePosition = useCallback(
    async (updates: Partial<DarwinDeclaredPosition>) => {
      if (!claimId) return { error: "Missing claimId" };

      const current = position ?? emptyPosition(claimId);
      const isNew = !position?.id;
      const merged: DarwinDeclaredPosition = { ...current, ...updates };

      // Auto-compute master statement and scoring
      merged.master_position_statement = buildMasterPositionStatement(merged);
      const scored = scoreDeclaredPosition(merged);
      merged.position_strength_score = scored.score;
      merged.position_strength_label = scored.label;
      merged.drift_risk = scored.driftRisk;

      // Legacy field mapping (new → old for backwards compat)
      merged.primary_cause_of_loss = merged.primary_loss_mechanism || null;
      merged.primary_coverage_theory = merged.coverage_trigger_theory || null;
      merged.primary_carrier_error = merged.specific_carrier_failure || null;
      merged.carrier_dependency_statement = merged.decisive_contradiction || null;
      merged.position_locked = merged.lock_status !== "draft";
      merged.confidence_level = merged.lock_status === "litigation_grade" ? "high" : merged.lock_status === "strategic_lock" ? "high" : "medium";

      const { data: userData } = await supabase.auth.getUser();

      const payload: any = {
        claim_id: claimId,
        observed_damage_condition: merged.observed_damage_condition || null,
        primary_loss_mechanism: merged.primary_loss_mechanism || null,
        coverage_trigger_theory: merged.coverage_trigger_theory || null,
        specific_carrier_failure: merged.specific_carrier_failure || null,
        decisive_contradiction: merged.decisive_contradiction || null,
        requested_remedy: merged.requested_remedy || null,
        key_supporting_evidence: merged.key_supporting_evidence,
        policy_standard_support: merged.policy_standard_support,
        carrier_evidence_rebutted: merged.carrier_evidence_rebutted,
        known_weaknesses: merged.known_weaknesses,
        missing_proof_needed: merged.missing_proof_needed,
        position_strength_score: merged.position_strength_score,
        position_strength_label: merged.position_strength_label,
        drift_risk: merged.drift_risk,
        lock_status: merged.lock_status,
        master_position_statement: merged.master_position_statement,
        strategic_notes: merged.strategic_notes || null,
        claim_type: merged.claim_type || null,
        provisional_reason: merged.provisional_reason || null,
        // Legacy fields
        primary_cause_of_loss: merged.primary_cause_of_loss,
        primary_coverage_theory: merged.primary_coverage_theory,
        primary_carrier_error: merged.primary_carrier_error,
        carrier_dependency_statement: merged.carrier_dependency_statement,
        position_locked: merged.position_locked,
        confidence_level: merged.confidence_level,
        updated_at: new Date().toISOString(),
      };

      if (isNew) {
        payload.created_by = userData.user?.id;
      }

      let data: any;
      let error: any;

      if (position?.id) {
        const result = await supabase
          .from("darwin_declared_positions")
          .update(payload)
          .eq("id", position.id)
          .select()
          .single();
        data = result.data;
        error = result.error;
      } else {
        const result = await supabase
          .from("darwin_declared_positions")
          .insert(payload)
          .select()
          .single();
        data = result.data;
        error = result.error;
      }

      if (error) {
        toast({ title: "Save failed", description: error.message, variant: "destructive" });
        return { error: error.message };
      }

      // Smart audit logging: avoid duplicate logs for lock-only changes
      const beforeLock = (current as any)?.lock_status ?? null;
      const afterLock = (data as any)?.lock_status ?? null;
      const changedKeys = Object.keys(payload).filter((key) => {
        const beforeVal = JSON.stringify((current as any)?.[key] ?? null);
        const afterVal = JSON.stringify((data as any)?.[key] ?? null);
        return beforeVal !== afterVal;
      });
      const lockOnlyChange =
        changedKeys.length > 0 &&
        changedKeys.every((key) => key === "lock_status" || key === "position_locked" || key === "confidence_level" || key === "updated_at");

      if (isNew) {
        writeAuditLog(claimId, "created", null, data);
      } else if (beforeLock !== afterLock && lockOnlyChange) {
        // do nothing here — let setLockStatus/unlockPosition write the specific audit event
      } else {
        writeAuditLog(claimId, "updated", current, data);
      }

      setPosition(data as unknown as DarwinDeclaredPosition);
      return { data, error: null };
    },
    [claimId, position, toast]
  );

  const setLockStatus = useCallback(
    async (targetLock: PositionLockStatus) => {
      if (!claimId) return { error: "Missing claimId" };

      const current = position ?? emptyPosition(claimId);
      const validation = validateDeclaredPosition(current, targetLock);

      if (!validation.valid) {
        const msg = [...validation.errors, ...validation.blockingRiskFlags].join("; ");
        toast({ title: "Cannot lock position", description: msg, variant: "destructive" });
        return { error: msg, validation };
      }

      const previousLockStatus = current.lock_status;
      const result = await savePosition({ lock_status: targetLock });

      if (!result.error) {
        // Write lock status change audit
        writeAuditLog(claimId, "lock_status_changed", { lock_status: previousLockStatus }, { lock_status: targetLock });
        toast({
          title: targetLock === "litigation_grade" ? "Litigation Grade Locked" : "Strategic Position Locked",
          description: "Declared position is now locked for carrier-facing outputs.",
        });
      }
      return result;
    },
    [claimId, position, savePosition, toast]
  );

  const unlockPosition = useCallback(async () => {
    const previousLockStatus = position?.lock_status;
    const result = await savePosition({ lock_status: "draft" });
    if (!result.error && claimId) {
      writeAuditLog(claimId, "unlocked", { lock_status: previousLockStatus }, { lock_status: "draft" });
      toast({ title: "Position unlocked", description: "Reverted to draft. You can now edit." });
    }
    return result;
  }, [savePosition, toast, claimId, position]);

  const derived = useMemo(() => {
    const p = position;
    return {
      isDraft: !p || p.lock_status === "draft",
      isStrategicLocked: p?.lock_status === "strategic_lock",
      isLitigationGrade: p?.lock_status === "litigation_grade",
      isLocked: p?.lock_status === "strategic_lock" || p?.lock_status === "litigation_grade",
      isSet: !!(
        p?.observed_damage_condition ||
        p?.primary_loss_mechanism ||
        p?.coverage_trigger_theory ||
        p?.specific_carrier_failure ||
        p?.decisive_contradiction ||
        p?.requested_remedy
      ),
      hasCoreFields: !!(
        p?.observed_damage_condition &&
        p?.primary_loss_mechanism &&
        p?.coverage_trigger_theory &&
        p?.specific_carrier_failure &&
        p?.decisive_contradiction &&
        p?.requested_remedy
      ),
    };
  }, [position]);

  return {
    position,
    loading,
    fetchPosition,
    savePosition,
    setLockStatus,
    unlockPosition,
    ...derived,
  };
}

// Re-export for backwards compat
export type { DarwinDeclaredPosition as DeclaredPosition } from "@/types/darwinDeclaredPosition";
