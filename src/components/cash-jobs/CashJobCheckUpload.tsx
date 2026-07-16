import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { convertHeicToJpegIfNeeded } from "@/lib/convertHeic";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Upload, X, Image, RefreshCw, CheckCircle2, Clock, Eye } from "lucide-react";
import { CheckImageCropper } from "@/components/checks/CheckImageCropper";

interface Props {
  cashJobId: string;
  customerName: string;
  propertyAddress?: string;
  propertyCity?: string;
  propertyState?: string;
}

const PAYMENT_CLASS_LABELS: Record<string, string> = {
  initial_deposit: "Initial Deposit",
  final_payment: "Final Payment",
  progress_payment: "Progress Payment",
  other: "Other",
};

const STATUS_COLORS: Record<string, string> = {
  uploaded: "text-muted-foreground border-border",
  processing: "text-blue-600 border-blue-500/30 bg-blue-500/10",
  needs_review: "text-amber-600 border-amber-500/30 bg-amber-500/10",
  approved_for_deposit: "text-emerald-600 border-emerald-500/30 bg-emerald-500/10",
  deposited: "text-emerald-700 border-emerald-600/30 bg-emerald-600/10",
};

const STATUS_LABELS: Record<string, string> = {
  uploaded: "Uploaded",
  processing: "Processing",
  needs_review: "Needs Review",
  ocr_complete: "Ready for Review",
  approved_for_deposit: "Approved",
  deposited: "Deposited",
};

export function CashJobCheckUpload({
  cashJobId,
  customerName,
  propertyAddress,
  propertyCity,
  propertyState,
}: Props) {
  const { user } = useAuth();
  const { tenant } = useTenant();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [showForm, setShowForm] = useState(false);
  const [frontFile, setFrontFile] = useState<File | null>(null);
  const [backFile, setBackFile] = useState<File | null>(null);
  const [pendingCrop, setPendingCrop] = useState<{ file: File; side: "front" | "back" } | null>(null);
  const [paymentClass, setPaymentClass] = useState("initial_deposit");
  const [uploading, setUploading] = useState(false);

  // Load existing checks for this cash job
  const { data: existingChecks = [] } = useQuery({
    queryKey: ["cash-job-checks", cashJobId],
    enabled: !!cashJobId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("check_intake_items")
        .select("id, status, amount, check_number, cash_job_payment_class, created_at, ocr_status")
        .eq("cash_job_id", cashJobId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const handleUpload = async () => {
    if (!frontFile || !user || !tenant) return;
    setUploading(true);

    try {
      // iPhone HEIC/HEIF photos must be converted to JPEG before upload —
      // browsers and our compositor can't decode HEIC and would render blank.
      const frontSafe = await convertHeicToJpegIfNeeded(frontFile);
      const backSafe = backFile ? await convertHeicToJpegIfNeeded(backFile) : null;

      const ts = Date.now();
      const frontPath = `${tenant.id}/cash-jobs/${cashJobId}/${ts}_front.${frontSafe.name.split(".").pop()}`;

      // Upload front image
      const { error: frontErr } = await supabase.storage
        .from("claim-files")
        .upload(frontPath, frontSafe, { upsert: false, contentType: frontSafe.type || "image/jpeg" });
      if (frontErr) throw frontErr;

      let backPath: string | null = null;
      if (backSafe) {
        backPath = `${tenant.id}/cash-jobs/${cashJobId}/${ts}_back.${backSafe.name.split(".").pop()}`;
        const { error: backErr } = await supabase.storage
          .from("claim-files")
          .upload(backPath, backSafe, { upsert: false, contentType: backSafe.type || "image/jpeg" });
        if (backErr) throw backErr;
      }

      // Create check_intake_item with cash job context
      const { data: check, error: checkErr } = await supabase
        .from("check_intake_items")
        .insert({
          tenant_id: tenant.id,
          uploaded_by: user.id,
          cash_job_id: cashJobId,
          check_source: "cash_job",
          cash_job_payment_class: paymentClass,
          // Pre-fill from cash job
          payee_line: customerName,
          carrier_name: null,
          front_image_path: frontPath,
          back_image_path: backPath,
          status: "uploaded",
          ocr_status: "pending",
        })
        .select("id")
        .single();

      if (checkErr) throw checkErr;

      // Trigger OCR
      await supabase.functions.invoke("check-ocr-intake", {
        body: { checkId: check.id },
      });

      toast({
        title: "Check uploaded",
        description: "It will appear in ChecksOps review shortly.",
      });

      setFrontFile(null);
      setBackFile(null);
      setPaymentClass("initial_deposit");
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ["cash-job-checks", cashJobId] });

    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">

      {/* Existing checks */}
      {existingChecks.length > 0 && (
        <div className="space-y-2">
          {existingChecks.map((check: any) => (
            <div key={check.id} className="flex items-center justify-between p-2.5 rounded-md border bg-background text-sm">
              <div>
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium text-xs">
                    {PAYMENT_CLASS_LABELS[check.cash_job_payment_class] ?? "Check"}
                  </span>
                  {check.check_number && (
                    <span className="text-xs text-muted-foreground font-mono">#{check.check_number}</span>
                  )}
                </div>
                {check.amount && (
                  <p className="text-xs text-muted-foreground ml-5">
                    ${Number(check.amount).toLocaleString("en-US", { minimumFractionDigits: 2 })}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={`text-[10px] ${STATUS_COLORS[check.status] ?? ""}`}>
                  {check.status === "processing" && <RefreshCw className="h-2.5 w-2.5 mr-1 animate-spin" />}
                  {STATUS_LABELS[check.status] ?? check.status}
                </Badge>
                {["needs_review", "ocr_complete", "approved_for_deposit"].includes(check.status) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => window.location.href = `/check-command-center?checkId=${check.id}`}
                  >
                    <Eye className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload button / form */}
      {!showForm ? (
        <Button
          variant="outline"
          size="sm"
          className="w-full h-8 text-xs border-dashed"
          onClick={() => setShowForm(true)}
        >
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          Upload check from client
        </Button>
      ) : (
        <Card className="border-dashed">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-xs">Upload client check</CardTitle>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowForm(false)}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">

            {/* Payment class */}
            <div className="space-y-1">
              <Label className="text-xs">Payment type</Label>
              <Select value={paymentClass} onValueChange={setPaymentClass}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PAYMENT_CLASS_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Context preview */}
            <div className="rounded-md bg-muted/40 p-2 text-xs space-y-0.5">
              <p><span className="text-muted-foreground">Customer: </span>{customerName}</p>
              {propertyAddress && (
                <p><span className="text-muted-foreground">Property: </span>
                  {propertyAddress}{propertyCity ? `, ${propertyCity}` : ""}{propertyState ? `, ${propertyState}` : ""}
                </p>
              )}
            </div>

            {/* Front image */}
            <div className="space-y-1">
              <Label className="text-xs">Front of check *</Label>
              <div
                className={`border-2 border-dashed rounded-md p-3 text-center cursor-pointer transition-colors ${frontFile ? "border-emerald-500/50 bg-emerald-500/5" : "border-border hover:border-primary/50"}`}
                onClick={() => document.getElementById("cash-front-input")?.click()}
              >
                {frontFile ? (
                  <div className="flex items-center justify-center gap-2 text-xs">
                    <Image className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="text-emerald-600 truncate max-w-48">{frontFile.name}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={(e) => { e.stopPropagation(); setFrontFile(null); }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Tap to select front image</p>
                )}
              </div>
              <input
                id="cash-front-input"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => setFrontFile(e.target.files?.[0] ?? null)}
              />
            </div>

            {/* Back image */}
            <div className="space-y-1">
              <Label className="text-xs">Back of check (optional)</Label>
              <div
                className={`border-2 border-dashed rounded-md p-3 text-center cursor-pointer transition-colors ${backFile ? "border-emerald-500/50 bg-emerald-500/5" : "border-border hover:border-primary/50"}`}
                onClick={() => document.getElementById("cash-back-input")?.click()}
              >
                {backFile ? (
                  <div className="flex items-center justify-center gap-2 text-xs">
                    <Image className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="text-emerald-600 truncate max-w-48">{backFile.name}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5"
                      onClick={(e) => { e.stopPropagation(); setBackFile(null); }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">Tap to select back image</p>
                )}
              </div>
              <input
                id="cash-back-input"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => setBackFile(e.target.files?.[0] ?? null)}
              />
            </div>

            <Button
              className="w-full"
              size="sm"
              onClick={handleUpload}
              disabled={!frontFile || uploading}
            >
              {uploading
                ? <><RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />Uploading...</>
                : <><Upload className="h-3.5 w-3.5 mr-1.5" />Upload & analyze</>
              }
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
