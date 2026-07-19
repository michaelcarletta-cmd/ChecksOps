import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  ShieldCheck, Loader2, ImagePlus, Upload, CheckCircle2,
  Banknote, Send, PenTool, Wallet, Hammer, FileText, AlertCircle,
  Phone, Building2, MessageSquare, ChevronDown, ChevronUp, Palette, Plus,
} from "lucide-react";
import { toast } from "sonner";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";
import homeownerOpsLogo from "@/assets/homeowner-ops-logo.png";

type LedgerEvent = {
  id: string;
  check_id: string | null;
  event_type: string;
  occurred_at: string;
  amount: number | null;
  actor_label: string | null;
  payload_json: Record<string, any>;
};

type PendingSigner = {
  signer_id: string;
  name: string | null;
  email: string | null;
  status: string;
  signed_at: string | null;
  is_homeowner: boolean;
};
type PendingSignature = {
  request_id: string;
  document_name: string;
  sent_at: string | null;
  signers: PendingSigner[];
};

type PendingEndorsementParty = {
  endorsement_id: string;
  payee_name: string;
  payee_type: "insured" | "mortgage_company" | string;
  status: string;
  sent_at: string | null;
  is_homeowner: boolean;
  sign_url: string | null;
};
type PendingEndorsement = {
  check_id: string;
  check_number: string | null;
  check_amount: number | null;
  parties: PendingEndorsementParty[];
};

type Summary = {
  ok: boolean;
  mode: "claim" | "pre_claim";
  homeowner: { name: string | null; email: string | null };
  claim: { id: string; claim_number: string | null; property_address: string | null; loss_type: string | null } | null;
  events: LedgerEvent[];
  totals: { received: number; deposited: number; released: number; remaining: number };
  pending_upload_count: number;
  pending_signatures?: PendingSignature[];
  pending_endorsements?: PendingEndorsement[];
  can_upload: boolean;
};

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);

const EVENT_META: Record<string, { icon: React.ElementType; label: string; tone: string }> = {
  check_received:          { icon: Banknote,     label: "Check received",          tone: "text-emerald-400" },
  supplement_check:        { icon: Banknote,     label: "Supplement check",        tone: "text-emerald-400" },
  depreciation_check:      { icon: Banknote,     label: "Depreciation check",      tone: "text-emerald-400" },
  deductible_check:        { icon: Banknote,     label: "Deductible check",        tone: "text-emerald-400" },
  endorsement_requested:   { icon: PenTool,      label: "Signature requested",     tone: "text-amber-400"   },
  endorsement_signed:      { icon: CheckCircle2, label: "Signature collected",     tone: "text-emerald-400" },
  endorsements_sent:       { icon: Send,         label: "Signatures sent",         tone: "text-amber-400"   },
  ready_for_deposit:       { icon: CheckCircle2, label: "Ready for deposit",       tone: "text-emerald-400" },
  loss_draft_routing:      { icon: FileText,     label: "Loss draft routing",      tone: "text-amber-400"   },
  deposited:               { icon: Wallet,       label: "Deposited",               tone: "text-sky-400"     },
  cleared:                 { icon: CheckCircle2, label: "Cleared",                 tone: "text-sky-400"     },
  funds_released:          { icon: Send,         label: "Funds released",          tone: "text-primary"     },
  production_projected:    { icon: Hammer,       label: "Projected start",         tone: "text-muted-foreground" },
  production_confirmed:    { icon: Hammer,       label: "Confirmed start",         tone: "text-emerald-400" },
  production_doc_uploaded: { icon: FileText,     label: "Production doc uploaded", tone: "text-muted-foreground" },
  homeowner_check_upload:  { icon: ImagePlus,    label: "You uploaded a check",    tone: "text-primary"     },
  homeowner_upload_attached:{ icon: ImagePlus,   label: "Upload attached to claim",tone: "text-primary"     },
  document_sent:           { icon: Send,         label: "Document sent",           tone: "text-amber-400"   },
  document_uploaded:       { icon: Upload,       label: "Document uploaded",       tone: "text-primary"     },
  document_signed_all:     { icon: CheckCircle2, label: "Document fully signed",   tone: "text-emerald-400" },
  mortgage_check_sent:     { icon: Send,         label: "Check sent to mortgage",  tone: "text-amber-400"   },
  mortgage_check_returned: { icon: CheckCircle2, label: "Endorsed check returned", tone: "text-emerald-400" },
  mortgage_followup:       { icon: Phone,        label: "Call to mortgage",        tone: "text-sky-400"     },
  mortgage_update:         { icon: Building2,    label: "Mortgage Ops update",     tone: "text-sky-400"     },
  contractor_upload:       { icon: Upload,       label: "Contractor uploaded",     tone: "text-primary"     },
  ops_note:                { icon: MessageSquare,label: "Team update",             tone: "text-muted-foreground" },
  selection_request:       { icon: Palette,      label: "Selections requested",    tone: "text-amber-400"   },
  selection_completed:     { icon: CheckCircle2, label: "Selections submitted",    tone: "text-emerald-400" },
};

const FALLBACK_META = { icon: FileText, label: "Update", tone: "text-muted-foreground" };

export default function HomeownerLedger({ preClaim = false }: { preClaim?: boolean }) {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = preClaim ? "Send your check | ChecksOps" : "Your claim ledger | ChecksOps";
  }, [preClaim]);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const { data: res, error: e } = await supabase.functions.invoke("homeowner-ledger-view", {
        body: { token },
      });
      if (e) throw e;
      if ((res as any)?.error) throw new Error((res as any).error);
      setData(res as Summary);
    } catch (e: any) {
      setError(e.message || "Could not load ledger");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [token]);

  if (loading) {
    return <Shell><div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div></Shell>;
  }
  if (error || !data) {
    return (
      <Shell>
        <Card className="max-w-md mx-auto">
          <CardContent className="py-10 text-center space-y-3">
            <AlertCircle className="h-8 w-8 text-destructive mx-auto" />
            <div className="font-semibold">This link isn't working</div>
            <p className="text-sm text-muted-foreground">
              {error === "revoked" ? "Your claim team has ended access to this link." :
               error === "expired" ? "This link has expired. Ask your claim team for a new one." :
               "Ask your claim team to resend your ledger link."}
            </p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="max-w-2xl mx-auto space-y-4">
        {data.mode === "claim" ? (
          <ClaimView data={data} onRefresh={load} token={token!} />
        ) : (
          <PreClaimView token={token!} homeowner={data.homeowner} pending={data.pending_upload_count} onRefresh={load} />
        )}
      </div>
    </Shell>
  );
}

function ClaimView({ data, onRefresh, token }: { data: Summary; onRefresh: () => void; token: string }) {
  const groups = useMemo(() => groupByCheck(data.events), [data.events]);

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Your claim ledger</span>
            <Badge variant="secondary" className="gap-1 text-[10px]">
              <ShieldCheck className="h-3 w-3" /> Private
            </Badge>
          </CardTitle>
          {data.claim && (
            <div className="text-xs text-muted-foreground">
              {data.claim.claim_number ? `Claim #${data.claim.claim_number}` : "Claim"}
              {data.claim.property_address ? ` • ${data.claim.property_address}` : ""}
            </div>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <TotalTile label="Received"  value={data.totals.received}  tone="text-emerald-400" />
            <TotalTile label="Deposited" value={data.totals.deposited} tone="text-sky-400" />
            <TotalTile label="Released"  value={data.totals.released}  tone="text-primary" />
            <TotalTile label="Remaining" value={data.totals.remaining} tone="text-foreground" highlight />
          </div>
        </CardContent>
      </Card>

      <CollapsibleUpload token={token} onDone={onRefresh} />

      <PendingEndorsementsPanel pending={data.pending_endorsements ?? []} />
      <PendingSignaturesPanel token={token} pending={data.pending_signatures ?? []} />


      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Timeline</CardTitle></CardHeader>
        <CardContent className="space-y-6">
          {groups.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-8">
              Nothing here yet. As soon as a check lands, you'll see it appear.
            </div>
          )}
          {groups.map((g, gi) => (
            <div key={g.key} className="relative">
              {g.checkLabel && (
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  {g.checkLabel}
                </div>
              )}
              <ol className="relative border-l border-border ml-2 space-y-4">
                {g.events.map((e) => {
                  const meta = EVENT_META[e.event_type] ?? FALLBACK_META;
                  const Icon = meta.icon;
                  return (
                    <li key={e.id} className="ml-4">
                      <span className="absolute -left-[9px] flex h-4 w-4 items-center justify-center rounded-full bg-background border border-border">
                        <Icon className={`h-3 w-3 ${meta.tone}`} />
                      </span>
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="text-sm font-medium">{meta.label}</div>
                        {e.amount != null && (
                          <div className={`text-sm font-semibold ${meta.tone}`}>{fmt(Number(e.amount))}</div>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {new Date(e.occurred_at).toLocaleString()}
                        {e.actor_label ? ` • ${e.actor_label}` : ""}
                        {e.payload_json?.check_number ? ` • #${e.payload_json.check_number}` : ""}
                        {e.payload_json?.recipient_type ? ` • ${e.payload_json.recipient_type}` : ""}
                      </div>
                      {(e.payload_json?.note || e.payload_json?.document_label) && (
                        <div className="mt-1 text-xs text-foreground/90 bg-muted/40 rounded px-2 py-1 whitespace-pre-wrap">
                          {e.payload_json?.document_label && (
                            <div className="font-medium">{e.payload_json.document_label}{e.payload_json?.file_name ? ` — ${e.payload_json.file_name}` : ""}</div>
                          )}
                          {e.payload_json?.note && <div>{e.payload_json.note}</div>}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
              {gi < groups.length - 1 && <div className="border-t border-border/50 mt-4" />}
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="text-[11px] text-muted-foreground text-center pb-6">
        This page updates automatically as your claim progresses. Bookmark it.
      </div>
    </>
  );
}

function CollapsibleUpload({ token, onDone }: { token: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/40 transition-colors rounded-t-lg"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <Plus className="h-4 w-4 text-primary" />
          Send a new check or document
        </span>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && (
        <div className="border-t border-border">
          <UploadPanel token={token} onDone={() => { onDone(); setOpen(false); }} hideHeader />
        </div>
      )}
    </Card>
  );
}


function PreClaimView({ token, homeowner, pending, onRefresh }: {
  token: string; homeowner: { name: string | null; email: string | null }; pending: number; onRefresh: () => void;
}) {
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Start your claim</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>
            Hi {homeowner.name || "there"} — upload the front and back of your insurance check
            below. Our team will attach it to your claim within one business day.
          </p>
          {pending > 0 && (
            <div className="text-xs bg-muted rounded p-2">
              {pending} upload{pending === 1 ? "" : "s"} pending review.
            </div>
          )}
        </CardContent>
      </Card>
      <UploadPanel token={token} onDone={onRefresh} preClaim />
    </>
  );
}

function PendingEndorsementsPanel({ pending }: { pending: PendingEndorsement[] }) {
  if (!pending || pending.length === 0) return null;
  const partyLabel = (t: string) => t === "mortgage_company" ? "Mortgage company" : t === "insured" ? "Homeowner" : t;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <PenTool className="h-4 w-4 text-amber-400" /> Checks awaiting signature
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {pending.map((chk) => (
          <div key={chk.check_id} className="rounded-lg border border-border p-3 space-y-2">
            <div className="text-sm font-medium">
              Check {chk.check_number ? `#${chk.check_number}` : ""}
              {chk.check_amount != null && <span className="text-muted-foreground"> — {fmt(Number(chk.check_amount))}</span>}
            </div>
            <ul className="space-y-1.5">
              {chk.parties.map((p) => (
                <li key={p.endorsement_id} className="flex items-center justify-between gap-2 text-xs rounded bg-muted/40 px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {partyLabel(p.payee_type)}
                      <span className="text-muted-foreground font-normal"> · {p.payee_name}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      {p.sent_at ? `Requested ${new Date(p.sent_at).toLocaleDateString()}` : "Awaiting request"}
                    </div>
                  </div>
                  {p.sign_url ? (
                    <Button size="sm" className="h-7 px-2 text-[11px] shrink-0" onClick={() => { window.location.href = p.sign_url!; }}>
                      Sign now
                    </Button>
                  ) : (
                    <Badge variant="secondary" className="text-[10px] shrink-0">
                      {p.payee_type === "mortgage_company" ? "Handled by mortgage" : "Awaiting signature"}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PendingSignaturesPanel({ token, pending }: { token: string; pending: PendingSignature[] }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  if (!pending || pending.length === 0) return null;

  const openSignLink = async (signerId: string) => {
    setBusyId(signerId);
    try {
      const { data, error } = await supabase.functions.invoke("homeowner-ledger-sign-link", {
        body: { token, signer_id: signerId },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      const url = (data as any)?.sign_url;
      if (!url) throw new Error("No sign link returned");
      window.location.href = url;
    } catch (e: any) {
      toast.error(e.message || "Could not open signing page");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <PenTool className="h-4 w-4 text-amber-400" /> Signatures
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending.map((r) => (
          <div key={r.request_id} className="rounded-lg border border-border p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{r.document_name}</div>
                {r.sent_at && (
                  <div className="text-[11px] text-muted-foreground">
                    Sent {new Date(r.sent_at).toLocaleString()}
                  </div>
                )}
              </div>
              <Badge variant="secondary" className="text-[10px]">Awaiting signatures</Badge>
            </div>
            <ul className="space-y-1.5">
              {r.signers.map((s) => (
                <li key={s.signer_id} className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    {s.status === "signed" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <PenTool className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                    )}
                    <span className="truncate">
                      {s.name || s.email}
                      {s.is_homeowner ? " (you)" : ""}
                    </span>
                  </div>
                  {s.status === "signed" ? (
                    <span className="text-[10px] text-emerald-400">Signed</span>
                  ) : s.is_homeowner ? (
                    <Button
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={busyId === s.signer_id}
                      onClick={() => openSignLink(s.signer_id)}
                    >
                      {busyId === s.signer_id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Sign now"}
                    </Button>
                  ) : (
                    <span className="text-[10px] text-muted-foreground">Pending</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function TotalTile({ label, value, tone, highlight }: { label: string; value: number; tone: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-3 ${highlight ? "border-primary/50 bg-primary/5" : "border-border"}`}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold mt-1 ${tone}`}>{fmt(value)}</div>
    </div>
  );
}

function UploadPanel({ token, onDone, preClaim, hideHeader }: { token: string; onDone: () => void; preClaim?: boolean; hideHeader?: boolean }) {
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"check" | "production_doc">("check");
  const fInput = useRef<HTMLInputElement>(null);
  const bInput = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!front) { toast.error("Add the front image"); return; }
    setBusy(true);
    try {
      const front_base64 = await fileToBase64(front);
      const back_base64 = back ? await fileToBase64(back) : undefined;
      const { data, error } = await supabase.functions.invoke("homeowner-ledger-upload", {
        body: {
          token,
          kind,
          front_base64, front_mime: front.type, front_filename: front.name,
          back_base64, back_mime: back?.type, back_filename: back?.name,
          amount_estimate: amount ? Number(amount) : undefined,
          homeowner_note: note || undefined,
        },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(kind === "check" ? "Check sent to your team" : "Document uploaded");
      setFront(null); setBack(null); setAmount(""); setNote("");
      if (fInput.current) fInput.current.value = "";
      if (bInput.current) bInput.current.value = "";
      onDone();
    } catch (e: any) {
      toast.error(e.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const inner = (
    <>
      {!hideHeader && (
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {preClaim ? "Upload your check" : "Send a new check or document"}
          </CardTitle>
        </CardHeader>
      )}
      <CardContent className="space-y-3">
        {!preClaim && (
          <div className="flex gap-2 text-xs">
            <Button size="sm" variant={kind === "check" ? "default" : "outline"} onClick={() => setKind("check")}>New check</Button>
            <Button size="sm" variant={kind === "production_doc" ? "default" : "outline"} onClick={() => setKind("production_doc")}>Production doc</Button>
          </div>
        )}
        <FilePicker label={kind === "check" ? "Front of check" : "Document"} file={front} onPick={setFront} inputRef={fInput} />
        {kind === "check" && (
          <FilePicker label="Back of check (optional)" file={back} onPick={setBack} inputRef={bInput} />
        )}
        {kind === "check" && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="amt" className="text-xs">Amount (optional)</Label>
              <Input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
          </div>
        )}
        <div className="space-y-1">
          <Label htmlFor="nt" className="text-xs">Note (optional)</Label>
          <Textarea id="nt" value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} className="min-h-[60px]" />
        </div>
        <Button className="w-full" size="lg" onClick={submit} disabled={busy || !front}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}
          Send securely
        </Button>
      </CardContent>
    </>
  );

  return hideHeader ? <div>{inner}</div> : <Card>{inner}</Card>;
}

function FilePicker({ label, file, onPick, inputRef }: {
  label: string; file: File | null; onPick: (f: File | null) => void;
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div
      className="border-2 border-dashed border-border rounded-lg p-4 text-center cursor-pointer hover:border-primary transition-colors"
      onClick={() => inputRef.current?.click()}
    >
      {file ? (
        <div className="text-sm flex items-center justify-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-primary" /> {file.name}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          <ImagePlus className="h-6 w-6 mx-auto mb-1" />
          Tap to add {label.toLowerCase()}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <img
            src={homeownerOpsLogo.url}
            alt="Homeowner Ops"
            className="h-12 sm:h-16 w-auto object-contain"
          />
          <Badge variant="secondary" className="gap-1.5 text-[10px] shrink-0">
            <ShieldCheck className="h-3 w-3" /> Homeowner
          </Badge>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}

function groupByCheck(events: LedgerEvent[]) {
  const map = new Map<string, { key: string; checkLabel: string | null; events: LedgerEvent[] }>();
  for (const e of events) {
    const key = e.check_id ?? `_${e.event_type}_${e.id}`;
    if (!map.has(key)) {
      let label: string | null = null;
      if (e.check_id) {
        const num = e.payload_json?.check_number;
        label = num ? `Check #${num}` : "Check";
      }
      map.set(key, { key, checkLabel: label, events: [] });
    }
    map.get(key)!.events.push(e);
  }
  return Array.from(map.values());
}

async function fileToBase64(f: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(new Error("read failed"));
    r.readAsDataURL(f);
  });
}
