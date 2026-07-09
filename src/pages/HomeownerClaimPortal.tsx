import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ShieldCheck,
  Upload,
  Loader2,
  CheckCircle2,
  ImagePlus,
  FileSignature,
  ClipboardCheck,
  ArrowLeft,
  Lock,
} from "lucide-react";
import { toast } from "sonner";

type Lead = {
  id: string;
  homeowner_name: string;
  homeowner_email: string;
  property_zip: string | null;
  loss_type: string | null;
  status: string;
  created_at: string;
  dtp_signed_at: string | null;
  dtp_signature_name: string | null;
  dtp_insurance_carrier: string | null;
  dtp_claim_number: string | null;
  dtp_policy_number: string | null;
  dtp_property_address: string | null;
};
type Contractor = { id: string; display_name: string; bio: string | null; tier: string | null };
type UploadRow = { id: string; file_path: string; status: string; note: string | null; created_at: string };
type CheckRow = {
  id: string;
  amount: number | null;
  check_number: string | null;
  carrier_name: string | null;
  payee_line: string | null;
  check_stage: string | null;
  status: string | null;
  deposited_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const MAX_MB = 15;
const ENDORSED_STAGES = new Set([
  "endorsements_complete",
  "approved_for_deposit",
  "branch_deposit_required",
  "deposited",
  "cleared",
]);
const DEPOSITED_STAGES = new Set(["deposited", "cleared"]);

export default function HomeownerClaimPortal() {
  const { token = "" } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lead, setLead] = useState<Lead | null>(null);
  const [contractor, setContractor] = useState<Contractor | null>(null);
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [checks, setChecks] = useState<CheckRow[]>([]);

  // Upload state
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // DTP state
  const [carrier, setCarrier] = useState("");
  const [claimNum, setClaimNum] = useState("");
  const [policyNum, setPolicyNum] = useState("");
  const [propertyAddr, setPropertyAddr] = useState("");
  const [sigName, setSigName] = useState("");
  const [agree, setAgree] = useState(false);
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    document.title = "Your claim portal | ChecksOps";
  }, []);

  const load = async () => {
    setLoading(true);
    try {
      const { data, error: err } = await supabase.functions.invoke("homeowner-claim-portal", {
        body: { token, action: "get" },
      });
      if (err) throw new Error(err.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      setLead((data as any).lead);
      setContractor((data as any).contractor);
      setUploads(((data as any).uploads ?? []) as UploadRow[]);
      setChecks(((data as any).checks ?? []) as CheckRow[]);
      const l = (data as any).lead as Lead;
      setCarrier(l?.dtp_insurance_carrier ?? "");
      setClaimNum(l?.dtp_claim_number ?? "");
      setPolicyNum(l?.dtp_policy_number ?? "");
      setPropertyAddr(l?.dtp_property_address ?? "");
      setSigName(l?.dtp_signature_name ?? "");
    } catch (e: any) {
      setError(e.message ?? "This link isn't valid.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const pickFile = (f: File | null) => {
    if (!f) {
      setFile(null);
      setPreview(null);
      return;
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      toast.error(`File too large (${MAX_MB} MB max)`);
      return;
    }
    setFile(f);
    setPreview(f.type.startsWith("image/") ? URL.createObjectURL(f) : null);
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const b64 = await fileToBase64(file);
      const { data, error: err } = await supabase.functions.invoke("homeowner-claim-portal", {
        body: {
          token,
          action: "upload_check",
          file_base64: b64,
          file_mime: file.type || "application/octet-stream",
          filename: file.name,
          note: note.trim() || undefined,
        },
      });
      if (err) throw new Error(err.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success("Check sent securely");
      setFile(null);
      setPreview(null);
      setNote("");
      if (fileInput.current) fileInput.current.value = "";
      await load();
    } catch (e: any) {
      toast.error(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const signDtp = async () => {
    if (!agree) return toast.error("Please confirm authorization");
    if (sigName.trim().length < 2) return toast.error("Type your full legal name");
    setSigning(true);
    try {
      const { data, error: err } = await supabase.functions.invoke("homeowner-claim-portal", {
        body: {
          token,
          action: "sign_dtp",
          signature_name: sigName.trim(),
          insurance_carrier: carrier || undefined,
          claim_number: claimNum || undefined,
          policy_number: policyNum || undefined,
          property_address: propertyAddr || undefined,
        },
      });
      if (err) throw new Error(err.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success("Direction to Pay signed");
      await load();
    } catch (e: any) {
      toast.error(e.message ?? "Could not save signature");
    } finally {
      setSigning(false);
    }
  };

  const dtpSigned = !!lead?.dtp_signed_at;

  if (loading) {
    return (
      <Shell>
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </Shell>
    );
  }
  if (error || !lead) {
    return (
      <Shell>
        <Card className="max-w-md mx-auto">
          <CardContent className="py-10 text-center space-y-2">
            <Lock className="h-8 w-8 text-muted-foreground mx-auto" />
            <div className="font-semibold">This link isn't valid</div>
            <p className="text-sm text-muted-foreground">
              {error ?? "Ask your contractor to resend your secure link."}
            </p>
            <Link to="/find-a-pro" className="text-sm text-primary underline inline-block mt-2">
              <ArrowLeft className="h-3 w-3 inline mr-1" /> Back to Find a Pro
            </Link>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-2xl mx-auto space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              Hi {lead.homeowner_name.split(" ")[0]}, here's your claim
            </CardTitle>
            <CardDescription>
              You're working with <strong>{contractor?.display_name ?? "your contractor"}</strong>
              . Everything you send below stays inside ChecksOps and is visible to you and them —
              nobody else.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground grid grid-cols-2 gap-2">
            <div>
              <div className="uppercase text-[10px]">Loss type</div>
              <div className="text-foreground">{lead.loss_type ?? "—"}</div>
            </div>
            <div>
              <div className="uppercase text-[10px]">Property ZIP</div>
              <div className="text-foreground">{lead.property_zip ?? "—"}</div>
            </div>
          </CardContent>
        </Card>

        {/* Timeline */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardCheck className="h-4 w-4" /> Claim activity
            </CardTitle>
            <CardDescription>Live status of what's happening on your check.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <TimelineRow
              done
              label="Introduction sent to contractor"
              detail={new Date(lead.created_at).toLocaleString()}
            />
            <TimelineRow
              done={dtpSigned}
              label="Direction to Pay signed"
              detail={
                dtpSigned && lead.dtp_signed_at
                  ? `${lead.dtp_signature_name} • ${new Date(lead.dtp_signed_at).toLocaleString()}`
                  : "Required before deposit"
              }
            />
            <TimelineRow
              done={uploads.length > 0 || checks.length > 0}
              label="Check received by ChecksOps"
              detail={
                checks[0]?.created_at
                  ? new Date(checks[0].created_at).toLocaleString()
                  : uploads[0]
                    ? new Date(uploads[0].created_at).toLocaleString()
                    : "Upload below to start"
              }
            />
            <TimelineRow
              done={checks.some((c) => ENDORSED_STAGES.has(c.check_stage ?? ""))}
              label="Endorsed by all parties"
              detail={
                checks.some((c) => ENDORSED_STAGES.has(c.check_stage ?? ""))
                  ? "Complete"
                  : "Contractor collects endorsements"
              }
            />
            <TimelineRow
              done={checks.some((c) => DEPOSITED_STAGES.has(c.check_stage ?? "") || c.deposited_at)}
              label="Deposited"
              detail={
                checks.find((c) => c.deposited_at)
                  ? `Deposited ${new Date(checks.find((c) => c.deposited_at)!.deposited_at!).toLocaleString()}`
                  : checks.some((c) => DEPOSITED_STAGES.has(c.check_stage ?? ""))
                    ? "Funds on the way to contractor"
                    : "Pending endorsements"
              }
            />
          </CardContent>
        </Card>

        {checks.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Live check status</CardTitle>
              <CardDescription>
                Updated automatically as your contractor works your check through ChecksOps.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {checks.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between text-sm border border-border rounded-md p-3"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {c.carrier_name ?? "Insurance check"}
                      {c.check_number ? ` • #${c.check_number}` : ""}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {c.amount != null
                        ? `$${Number(c.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                        : ""}
                      {c.updated_at ? ` • updated ${new Date(c.updated_at).toLocaleDateString()}` : ""}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px] capitalize whitespace-nowrap ml-2">
                    {(c.check_stage ?? c.status ?? "processing").replace(/_/g, " ")}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* DTP */}
        <Card className={dtpSigned ? "border-primary/40" : ""}>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileSignature className="h-4 w-4" />
              Direction to Pay
              {dtpSigned && (
                <Badge className="ml-1 gap-1 text-[10px]">
                  <CheckCircle2 className="h-3 w-3" /> Signed
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Authorizes your insurance carrier and mortgage company (if any) to make the claim
              check payable to <strong>{contractor?.display_name}</strong>. No money moves without
              your approval on each release.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {dtpSigned ? (
              <div className="text-sm text-muted-foreground border border-border rounded-md p-3 space-y-1">
                <div>
                  <strong className="text-foreground">Signed by:</strong>{" "}
                  {lead.dtp_signature_name}
                </div>
                <div>
                  <strong className="text-foreground">On:</strong>{" "}
                  {new Date(lead.dtp_signed_at!).toLocaleString()}
                </div>
                {lead.dtp_insurance_carrier && (
                  <div>
                    <strong className="text-foreground">Carrier:</strong>{" "}
                    {lead.dtp_insurance_carrier}
                  </div>
                )}
                {lead.dtp_claim_number && (
                  <div>
                    <strong className="text-foreground">Claim #:</strong> {lead.dtp_claim_number}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field label="Insurance carrier">
                    <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} maxLength={120} />
                  </Field>
                  <Field label="Claim number">
                    <Input value={claimNum} onChange={(e) => setClaimNum(e.target.value)} maxLength={80} />
                  </Field>
                  <Field label="Policy number">
                    <Input value={policyNum} onChange={(e) => setPolicyNum(e.target.value)} maxLength={80} />
                  </Field>
                  <Field label="Property address">
                    <Input value={propertyAddr} onChange={(e) => setPropertyAddr(e.target.value)} maxLength={240} />
                  </Field>
                </div>
                <Separator />
                <div className="text-xs text-muted-foreground space-y-2 border border-border rounded-md p-3">
                  <p>
                    I, the undersigned homeowner, authorize my insurance carrier and, if
                    applicable, my mortgage company to include <strong>{contractor?.display_name}</strong>{" "}
                    as a payee on any insurance proceeds issued for the loss above. I authorize
                    ChecksOps to hold the check image, collect endorsements, and process deposit on
                    behalf of the contractor. This authorization does not release funds until I
                    approve each disbursement inside ChecksOps.
                  </p>
                </div>
                <div className="flex items-start gap-2">
                  <Checkbox id="agree" checked={agree} onCheckedChange={(v) => setAgree(!!v)} />
                  <label htmlFor="agree" className="text-xs">
                    I have read and agree to the Direction to Pay above.
                  </label>
                </div>
                <Field label="Type your full legal name to sign">
                  <Input
                    value={sigName}
                    onChange={(e) => setSigName(e.target.value)}
                    placeholder="First Last"
                    maxLength={120}
                  />
                </Field>
                <Button className="w-full" onClick={signDtp} disabled={signing || !agree}>
                  {signing && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Sign Direction to Pay
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        {/* Upload check */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Upload className="h-4 w-4" />
              Send your insurance check
            </CardTitle>
            <CardDescription>
              Take a photo or upload the check image. It goes directly to{" "}
              {contractor?.display_name}'s ChecksOps vault.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className="border-2 border-dashed border-border rounded-lg p-6 text-center cursor-pointer hover:border-primary transition-colors"
              onClick={() => fileInput.current?.click()}
            >
              {preview ? (
                <img src={preview} alt="check preview" className="max-h-64 mx-auto rounded" />
              ) : file ? (
                <div className="text-sm">
                  <CheckCircle2 className="h-6 w-6 text-primary mx-auto mb-2" />
                  {file.name}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  <ImagePlus className="h-8 w-8 mx-auto mb-2" />
                  Tap to take a photo or select the check image / PDF
                  <div className="text-[10px] mt-1">JPG, PNG, HEIC, or PDF • up to {MAX_MB} MB</div>
                </div>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/*,application/pdf"
                capture="environment"
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ho-note">Note to contractor (optional)</Label>
              <Textarea
                id="ho-note"
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 1000))}
                placeholder="e.g. Mortgage company on the check is Wells Fargo…"
                className="min-h-[70px]"
              />
            </div>
            <Button className="w-full" size="lg" onClick={upload} disabled={!file || uploading}>
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              Send check securely
            </Button>
          </CardContent>
        </Card>

        {uploads.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your uploads</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {uploads.map((u) => (
                <div
                  key={u.id}
                  className="flex items-center justify-between text-sm border border-border rounded-md p-2"
                >
                  <div className="truncate">
                    <div className="font-mono text-xs truncate">{u.file_path.split("/").pop()}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(u.created_at).toLocaleString()}
                    </div>
                  </div>
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {u.status.replace(/_/g, " ")}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <p className="text-[10px] text-muted-foreground text-center pt-4">
          This link is private to you. Anyone with the link can view and act on this claim — treat
          it like a password. Don't share it.
        </p>
      </div>
    </Shell>
  );
}

function TimelineRow({ done, label, detail }: { done: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <div
        className={`h-5 w-5 rounded-full flex items-center justify-center mt-0.5 flex-shrink-0 ${
          done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
        }`}
      >
        {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="text-[10px]">•</span>}
      </div>
      <div className="min-w-0">
        <div className={done ? "font-medium" : "text-muted-foreground"}>{label}</div>
        <div className="text-[11px] text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link to="/find-a-pro" className="font-bold text-lg">
            ChecksOps
          </Link>
          <Badge variant="secondary" className="gap-1.5 text-[10px]">
            <ShieldCheck className="h-3 w-3" /> Homeowner portal
          </Badge>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-8">{children}</main>
    </div>
  );
}

async function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("read failed"));
    r.readAsDataURL(f);
  });
}
