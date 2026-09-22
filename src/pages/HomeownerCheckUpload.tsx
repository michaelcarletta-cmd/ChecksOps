import { useEffect, useRef, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { isAwsDataPlane, awsApiBaseUrl } from "@/lib/awsStaging";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  ShieldCheck,
  Upload,
  Loader2,
  CheckCircle2,
  ImagePlus,
  LogOut,
  Mail,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";
import { CheckImageCropper } from "@/components/checks/CheckImageCropper";

type Lead = {
  id: string;
  homeowner_name: string;
  homeowner_email: string;
  property_zip: string | null;
  loss_type: string | null;
  contractor_profile_id: string;
};

type Contractor = {
  id: string;
  display_name: string;
  bio: string | null;
  tier: string | null;
};

type Upload = {
  id: string;
  file_path: string;
  status: string;
  note: string | null;
  created_at: string;
};

type UploadSession = {
  user: { email: string };
  uploadToken?: string;
};

const MAX_MB = 15;
const AWS_UPLOAD_SESSION_KEY = "checksops.aws.homeowner.upload.session";

const awsInvoke = async (name: string, body: Record<string, unknown>, uploadToken?: string) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (uploadToken) {
    headers.authorization = `Bearer ${uploadToken}`;
    headers["x-homeowner-upload-token"] = uploadToken;
  }
  const response = await fetch(`${awsApiBaseUrl()}/functions/v1/${encodeURIComponent(name)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    throw new Error(String(data?.message || data?.error || `request_failed_${response.status}`));
  }
  return data;
};

export default function HomeownerCheckUpload() {
  const [params] = useSearchParams();
  const leadId = params.get("lead");
  const contractorParam = params.get("contractor");
  const aws = isAwsDataPlane();

  const [session, setSession] = useState<UploadSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [emailInput, setEmailInput] = useState("");
  const [otpInput, setOtpInput] = useState("");
  const [sendingLink, setSendingLink] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  const [lead, setLead] = useState<Lead | null>(null);
  const [contractor, setContractor] = useState<Contractor | null>(null);
  const [loading, setLoading] = useState(false);

  const [file, setFile] = useState<File | null>(null);
  const [pendingCrop, setPendingCrop] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = "Send your insurance check securely | ChecksOps";
  }, []);

  // Session bootstrap
  useEffect(() => {
    let mounted = true;
    if (aws) {
      try {
        const raw = sessionStorage.getItem(AWS_UPLOAD_SESSION_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (mounted) {
          setSession(parsed?.uploadToken && parsed?.user?.email ? parsed : null);
          setCheckingSession(false);
        }
      } catch {
        if (mounted) {
          setSession(null);
          setCheckingSession(false);
        }
      }
      return () => {
        mounted = false;
      };
    }

    supabase.auth.getSession().then(({ data }) => {
      if (mounted) {
        setSession(data.session as any);
        setCheckingSession(false);
      }
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s as any));
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [aws]);

  // Load lead + contractor once signed in
  useEffect(() => {
    if (!session?.user?.email) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (aws) {
          const data = await awsInvoke(
            "homeowner-upload-session",
            { action: "get" },
            (session as UploadSession).uploadToken,
          );
          if (cancelled) return;
          setLead((data.lead as Lead) || null);
          setContractor((data.contractor as Contractor) || null);
          setUploads((data.uploads as Upload[]) || []);
          // If session lacks contractor but URL has one, fetch directory detail publicly
          if (!data.contractor && (contractorParam || data.contractorProfileId)) {
            const detail = await awsInvoke("public-contractor-directory", {
              action: "detail",
              contractorId: contractorParam || data.contractorProfileId,
              email: session.user.email,
              zip: data.lead?.property_zip ?? "00000",
            });
            if (!cancelled) setContractor(((detail as any)?.profile ?? null) as Contractor | null);
          }
          return;
        }

        let l: Lead | null = null;
        if (leadId) {
          const { data } = await supabase
            .from("homeowner_intro_requests")
            .select("id, homeowner_name, homeowner_email, property_zip, loss_type, contractor_profile_id")
            .eq("id", leadId)
            .maybeSingle();
          l = data as Lead | null;
          if (l && l.homeowner_email.toLowerCase() !== session.user.email.toLowerCase()) {
            toast.error("This upload link belongs to a different email. Sign in with the address you used.");
            l = null;
          }
        }
        if (cancelled) return;
        setLead(l);

        const cid = l?.contractor_profile_id ?? contractorParam;
        if (cid) {
          const { data: c } = await supabase.functions.invoke("public-contractor-directory", {
            body: { action: "detail", contractorId: cid, email: session.user.email, zip: l?.property_zip ?? "00000" },
          });
          if (!cancelled) setContractor(((c as any)?.profile ?? null) as Contractor | null);
        }

        const { data: prev } = await supabase
          .from("homeowner_check_uploads")
          .select("id, file_path, status, note, created_at")
          .order("created_at", { ascending: false });
        if (!cancelled) setUploads((prev ?? []) as Upload[]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, leadId, contractorParam, aws]);

  const sendMagicLink = async () => {
    const em = emailInput.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
      toast.error("Enter a valid email");
      return;
    }
    setSendingLink(true);
    try {
      if (aws) {
        await awsInvoke("homeowner-upload-otp-start", {
          email: em,
          lead_id: leadId,
          contractor_profile_id: contractorParam,
        });
        setLinkSent(true);
        toast.success("Upload code sent");
        return;
      }
      const redirect = `${window.location.origin}/h/upload${window.location.search}`;
      const { error } = await supabase.auth.signInWithOtp({
        email: em,
        options: { emailRedirectTo: redirect },
      });
      if (error) throw error;
      setLinkSent(true);
    } catch (e: any) {
      toast.error(e.message ?? "Could not send link");
    } finally {
      setSendingLink(false);
    }
  };

  const verifyAwsOtp = async () => {
    const em = emailInput.trim().toLowerCase();
    const code = otpInput.trim();
    if (!/^\d{6}$/.test(code)) {
      toast.error("Enter the 6-digit code");
      return;
    }
    setVerifyingOtp(true);
    try {
      const data = await awsInvoke("homeowner-upload-otp-verify", {
        email: em,
        code,
        lead_id: leadId,
      });
      const next: UploadSession = {
        user: { email: data.email || em },
        uploadToken: data.uploadToken,
      };
      sessionStorage.setItem(AWS_UPLOAD_SESSION_KEY, JSON.stringify(next));
      setSession(next);
      setLead((data.lead as Lead) || null);
      setContractor((data.contractor as Contractor) || null);
      setUploads((data.uploads as Upload[]) || []);
      toast.success("Signed in for upload");
    } catch (e: any) {
      toast.error(e.message ?? "Invalid or expired code");
    } finally {
      setVerifyingOtp(false);
    }
  };

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
    if (f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)) {
      setPendingCrop(f);
      return;
    }
    setFile(f);
    if (f.type.startsWith("image/")) {
      const url = URL.createObjectURL(f);
      setPreview(url);
    } else {
      setPreview(null);
    }
  };

  const applyCroppedFile = (cropped: File) => {
    setFile(cropped);
    const url = URL.createObjectURL(cropped);
    setPreview(url);
  };

  const upload = async () => {
    if (!file || !contractor) return;
    setUploading(true);
    try {
      const b64 = await fileToBase64(file);
      if (aws) {
        const data = await awsInvoke(
          "homeowner-upload-check",
          {
            lead_id: lead?.id ?? null,
            contractor_profile_id: contractor.id,
            file_base64: b64,
            file_mime: file.type || "application/octet-stream",
            filename: file.name,
            note: note.trim() || undefined,
          },
          (session as UploadSession)?.uploadToken,
        );
        if ((data as any)?.error) throw new Error((data as any).error);
        const refreshed = await awsInvoke(
          "homeowner-upload-session",
          { action: "get" },
          (session as UploadSession)?.uploadToken,
        );
        setUploads((refreshed.uploads as Upload[]) || []);
      } else {
        const { data, error } = await supabase.functions.invoke("homeowner-upload-check", {
          body: {
            lead_id: lead?.id ?? null,
            contractor_profile_id: contractor.id,
            file_base64: b64,
            file_mime: file.type || "application/octet-stream",
            filename: file.name,
            note: note.trim() || undefined,
          },
        });
        if (error) throw new Error(error.message);
        if ((data as any)?.error) throw new Error((data as any).error);
        const { data: refreshed } = await supabase
          .from("homeowner_check_uploads")
          .select("id, file_path, status, note, created_at")
          .order("created_at", { ascending: false });
        setUploads((refreshed ?? []) as Upload[]);
      }

      toast.success("Check sent securely");
      setFile(null);
      setPreview(null);
      setNote("");
      if (fileInput.current) fileInput.current.value = "";
    } catch (e: any) {
      toast.error(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const signOut = async () => {
    if (aws) {
      try {
        await awsInvoke(
          "homeowner-upload-session",
          { action: "revoke" },
          (session as UploadSession)?.uploadToken,
        );
      } catch {
        /* best-effort */
      }
      sessionStorage.removeItem(AWS_UPLOAD_SESSION_KEY);
    } else {
      await supabase.auth.signOut();
    }
    setSession(null);
    setUploads([]);
    setLead(null);
    setContractor(null);
    setLinkSent(false);
    setOtpInput("");
  };

  // ----- Views -----

  if (checkingSession) {
    return (
      <Shell>
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </Shell>
    );
  }

  if (!session) {
    return (
      <Shell>
        <Card className="max-w-md mx-auto">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Secure homeowner sign-in
            </CardTitle>
            <CardDescription>
              {aws
                ? "We'll email you a one-time 6-digit code. No ChecksOps account needed — this only unlocks your upload."
                : "We'll email you a one-time link. No password needed. Only you can open your uploads."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {linkSent ? (
              <div className="text-center py-4 space-y-3">
                <Mail className="h-10 w-10 text-primary mx-auto" />
                <div className="font-semibold">{aws ? "Enter your code" : "Check your inbox"}</div>
                <p className="text-sm text-muted-foreground">
                  {aws ? (
                    <>
                      We sent a 6-digit upload code to <strong>{emailInput}</strong>. It expires in 15 minutes.
                    </>
                  ) : (
                    <>
                      We sent a sign-in link to <strong>{emailInput}</strong>. Open it on this device to continue.
                    </>
                  )}
                </p>
                {aws && (
                  <div className="space-y-2 text-left">
                    <Label htmlFor="ho-otp">Upload code</Label>
                    <Input
                      id="ho-otp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={otpInput}
                      onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="123456"
                    />
                    <Button className="w-full" onClick={verifyAwsOtp} disabled={verifyingOtp || otpInput.length !== 6}>
                      {verifyingOtp && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                      Verify and continue
                    </Button>
                  </div>
                )}
                <Button variant="outline" onClick={() => { setLinkSent(false); setOtpInput(""); }}>
                  Use a different email
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="ho-email">Your email</Label>
                  <Input
                    id="ho-email"
                    type="email"
                    autoFocus
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="you@example.com"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Use the same email you gave when you contacted the pro.
                  </p>
                </div>
                <Button className="w-full" onClick={sendMagicLink} disabled={sendingLink}>
                  {sendingLink && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  {aws ? "Send me a secure code" : "Send me a secure link"}
                </Button>
                <div className="text-center">
                  <Link to="/find-a-pro" className="text-xs text-muted-foreground underline">
                    <ArrowLeft className="h-3 w-3 inline mr-1" /> Back to directory
                  </Link>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <CheckImageCropper
        open={!!pendingCrop}
        file={pendingCrop}
        title="Crop the check"
        onCancel={() => setPendingCrop(null)}
        onConfirm={(cropped) => { setPendingCrop(null); applyCroppedFile(cropped); }}
      />
      <div className="max-w-2xl mx-auto space-y-4">

        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">Signed in as</div>
            <div className="text-sm font-medium">{session.user.email}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="h-4 w-4 mr-1" /> Sign out
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !contractor ? (
          <Card>
            <CardContent className="py-10 text-center text-muted-foreground text-sm">
              We couldn't match this link to a contractor. Start again from{" "}
              <Link to="/find-a-pro" className="underline">
                Find a Pro
              </Link>
              .
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Sending to {contractor.display_name}
                  <Badge className="gap-1 text-[10px]">
                    <ShieldCheck className="h-3 w-3" /> Verified
                  </Badge>
                </CardTitle>
                <CardDescription>
                  Your check image goes straight to this contractor through ChecksOps. They'll be notified
                  the moment it arrives.
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
                      Tap to take a photo or select an image / PDF of your insurance check
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
                  <Label htmlFor="ho-note">Anything the contractor should know? (optional)</Label>
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

                <div className="text-[11px] text-muted-foreground border border-border rounded-md p-3">
                  <strong>How this protects you:</strong> The check is stored inside ChecksOps. Endorsements
                  and deposits happen inside the platform, so every step (who signed, when, and where the
                  money went) is logged. You'll get an email as the check moves.
                </div>
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
                        <div className="font-mono text-xs truncate">
                          {u.file_path.split("/").pop()}
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {new Date(u.created_at).toLocaleString()}
                        </div>
                      </div>
                      <Badge variant="outline" className="text-[10px]">
                        {u.status}
                      </Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </>
        )}
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link to="/find-a-pro" className="flex items-center" aria-label="ChecksOps home">
            <CheckOpsLogo className="text-foreground text-xl" />
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
