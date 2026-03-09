import { useState, useRef } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { logAudit } from "@/hooks/useAuditLog";
import {
  Eye, MapPin, FileCheck, ClipboardCheck, Upload, AlertTriangle, Info,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ConfirmationLevel =
  | "reviewed"
  | "field_confirmed"
  | "vendor_confirmed"
  | "estimate_confirmed";

export type ConfirmationBasis =
  | "visual_review"
  | "satellite_cross_check"
  | "field_measurement"
  | "eagleview_report"
  | "hover_report"
  | "vendor_report"
  | "contractor_estimate_match";

interface Attachment {
  name: string;
  path: string;
  type: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  estimateId: string;
  claimId: string;
  confidenceScore: number | null;
  onConfirmed: (update: {
    confirmation_level: ConfirmationLevel;
    confirmation_basis: ConfirmationBasis;
    confirmation_notes: string | null;
    confirmation_strength_score: number;
    confirmation_attachments: Attachment[] | null;
    manually_confirmed: boolean;
  }) => void;
}

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const LEVELS: {
  value: ConfirmationLevel;
  label: string;
  description: string;
  icon: React.ReactNode;
  baseWeight: number;
}[] = [
  {
    value: "reviewed",
    label: "Reviewed",
    description: "Staff reviewed AI output; no independent verification.",
    icon: <Eye className="h-4 w-4" />,
    baseWeight: 15,
  },
  {
    value: "field_confirmed",
    label: "Field Confirmed",
    description: "Verified with on-site field measurements or photos.",
    icon: <MapPin className="h-4 w-4" />,
    baseWeight: 40,
  },
  {
    value: "vendor_confirmed",
    label: "Vendor Confirmed",
    description: "Cross-checked against EagleView, HOVER, or third-party report.",
    icon: <FileCheck className="h-4 w-4" />,
    baseWeight: 35,
  },
  {
    value: "estimate_confirmed",
    label: "Estimate Confirmed",
    description: "Values align with a completed contractor or carrier estimate.",
    icon: <ClipboardCheck className="h-4 w-4" />,
    baseWeight: 25,
  },
];

const BASIS_OPTIONS: Record<ConfirmationLevel, { value: ConfirmationBasis; label: string; evidenceBonus: number }[]> = {
  reviewed: [
    { value: "visual_review", label: "Visual review of AI output", evidenceBonus: 0 },
    { value: "satellite_cross_check", label: "Satellite imagery cross-check", evidenceBonus: 10 },
  ],
  field_confirmed: [
    { value: "field_measurement", label: "On-site tape / laser measurement", evidenceBonus: 25 },
  ],
  vendor_confirmed: [
    { value: "eagleview_report", label: "EagleView report", evidenceBonus: 20 },
    { value: "hover_report", label: "HOVER 3D model", evidenceBonus: 20 },
    { value: "vendor_report", label: "Other vendor report", evidenceBonus: 15 },
  ],
  estimate_confirmed: [
    { value: "contractor_estimate_match", label: "Contractor / carrier estimate match", evidenceBonus: 10 },
  ],
};

/* ------------------------------------------------------------------ */
/*  Strength scorer                                                    */
/* ------------------------------------------------------------------ */

function computeStrength(
  level: ConfirmationLevel,
  basis: ConfirmationBasis,
  hasAttachments: boolean,
  measurementConfidence: number | null,
): number {
  const lvl = LEVELS.find((l) => l.value === level);
  const basisOption = BASIS_OPTIONS[level]?.find((b) => b.value === basis);
  let score = (lvl?.baseWeight ?? 10) + (basisOption?.evidenceBonus ?? 0);
  if (hasAttachments) score += 10;
  // Measurement confidence contributes up to 20 pts (scaled from 0-100 → 0-20)
  if (measurementConfidence != null) {
    score += Math.round((measurementConfidence / 100) * 20);
  }
  return Math.min(100, Math.max(0, score));
}

function strengthLabel(score: number): { text: string; color: string } {
  if (score >= 70) return { text: "Strong", color: "text-green-600 border-green-500/50" };
  if (score >= 40) return { text: "Moderate", color: "text-yellow-600 border-yellow-500/50" };
  return { text: "Weak", color: "text-red-600 border-red-500/50" };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function RoofConfirmationDialog({
  open, onOpenChange, estimateId, claimId, confidenceScore, onConfirmed,
}: Props) {
  const [level, setLevel] = useState<ConfirmationLevel | null>(null);
  const [basis, setBasis] = useState<ConfirmationBasis | null>(null);
  const [notes, setNotes] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const basisOptions = level ? BASIS_OPTIONS[level] : [];
  const strength = level && basis
    ? computeStrength(level, basis, attachments.length > 0, confidenceScore)
    : null;
  const strengthInfo = strength != null ? strengthLabel(strength) : null;

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    const newAttachments: Attachment[] = [];
    for (const file of Array.from(files)) {
      const ext = file.name.split(".").pop() || "bin";
      const path = `roof-confirmations/${claimId}/${Date.now()}_${file.name}`;
      const { error } = await supabase.storage.from("claim-files").upload(path, file);
      if (error) {
        toast.error(`Failed to upload ${file.name}`);
        continue;
      }
      newAttachments.push({ name: file.name, path, type: ext });
    }
    setAttachments((prev) => [...prev, ...newAttachments]);
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };

  const handleConfirm = async () => {
    if (!level || !basis) return;
    setSaving(true);
    const score = computeStrength(level, basis, attachments.length > 0, confidenceScore);
    const now = new Date().toISOString();

    const updatePayload: Record<string, any> = {
      manually_confirmed: true,
      confirmed_at: now,
      review_required: false,
      confirmation_level: level,
      confirmation_basis: basis,
      confirmation_notes: notes || null,
      confirmation_strength_score: score,
      confirmation_attachments: attachments.length > 0 ? attachments : null,
      updated_at: now,
    };

    const { error } = await supabase
      .from("claim_roof_measurements")
      .update(updatePayload)
      .eq("id", estimateId);

    if (error) {
      toast.error("Failed to confirm estimate");
      setSaving(false);
      return;
    }

    logAudit({
      action: "update",
      recordType: "roof_confirmation",
      recordId: claimId,
      newValues: {
        confirmation_level: level,
        confirmation_basis: basis,
        confirmation_strength_score: score,
        attachments_count: attachments.length,
      },
    });

    onConfirmed({
      confirmation_level: level,
      confirmation_basis: basis,
      confirmation_notes: notes || null,
      confirmation_strength_score: score,
      confirmation_attachments: attachments.length > 0 ? attachments : null,
      manually_confirmed: true,
    });

    toast.success(`Estimate confirmed as "${LEVELS.find((l) => l.value === level)?.label}" (strength: ${score}/100)`);
    onOpenChange(false);
    setSaving(false);
    // Reset
    setLevel(null);
    setBasis(null);
    setNotes("");
    setAttachments([]);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Confirm Roof Estimate</DialogTitle>
          <DialogDescription className="text-xs">
            Choose a confirmation level, evidence basis, and optionally attach supporting files.
            Confirmation strength is scored independently from measurement confidence.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Confirmation Level */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase text-muted-foreground">Confirmation Level</Label>
            <RadioGroup
              value={level ?? ""}
              onValueChange={(v) => {
                setLevel(v as ConfirmationLevel);
                setBasis(null); // reset basis when level changes
              }}
              className="grid grid-cols-2 gap-2"
            >
              {LEVELS.map((l) => (
                <label
                  key={l.value}
                  className={`flex items-start gap-2 rounded-lg border p-2.5 cursor-pointer transition-colors hover:bg-muted/50 ${
                    level === l.value ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  <RadioGroupItem value={l.value} className="mt-0.5" />
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      {l.icon}
                      {l.label}
                    </div>
                    <p className="text-[10px] text-muted-foreground leading-tight">{l.description}</p>
                  </div>
                </label>
              ))}
            </RadioGroup>
          </div>

          {/* Basis */}
          {level && basisOptions.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs font-semibold uppercase text-muted-foreground">Evidence Basis</Label>
              <RadioGroup
                value={basis ?? ""}
                onValueChange={(v) => setBasis(v as ConfirmationBasis)}
                className="space-y-1"
              >
                {basisOptions.map((b) => (
                  <label
                    key={b.value}
                    className={`flex items-center gap-2 rounded-md border px-3 py-2 cursor-pointer transition-colors hover:bg-muted/50 ${
                      basis === b.value ? "border-primary bg-primary/5" : "border-border"
                    }`}
                  >
                    <RadioGroupItem value={b.value} />
                    <span className="text-sm">{b.label}</span>
                  </label>
                ))}
              </RadioGroup>
            </div>
          )}

          {/* Strength Preview */}
          {strength != null && strengthInfo && (
            <div className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/50 border">
              <div className="text-center min-w-[56px]">
                <div className={`text-xl font-bold tabular-nums ${strengthInfo.color.split(" ")[0]}`}>
                  {strength}
                </div>
                <div className="text-[9px] text-muted-foreground">/ 100</div>
              </div>
              <div className="space-y-0.5">
                <Badge variant="outline" className={`text-[10px] ${strengthInfo.color}`}>
                  {strengthInfo.text} Confirmation
                </Badge>
                <p className="text-[10px] text-muted-foreground">
                  Based on evidence type{attachments.length > 0 ? " + attachments" : ""}.
                  Measurement confidence ({confidenceScore ?? 0}%) contributes separately.
                </p>
              </div>
            </div>
          )}

          {/* Authority vs Confidence Note */}
          <Alert>
            <Info className="h-3.5 w-3.5" />
            <AlertDescription className="text-[10px]">
              <strong>Authority ≠ Accuracy.</strong> Confirming an estimate makes it workflow-authoritative
              (downstream tools can use it) but does <em>not</em> change the underlying measurement confidence score.
              A "Reviewed" confirmation with low confidence means "we accept these values for now" — not "these values are precise."
            </AlertDescription>
          </Alert>

          {/* Notes */}
          <div className="space-y-1">
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any context about the confirmation..."
              className="text-sm h-16 resize-none"
            />
          </div>

          {/* Attachments */}
          <div className="space-y-1.5">
            <Label className="text-xs">Supporting Files (optional)</Label>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="text-xs"
                disabled={uploading}
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="h-3.5 w-3.5 mr-1" />
                {uploading ? "Uploading…" : "Attach File"}
              </Button>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xlsx"
                onChange={handleFileUpload}
              />
              {attachments.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {attachments.length} file{attachments.length > 1 ? "s" : ""} attached
                </span>
              )}
            </div>
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {attachments.map((a, i) => (
                  <Badge key={i} variant="secondary" className="text-[10px] gap-1">
                    {a.name}
                    <button
                      className="ml-0.5 hover:text-destructive"
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!level || !basis || saving}
            onClick={handleConfirm}
          >
            {saving ? "Confirming…" : "Confirm Estimate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
