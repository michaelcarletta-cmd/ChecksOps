import { useCallback, useEffect, useMemo, useState } from "react";
import { useDeclaredPosition } from "@/hooks/useDeclaredPosition";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Shield, Lock, Unlock, Scale, AlertTriangle, Sparkles, CheckCircle2, Plus, Trash2 } from "lucide-react";
import { DECLARED_POSITION_FIELD_HELP, PositionLockStatus, EvidenceAnchor } from "@/types/darwinDeclaredPosition";
import { validateDeclaredPosition } from "@/lib/declared-position/positionEngine";
import { useToast } from "@/hooks/use-toast";
import { v4 as uuidv4 } from "uuid";

interface DeclaredPositionEditorProps {
  claimId: string;
  claim?: any;
}

const LOCK_BADGE_STYLES: Record<string, string> = {
  draft: "bg-muted text-muted-foreground",
  strategic_lock: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  litigation_grade: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
};

const STRENGTH_BADGE_STYLES: Record<string, string> = {
  fragile: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  moderate: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  strong: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
};

const DRIFT_BADGE_STYLES: Record<string, string> = {
  low: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300",
  medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300",
  high: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

const LOCK_LABELS: Record<string, string> = {
  draft: "Draft",
  strategic_lock: "Strategic Lock",
  litigation_grade: "Litigation Grade",
};

const EVIDENCE_TYPES: Array<{ value: EvidenceAnchor["type"]; label: string }> = [
  { value: "document", label: "Document" },
  { value: "photo", label: "Photo" },
  { value: "policy", label: "Policy" },
  { value: "manufacturer", label: "Manufacturer" },
  { value: "code", label: "Building Code" },
  { value: "estimate", label: "Estimate" },
  { value: "carrier_letter", label: "Carrier Letter" },
  { value: "expert_report", label: "Expert Report" },
  { value: "timeline_event", label: "Timeline Event" },
  { value: "other", label: "Other" },
];

export function DeclaredPositionEditor({ claimId, claim }: DeclaredPositionEditorProps) {
  const {
    position,
    loading,
    savePosition,
    setLockStatus,
    unlockPosition,
    isDraft,
    isStrategicLocked,
    isLitigationGrade,
  } = useDeclaredPosition(claimId);

  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const isEditable = isDraft;

  const persist = useCallback(async (updates: Record<string, any>) => {
    setSaving(true);
    await savePosition(updates);
    setSaving(false);
  }, [savePosition]);

  const handleLock = useCallback(async (target: PositionLockStatus) => {
    setSaving(true);
    await setLockStatus(target);
    setSaving(false);
  }, [setLockStatus]);

  const handleUnlock = useCallback(async () => {
    setSaving(true);
    await unlockPosition();
    setSaving(false);
  }, [unlockPosition]);

  const strategicValidation = useMemo(() => {
    if (!position) return null;
    return validateDeclaredPosition(position, "strategic_lock");
  }, [position]);

  const litigationValidation = useMemo(() => {
    if (!position) return null;
    return validateDeclaredPosition(position, "litigation_grade");
  }, [position]);

  if (loading) {
    return (
      <Card className="border-primary/30">
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-primary mr-2" />
          <span className="text-sm text-muted-foreground">Loading position...</span>
        </CardContent>
      </Card>
    );
  }

  const lockStatus = position?.lock_status || "draft";
  const strengthLabel = position?.position_strength_label;
  const strengthScore = position?.position_strength_score;
  const driftRisk = position?.drift_risk;

  return (
    <Card className={`border-2 ${isLitigationGrade ? "border-blue-500/40" : isStrategicLocked ? "border-green-500/40" : "border-muted"}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-5 w-5 text-primary" />
            Declared Position
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={LOCK_BADGE_STYLES[lockStatus]}>
              {lockStatus === "draft" ? <Unlock className="h-3 w-3 mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
              {LOCK_LABELS[lockStatus]}
            </Badge>
            {strengthLabel && (
              <Badge className={STRENGTH_BADGE_STYLES[strengthLabel]}>
                <Scale className="h-3 w-3 mr-1" />
                {strengthLabel} ({strengthScore ?? 0})
              </Badge>
            )}
            {driftRisk && (
              <Badge className={DRIFT_BADGE_STYLES[driftRisk]}>
                Drift: {driftRisk}
              </Badge>
            )}
          </div>
        </div>
        <CardDescription className="text-xs">
          Structured strategic alignment for all carrier-facing AI outputs
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Section 1: Strategic Core */}
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Strategic Core</h3>
          <div className="space-y-4">
            <PositionField
              label="Observed Damage Condition"
              help={DECLARED_POSITION_FIELD_HELP.observed_damage_condition}
              value={position?.observed_damage_condition || ""}
              onSave={(v) => persist({ observed_damage_condition: v })}
              disabled={!isEditable}
              saving={saving}
            />
            <PositionField
              label="Primary Loss Mechanism"
              help={DECLARED_POSITION_FIELD_HELP.primary_loss_mechanism}
              value={position?.primary_loss_mechanism || ""}
              onSave={(v) => persist({ primary_loss_mechanism: v })}
              disabled={!isEditable}
              saving={saving}
            />
            <PositionField
              label="Coverage Trigger Theory"
              help={DECLARED_POSITION_FIELD_HELP.coverage_trigger_theory}
              value={position?.coverage_trigger_theory || ""}
              onSave={(v) => persist({ coverage_trigger_theory: v })}
              disabled={!isEditable}
              saving={saving}
            />
            <PositionField
              label="Specific Carrier Failure"
              help={DECLARED_POSITION_FIELD_HELP.specific_carrier_failure}
              value={position?.specific_carrier_failure || ""}
              onSave={(v) => persist({ specific_carrier_failure: v })}
              disabled={!isEditable}
              saving={saving}
            />
            <PositionField
              label="Decisive Contradiction"
              help={DECLARED_POSITION_FIELD_HELP.decisive_contradiction}
              value={position?.decisive_contradiction || ""}
              onSave={(v) => persist({ decisive_contradiction: v })}
              disabled={!isEditable}
              saving={saving}
            />
            <PositionField
              label="Requested Remedy"
              help={DECLARED_POSITION_FIELD_HELP.requested_remedy}
              value={position?.requested_remedy || ""}
              onSave={(v) => persist({ requested_remedy: v })}
              disabled={!isEditable}
              saving={saving}
            />
          </div>
        </div>

        {/* Section 2: Evidence Support */}
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Evidence Support</h3>
          <div className="space-y-4">
            <EvidenceArrayField
              label="Key Supporting Evidence"
              items={position?.key_supporting_evidence || []}
              onSave={(v) => persist({ key_supporting_evidence: v })}
              disabled={!isEditable}
              saving={saving}
            />
            <EvidenceArrayField
              label="Policy / Standard / Manufacturer Support"
              items={position?.policy_standard_support || []}
              onSave={(v) => persist({ policy_standard_support: v })}
              disabled={!isEditable}
              saving={saving}
            />
            <EvidenceArrayField
              label="Carrier Evidence Being Rebutted"
              items={position?.carrier_evidence_rebutted || []}
              onSave={(v) => persist({ carrier_evidence_rebutted: v })}
              disabled={!isEditable}
              saving={saving}
            />
          </div>
        </div>

        {/* Section 3: Risks and Missing Proof */}
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Risks & Missing Proof</h3>
          <div className="space-y-4">
            <ArrayField
              label="Known Weaknesses / Adverse Facts"
              values={position?.known_weaknesses || []}
              onSave={(v) => persist({ known_weaknesses: v })}
              disabled={!isEditable}
              saving={saving}
            />
            <ArrayField
              label="Missing Proof Needed"
              values={position?.missing_proof_needed || []}
              onSave={(v) => persist({ missing_proof_needed: v })}
              disabled={!isEditable}
              saving={saving}
            />
          </div>
        </div>

        {/* Section 4: Master Position Statement */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Master Position Statement</h3>
          <div className="p-3 bg-muted/50 rounded-md border">
            {position?.master_position_statement ? (
              <p className="text-sm leading-relaxed">{position.master_position_statement}</p>
            ) : (
              <p className="text-sm text-muted-foreground italic">
                Complete the six strategic core fields to auto-generate the master position statement.
              </p>
            )}
          </div>
        </div>

        {/* Validation warnings */}
        {isDraft && strategicValidation && strategicValidation.errors.length > 0 && (
          <Alert className="border-yellow-500/50 bg-yellow-50 dark:bg-yellow-950/20">
            <AlertTriangle className="h-4 w-4 text-yellow-600" />
            <AlertDescription className="text-xs">
              <strong>To lock strategic position:</strong>
              <ul className="mt-1 space-y-0.5 list-disc list-inside">
                {strategicValidation.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {strategicValidation?.warnings && strategicValidation.warnings.length > 0 && (
          <Alert className="border-orange-500/30 bg-orange-50 dark:bg-orange-950/20">
            <Sparkles className="h-4 w-4 text-orange-500" />
            <AlertDescription className="text-xs">
              <strong>Quality warnings:</strong>
              <ul className="mt-1 space-y-0.5 list-disc list-inside">
                {strategicValidation.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* Sticky Footer Actions */}
        <div className="flex flex-wrap gap-2 pt-2 border-t">
          {isDraft && (
            <>
              <Button
                size="sm"
                variant="default"
                className="bg-green-600 hover:bg-green-700"
                onClick={() => handleLock("strategic_lock")}
                disabled={saving}
              >
                <Lock className="h-4 w-4 mr-1" />
                Lock Strategic Position
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleLock("litigation_grade")}
                disabled={saving}
              >
                <Scale className="h-4 w-4 mr-1" />
                Promote to Litigation Grade
              </Button>
            </>
          )}
          {isStrategicLocked && (
            <>
              <Button
                size="sm"
                variant="default"
                className="bg-blue-600 hover:bg-blue-700"
                onClick={() => handleLock("litigation_grade")}
                disabled={saving}
              >
                <Scale className="h-4 w-4 mr-1" />
                Promote to Litigation Grade
              </Button>
              <Button size="sm" variant="outline" onClick={handleUnlock} disabled={saving}>
                <Unlock className="h-4 w-4 mr-1" />
                Revert to Draft
              </Button>
            </>
          )}
          {isLitigationGrade && (
            <Button size="sm" variant="outline" onClick={handleUnlock} disabled={saving}>
              <Unlock className="h-4 w-4 mr-1" />
              Revert to Draft
            </Button>
          )}
          {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground ml-2 self-center" />}
        </div>
      </CardContent>
    </Card>
  );
}

/* --- Sub-components --- */

function PositionField({
  label,
  help,
  value,
  onSave,
  disabled,
  saving,
}: {
  label: string;
  help: string;
  value: string;
  onSave: (v: string) => void;
  disabled: boolean;
  saving: boolean;
}) {
  const [local, setLocal] = useState(value);
  const [dirty, setDirty] = useState(false);

  // Sync from props when value changes externally
  useEffect(() => {
    setLocal(value);
    setDirty(false);
  }, [value]);

  const handleChange = (v: string) => {
    setLocal(v);
    setDirty(v !== value);
  };

  const handleSave = () => {
    onSave(local);
    setDirty(false);
  };

  return (
    <div className="space-y-1.5">
      <div>
        <label className="text-xs font-semibold">{label}</label>
        <p className="text-xs text-muted-foreground">{help}</p>
      </div>
      <Textarea
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        className="min-h-[72px] text-sm"
      />
      {dirty && !disabled && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={handleSave} disabled={saving}>
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function ArrayField({
  label,
  values,
  onSave,
  disabled,
  saving,
}: {
  label: string;
  values: string[];
  onSave: (v: string[]) => void;
  disabled: boolean;
  saving: boolean;
}) {
  const [local, setLocal] = useState(values.join("\n"));
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setLocal(values.join("\n"));
    setDirty(false);
  }, [values]);

  const handleChange = (v: string) => {
    setLocal(v);
    setDirty(true);
  };

  const handleSave = () => {
    onSave(
      local.split("\n").map((v) => v.trim()).filter(Boolean)
    );
    setDirty(false);
  };

  return (
    <div className="space-y-1.5">
      <div>
        <label className="text-xs font-semibold">{label}</label>
        <p className="text-xs text-muted-foreground">One item per line</p>
      </div>
      <Textarea
        value={local}
        onChange={(e) => handleChange(e.target.value)}
        disabled={disabled}
        className="min-h-[72px] text-sm"
      />
      {dirty && !disabled && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={handleSave} disabled={saving}>
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function EvidenceArrayField({
  label,
  items,
  onSave,
  disabled,
  saving,
}: {
  label: string;
  items: EvidenceAnchor[];
  onSave: (v: EvidenceAnchor[]) => void;
  disabled: boolean;
  saving: boolean;
}) {
  const [localItems, setLocalItems] = useState<EvidenceAnchor[]>(items);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setLocalItems(items);
    setDirty(false);
  }, [items]);

  const addItem = () => {
    setLocalItems([...localItems, { id: uuidv4(), type: "document", label: "", citation: "", note: "" }]);
    setDirty(true);
  };

  const removeItem = (id: string) => {
    setLocalItems(localItems.filter((i) => i.id !== id));
    setDirty(true);
  };

  const updateItem = (id: string, field: keyof EvidenceAnchor, value: string) => {
    setLocalItems(localItems.map((i) => (i.id === id ? { ...i, [field]: value } : i)));
    setDirty(true);
  };

  const handleSave = () => {
    onSave(localItems.filter((i) => i.label.trim().length > 0));
    setDirty(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-semibold">{label}</label>
        {!disabled && (
          <Button size="sm" variant="ghost" onClick={addItem} className="h-6 px-2 text-xs">
            <Plus className="h-3 w-3 mr-1" />
            Add
          </Button>
        )}
      </div>
      {localItems.length === 0 && (
        <p className="text-xs text-muted-foreground italic">No items added yet.</p>
      )}
      {localItems.map((item) => (
        <div key={item.id} className="border rounded-md p-2 space-y-2 bg-muted/20">
          <div className="flex items-center gap-2">
            <Select
              value={item.type}
              onValueChange={(v) => updateItem(item.id, "type", v)}
              disabled={disabled}
            >
              <SelectTrigger className="w-[140px] h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVIDENCE_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={item.label}
              onChange={(e) => updateItem(item.id, "label", e.target.value)}
              placeholder="Label / description"
              disabled={disabled}
              className="h-7 text-xs flex-1"
            />
            {!disabled && (
              <Button size="sm" variant="ghost" onClick={() => removeItem(item.id)} className="h-7 w-7 p-0 text-destructive">
                <Trash2 className="h-3 w-3" />
              </Button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={item.citation || ""}
              onChange={(e) => updateItem(item.id, "citation", e.target.value)}
              placeholder="Citation (optional)"
              disabled={disabled}
              className="h-7 text-xs"
            />
            <Input
              value={item.note || ""}
              onChange={(e) => updateItem(item.id, "note", e.target.value)}
              placeholder="Note (optional)"
              disabled={disabled}
              className="h-7 text-xs"
            />
          </div>
        </div>
      ))}
      {dirty && !disabled && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={handleSave} disabled={saving}>
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
