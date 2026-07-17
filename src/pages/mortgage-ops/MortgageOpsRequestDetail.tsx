import { useEffect, useState, useCallback } from "react";
import { mortgageSupabase as supabase } from "@/integrations/supabase/mortgageClient";
import { useMortgageAuth } from "@/hooks/useMortgageAuth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { FieldPlacementEditor } from "@/components/claim-detail/FieldPlacementEditor";
import { toast } from "sonner";
import {
  Loader2,
  Send,
  FileText,
  Upload,
  Download,
  CheckCircle2,
  Building2,
  Home,
  User,
  DollarSign,
  Calendar,
  Hash,
  Phone,
  Mail,
  MapPin,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { SendCheckTrackingLinkButton } from "@/components/homeowner-ledger/SendCheckTrackingLinkButton";
import { LossDraftDocsManager } from "@/components/loss-draft/LossDraftDocsManager";


interface Props {
  requestId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction?: () => void;
}

interface CheckRow {
  id: string;
  tenant_id: string | null;
  claim_id: string | null;
  amount: number | null;
  check_number: string | null;
  carrier_name: string | null;
  payee_line: string | null;
  payee_address: string | null;
  property_address: string | null;
  issue_date: string | null;
  detected_claim_number: string | null;
  front_image_path: string | null;
  back_image_path: string | null;
  status: string | null;
  check_stage: string | null;
  funds_type: string | null;
  routing_number: string | null;
  account_number: string | null;
}

interface RequestRow {
  id: string;
  tenant_id: string;
  check_intake_item_id: string | null;
  claim_id: string | null;
  mortgage_company: string | null;
  mortgage_servicer: string | null;
  loan_number: string | null;
  status: string;
  note: string | null;
  work_notes: string | null;
  created_at: string;
  accepted_at: string | null;
  assigned_employee_id: string | null;
  policy_number: string | null;
  claim_number: string | null;
  insurance_company: string | null;
  loss_type: string | null;
  date_of_loss: string | null;
  homeowner_name: string | null;
  homeowner_email: string | null;
  homeowner_phone: string | null;
  homeowner_ssn_last_four: string | null;
  property_address: string | null;
  endorsement_order?: number | null;
  total_mortgagees?: number | null;
  predecessor_request_id?: string | null;
  check_sent_date?: string | null;
  check_received_back_date?: string | null;
}

interface SiblingRequestRow {
  id: string;
  mortgage_company: string | null;
  status: string;
  endorsement_order: number | null;
  check_sent_date: string | null;
  check_received_back_date: string | null;
  completed_at: string | null;
}


interface ClaimRow {
  id: string;
  claim_number: string | null;
  policyholder_name: string | null;
  policyholder_email: string | null;
  policyholder_phone: string | null;
  policyholder_address: string | null;
  loss_type: string | null;
  loss_date: string | null;
  loss_description: string | null;
  insurance_company: string | null;
  adjuster_name: string | null;
  adjuster_phone: string | null;
  adjuster_email: string | null;
  loan_number: string | null;
  policy_number: string | null;
}

interface CheckFileRow {
  id: string;
  file_name: string;
  file_path: string;
  category: string | null;
  description: string | null;
  created_at: string;
}

interface LossDraftDoc {
  id: string;
  document_type: string;
  document_label: string;
  is_required: boolean;
  is_submitted: boolean;
  submitted_at: string | null;
  file_id: string | null;
  notes: string | null;
  file_path: string | null;
  file_name: string | null;
  signature_request_id: string | null;
  is_template_generated: boolean | null;
}

interface MessageRow {
  id: string;
  sender_id: string;
  body: string;
  created_at: string;
  is_deleted: boolean;
}

interface SigSigner {
  id: string;
  signer_name: string;
  signer_email: string;
  signer_type: string;
  status: string;
  signed_at: string | null;
  viewed_at: string | null;
  delivery_status: string | null;
}

interface SigRequest {
  id: string;
  document_name: string;
  document_path: string;
  status: string;
  created_at: string;
  signature_signers: SigSigner[];
}

interface TenantRow { id: string; name: string | null; }

export function MortgageOpsRequestDetail({ requestId, open, onOpenChange, onAction }: Props) {
  const { user } = useMortgageAuth();
  const [loading, setLoading] = useState(false);
  const [req, setReq] = useState<RequestRow | null>(null);
  const [check, setCheck] = useState<CheckRow | null>(null);
  const [claim, setClaim] = useState<ClaimRow | null>(null);
  const [tenant, setTenant] = useState<TenantRow | null>(null);
  const [images, setImages] = useState<{ front?: string; back?: string }>({});
  const [files, setFiles] = useState<CheckFileRow[]>([]);
  const [lossDocs, setLossDocs] = useState<LossDraftDoc[]>([]);
  const [lossDraftId, setLossDraftId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [sigRequests, setSigRequests] = useState<SigRequest[]>([]);
  const [siblings, setSiblings] = useState<SiblingRequestRow[]>([]);
  const [savingDates, setSavingDates] = useState(false);
  const [draft, setDraft] = useState("");

  const [posting, setPosting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadDesc, setUploadDesc] = useState("");
  const [uploadForSignature, setUploadForSignature] = useState(true);

  const [updateKind, setUpdateKind] = useState<"mortgage_followup" | "mortgage_update">("mortgage_followup");
  const [updateNote, setUpdateNote] = useState("");
  const [postingUpdate, setPostingUpdate] = useState(false);

  // Field-placement flow (mirrors Freedom CRM's SignatureRequests dialog).
  // When a signature PDF is uploaded, we hold it here and show the placer
  // dialog before actually dispatching the e-sign request.
  const [placerOpen, setPlacerOpen] = useState(false);
  const [pendingDoc, setPendingDoc] = useState<{
    path: string;
    url: string;
    fileName: string;
    lossDraftDocId?: string;
    documentLabel?: string;
  } | null>(null);
  const [placedFields, setPlacedFields] = useState<any[]>([]);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!requestId) return;
    setLoading(true);
    try {
      const { data: r, error: rErr } = await supabase
        .from("mortgage_handling_requests")
        .select("*")
        .eq("id", requestId)
        .maybeSingle();
      if (rErr || !r) throw rErr || new Error("not found");
      setReq(r as RequestRow);

      const tenantP = supabase.from("tenants").select("id,name").eq("id", r.tenant_id).maybeSingle();
      const checkP = r.check_intake_item_id
        ? supabase
            .from("check_intake_items")
            .select(
              "id,tenant_id,claim_id,amount,check_number,carrier_name,payee_line,payee_address,property_address,issue_date,detected_claim_number,front_image_path,back_image_path,status,check_stage,funds_type,routing_number,account_number"
            )
            .eq("id", r.check_intake_item_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null } as any);
      const claimP = r.claim_id
        ? supabase
            .from("claims")
            .select(
              "id,claim_number,policyholder_name,policyholder_email,policyholder_phone,policyholder_address,loss_type,loss_date,loss_description,insurance_company,adjuster_name,adjuster_phone,adjuster_email,loan_number,policy_number"
            )
            .eq("id", r.claim_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null } as any);

      const [tRes, cRes, clRes] = await Promise.all([tenantP, checkP, claimP]);
      setTenant((tRes.data as TenantRow) || null);
      setCheck((cRes.data as CheckRow) || null);
      setClaim((clRes.data as ClaimRow) || null);

      if (r.check_intake_item_id) {
        // Signed image URLs
        const { data: img } = await supabase.functions.invoke("get-check-image-urls", {
          body: { check_id: r.check_intake_item_id },
        });
        if (img?.front_url || img?.back_url) {
          setImages({ front: img.front_url, back: img.back_url });
        } else {
          setImages({});
        }

        const { data: fRows } = await supabase
          .from("check_files")
          .select("id,file_name,file_path,category,description,created_at")
          .eq("check_intake_item_id", r.check_intake_item_id)
          .order("created_at", { ascending: false });
        setFiles((fRows as CheckFileRow[]) || []);

        // Loss draft docs
        const { data: ldt } = await supabase
          .from("loss_draft_tracking")
          .select("id")
          .eq("check_intake_item_id", r.check_intake_item_id)
          .maybeSingle();
        if (ldt?.id) {
          setLossDraftId(ldt.id);
          const { data: docs } = await supabase
            .from("loss_draft_documents")
            .select("id,document_type,document_label,is_required,is_submitted,submitted_at,file_id,notes,file_path,file_name,signature_request_id,is_template_generated" as any)
            .eq("loss_draft_id", ldt.id)
            .order("created_at", { ascending: true });
          setLossDocs((docs as unknown as LossDraftDoc[]) || []);
        } else {
          setLossDraftId(null);
          setLossDocs([]);
        }

        const { data: msgs } = await supabase
          .from("check_messages")
          .select("id,sender_id,body,created_at,is_deleted")
          .eq("check_id", r.check_intake_item_id)
          .order("created_at", { ascending: true });
        setMessages(((msgs as MessageRow[]) || []).filter((m) => !m.is_deleted));
      }

      // Signature requests for this claim
      if (r.claim_id) {
        const { data: sigs } = await supabase
          .from("signature_requests")
          .select("id,document_name,document_path,status,created_at,signature_signers(id,signer_name,signer_email,signer_type,status,signed_at,viewed_at,delivery_status)")
          .eq("claim_id", r.claim_id)
          .order("created_at", { ascending: false });
        setSigRequests((sigs as SigRequest[]) || []);
      } else {
        setSigRequests([]);
      }

      // Sibling mortgage requests on the same check (two-mortgagee sequencing)
      if (r.check_intake_item_id) {
        const { data: sibs } = await supabase
          .from("mortgage_handling_requests")
          .select("id,mortgage_company,status,endorsement_order,check_sent_date,check_received_back_date,completed_at" as any)
          .eq("check_intake_item_id", r.check_intake_item_id)
          .order("created_at", { ascending: true });
        setSiblings(((sibs as any[]) || []) as SiblingRequestRow[]);
      } else {
        setSiblings([]);
      }

    } catch (e: any) {
      toast.error(e?.message || "Failed to load request");
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    if (open && requestId) void load();
  }, [open, requestId, load]);

  // Realtime subscribe to messages
  useEffect(() => {
    if (!open || !check?.id) return;
    const ch = supabase
      .channel(`mops-msg-${check.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "check_messages", filter: `check_id=eq.${check.id}` },
        () => void load()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [open, check?.id, load]);

  const postMessage = async () => {
    if (!draft.trim() || !check?.id || !user?.id) return;
    setPosting(true);
    const { error } = await supabase.from("check_messages").insert({
      check_id: check.id,
      sender_id: user.id,
      body: draft.trim(),
    });
    setPosting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setDraft("");
    toast.success("Update sent to tenant");
    void load();
  };

  const uploadDoc = async (file: File) => {
    if (!check?.id || !user?.id) return;
    setUploading(true);
    try {
      const path = `checks/${check.id}/mortgage-ops/${Date.now()}-${file.name.replace(/[^a-z0-9.\-_]/gi, "_")}`;
      const { error: upErr } = await supabase.storage
        .from("claim-files")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;

      const { error: insErr } = await supabase.from("check_files").insert({
        check_intake_item_id: check.id,
        file_name: file.name,
        file_path: path,
        file_type: file.type,
        file_size: file.size,
        category: uploadForSignature ? "mortgage_ops_signature" : "mortgage_ops",
        source: "mortgage_ops",
        uploaded_by: user.id,
        description: uploadDesc || null,
      });
      if (insErr) throw insErr;

      const homeownerEmail = req?.homeowner_email || claim?.policyholder_email;
      const homeownerName = req?.homeowner_name || claim?.policyholder_name;
      const isPdf = /\.pdf$/i.test(file.name);

      // Signature PDF with a valid homeowner recipient → open the field
      // placer instead of dispatching immediately. Same UX as Freedom CRM.
      if (uploadForSignature && req?.claim_id && homeownerEmail && homeownerName && isPdf) {
        const { data: signed } = await supabase.storage
          .from("claim-files")
          .createSignedUrl(path, 3600);
        if (signed?.signedUrl) {
          setPendingDoc({ path, url: signed.signedUrl, fileName: file.name });
          setPlacedFields([]);
          setPlacerOpen(true);
          toast.success("Document uploaded — place signature fields, then send.");
          setUploadDesc("");
          void load();
          return;
        }
      }

      // Non-PDF / no homeowner / not-for-signature → attach + notify tenant.
      await supabase.from("check_messages").insert({
        check_id: check.id,
        sender_id: user.id,
        body: uploadForSignature
          ? `📄 Mortgage Ops uploaded a document for homeowner signature: "${file.name}"${uploadDesc ? ` — ${uploadDesc}` : ""}. ${req?.claim_id ? "Missing homeowner email or non-PDF — please route via your signature workflow." : "Please forward to the homeowner via your signature workflow."}`
          : `📎 Mortgage Ops attached a document: "${file.name}"${uploadDesc ? ` — ${uploadDesc}` : ""}.`,
      });

      setUploadDesc("");
      toast.success("Document uploaded");
      void load();
    } catch (e: any) {
      toast.error(e?.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const sendPlacedSignatureRequest = async () => {
    if (!pendingDoc || !check?.id || !user?.id || !req?.claim_id) return;
    const homeownerEmail = req?.homeowner_email || claim?.policyholder_email;
    const homeownerName = req?.homeowner_name || claim?.policyholder_name;
    if (!homeownerEmail || !homeownerName) {
      toast.error("Missing homeowner email or name");
      return;
    }
    setSending(true);
    try {
      const { data: sigReq, error: sigErr } = await supabase
        .from("signature_requests")
        .insert({
          claim_id: req.claim_id,
          check_intake_item_id: check?.id ?? null,
          document_name: pendingDoc.fileName,
          document_path: pendingDoc.path,
          document_type: "authorization",
          field_data: placedFields as any,
          status: "draft",
        })
        .select("id")
        .single();
      if (sigErr || !sigReq?.id) throw sigErr || new Error("Failed to create signature request");

      // Link the source attachment row (the unsigned upload) to this request
      // so completion can drop the SIGNED PDF into the same Attachments list.
      if (check?.id) {
        await supabase
          .from("check_files")
          .update({ signature_request_id: sigReq.id })
          .eq("check_intake_item_id", check.id)
          .eq("file_path", pendingDoc.path);
      }

      const { error: signerErr } = await supabase.from("signature_signers").insert({
        signature_request_id: sigReq.id,
        signer_name: homeownerName,
        signer_email: homeownerEmail,
        signer_type: "policyholder",
        signing_order: 1,
      });
      if (signerErr) throw signerErr;

      const { error: sendErr } = await supabase.functions.invoke("send-signature-request", {
        body: { requestId: sigReq.id, skipEmail: false, senderOverride: "checksops" },
      });
      if (sendErr) throw sendErr;

      // If this document was generated/attached from the loss-draft docs list,
      // link the signature request back so status shows on the doc row.
      if (pendingDoc.lossDraftDocId) {
        await supabase
          .from("loss_draft_documents")
          .update({ signature_request_id: sigReq.id } as any)
          .eq("id", pendingDoc.lossDraftDocId);
      }

      await supabase.from("check_messages").insert({
        check_id: check.id,
        sender_id: user.id,
        body: `📄 Mortgage Ops sent "${pendingDoc.fileName}" to ${homeownerName} (${homeownerEmail}) for e-signature with ${placedFields.length} placed field${placedFields.length === 1 ? "" : "s"}. Status will update in the Signature requests panel.`,
      });

      toast.success("Sent to homeowner for signature");
      setPlacerOpen(false);
      setPendingDoc(null);
      setPlacedFields([]);
      void load();
    } catch (e: any) {
      toast.error(e?.message || "Failed to send for signature");
    } finally {
      setSending(false);
    }
  };

  const downloadFile = async (path: string, name: string) => {
    const { data, error } = await supabase.storage
      .from("claim-files")
      .createSignedUrl(path, 300, { download: name });
    if (error || !data?.signedUrl) {
      toast.error("Could not open file");
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener");
  };

  const updateEndorsementDate = async (field: "check_sent_date" | "check_received_back_date") => {
    if (!req?.id) return;
    setSavingDates(true);
    const patch: any = { [field]: new Date().toISOString() };
    const { error } = await supabase
      .from("mortgage_handling_requests")
      .update(patch)
      .eq("id", req.id);
    setSavingDates(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(field === "check_sent_date" ? "Marked check sent to mortgage" : "Marked check received back");
    void load();
    onAction?.();
  };

  const postMortgageUpdate = async () => {
    if (!req?.claim_id || !updateNote.trim()) {
      toast.error("Add a note first");
      return;
    }
    setPostingUpdate(true);
    const { error } = await supabase.from("homeowner_ledger_events").insert({
      tenant_id: req.tenant_id,
      claim_id: req.claim_id,
      event_type: updateKind,
      occurred_at: new Date().toISOString(),
      actor_label: updateKind === "mortgage_followup"
        ? `Called ${req.mortgage_company || "mortgage company"}`
        : "Mortgage Ops update",
      payload_json: { note: updateNote.trim(), mortgage_company: req.mortgage_company },
      created_by: user?.id ?? null,
    } as any);
    setPostingUpdate(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setUpdateNote("");
    toast.success("Posted to homeowner timeline");
    onAction?.();
  };


  // Two-mortgagee sequencing (mirrors Loss Draft banner)
  const isMulti = (req?.total_mortgagees ?? 0) === 2 || siblings.length >= 2;
  const myOrder = req?.endorsement_order ?? null;
  const firstSibling = siblings.find((s) => s.endorsement_order === 1) || (siblings.length >= 2 ? siblings[0] : null);
  const firstReturned = !!firstSibling?.check_received_back_date;


  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-primary" />
            Mortgage Handling Request
          </SheetTitle>
        </SheetHeader>

        {loading || !req ? (
          <div className="py-16 flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="mt-4 space-y-5">
            {/* Header block */}
            <Card>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold">
                    {req.mortgage_company || req.mortgage_servicer || "Mortgage company"}
                  </div>
                  <Badge variant={req.status === "requested" ? "default" : "secondary"}>
                    {req.status}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground">
                  Tenant: <span className="font-medium text-foreground">{tenant?.name || req.tenant_id.slice(0, 8)}</span>
                  {" · "}Requested {formatDistanceToNow(new Date(req.created_at), { addSuffix: true })}
                </div>
                {req.loan_number && (
                  <div className="text-sm"><Hash className="h-3 w-3 inline mr-1" />Loan #: <span className="font-medium">{req.loan_number}</span></div>
                )}
                {req.note && (
                  <div className="text-xs bg-muted/40 rounded p-2 whitespace-pre-wrap">
                    <span className="text-muted-foreground">Tenant note: </span>{req.note}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Two-mortgagee sequencing banner */}
            {isMulti && (
              <Card className={
                myOrder === 2 && !firstReturned
                  ? "border-amber-500/40 bg-amber-500/5"
                  : "border-blue-500/40 bg-blue-500/5"
              }>
                <CardContent className="pt-4 space-y-2 text-sm">
                  <div className="font-semibold flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    {myOrder === 1
                      ? "1st of 2 mortgagees on this check"
                      : myOrder === 2
                      ? "2nd of 2 mortgagees on this check"
                      : "Two mortgagees on this check"}
                  </div>
                  {myOrder === 1 && (
                    <div className="text-xs text-muted-foreground">
                      Send this check to the 1st mortgagee for endorsement. Once endorsed and returned, forward it to the 2nd mortgagee.
                    </div>
                  )}
                  {myOrder === 2 && !firstReturned && (
                    <div className="text-xs text-amber-500">
                      ⏳ Waiting on 1st mortgagee{firstSibling?.mortgage_company ? ` (${firstSibling.mortgage_company})` : ""} to endorse and return the check before sending here.
                    </div>
                  )}
                  {myOrder === 2 && firstReturned && (
                    <div className="text-xs text-emerald-500">
                      ✅ 1st mortgagee returned the endorsed check — ready to send to this mortgagee.
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 pt-2 text-xs">
                    <div>
                      <div className="text-muted-foreground">Check sent to mortgagee</div>
                      <div className="font-medium">
                        {req.check_sent_date ? format(new Date(req.check_sent_date), "MMM d, yyyy") : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Endorsed check received back</div>
                      <div className="font-medium">
                        {req.check_received_back_date ? format(new Date(req.check_received_back_date), "MMM d, yyyy") : "—"}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={savingDates || !!req.check_sent_date || (myOrder === 2 && !firstReturned)}
                      onClick={() => updateEndorsementDate("check_sent_date")}
                    >
                      <Send className="h-3 w-3 mr-1" />
                      Mark check sent
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={savingDates || !req.check_sent_date || !!req.check_received_back_date}
                      onClick={() => updateEndorsementDate("check_received_back_date")}
                    >
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Mark received back
                    </Button>
                  </div>
                  {siblings.length > 0 && (
                    <div className="pt-2 space-y-1">
                      {siblings.map((s) => (
                        <div key={s.id} className="text-[11px] flex items-center justify-between gap-2 border-t border-border/40 pt-1">
                          <span className="truncate">
                            <span className="text-muted-foreground">{s.endorsement_order === 1 ? "1st" : s.endorsement_order === 2 ? "2nd" : "•"}:</span>{" "}
                            <span className="font-medium">{s.mortgage_company || "Mortgage"}</span>
                            {s.id === req.id && <span className="ml-1 text-primary">(this request)</span>}
                          </span>
                          <span className="text-muted-foreground">
                            {s.check_received_back_date
                              ? "returned"
                              : s.check_sent_date
                              ? "sent"
                              : s.status}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}


            {/* Log update to homeowner timeline */}
            {req.claim_id && (
              <Card>
                <CardContent className="pt-4 space-y-2">
                  <div className="font-semibold text-sm flex items-center gap-2">
                    <FileText className="h-4 w-4" /> Log update to homeowner timeline
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Post a note the homeowner (and contractor) will see on their live claim timeline.
                  </p>
                  <div className="flex gap-1.5 flex-wrap">
                    <Button
                      type="button"
                      size="sm"
                      variant={updateKind === "mortgage_followup" ? "default" : "outline"}
                      className="h-7 text-xs"
                      onClick={() => setUpdateKind("mortgage_followup")}
                    >
                      <Phone className="h-3 w-3 mr-1" /> Call to mortgage
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={updateKind === "mortgage_update" ? "default" : "outline"}
                      className="h-7 text-xs"
                      onClick={() => setUpdateKind("mortgage_update")}
                    >
                      <Send className="h-3 w-3 mr-1" /> General update
                    </Button>
                  </div>
                  <Textarea
                    value={updateNote}
                    onChange={(e) => setUpdateNote(e.target.value)}
                    placeholder={updateKind === "mortgage_followup"
                      ? "e.g. Spoke with Sarah at ServiceMac — TPA received, waiting on inspection."
                      : "e.g. Sent endorsed check + waiver of lien to mortgage overnight."}
                    rows={2}
                    className="text-sm"
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-7 text-xs"
                      disabled={postingUpdate || !updateNote.trim()}
                      onClick={postMortgageUpdate}
                    >
                      {postingUpdate ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                      Post to timeline
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Check details */}
            {check ? (
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <div className="font-semibold text-sm flex items-center gap-2">
                    <DollarSign className="h-4 w-4" /> Check details
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                    <Field label="Amount" value={check.amount != null ? `$${Number(check.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—"} />
                    <Field label="Check #" value={check.check_number || "—"} />
                    <Field label="Carrier" value={check.carrier_name || "—"} />
                    <Field label="Issue date" value={check.issue_date ? format(new Date(check.issue_date), "MMM d, yyyy") : "—"} />
                    <Field label="Payee" value={check.payee_line || "—"} className="col-span-2" />
                    {check.payee_address && <Field label="Payee address" value={check.payee_address} className="col-span-2" />}
                    {check.property_address && <Field label="Property" value={check.property_address} className="col-span-2" />}
                    {check.detected_claim_number && <Field label="Claim # (from check)" value={check.detected_claim_number} />}
                    {check.funds_type && <Field label="Funds type" value={check.funds_type} />}
                    <Field label="Stage" value={check.check_stage || check.status || "—"} />
                  </div>

                  {(images.front || images.back) && (
                    <div className="grid grid-cols-2 gap-2 pt-2">
                      {images.front && (
                        <a href={images.front} target="_blank" rel="noopener noreferrer" className="block">
                          <img src={images.front} alt="Check front" className="w-full rounded border border-border" />
                          <div className="text-[10px] text-center text-muted-foreground mt-1">Front</div>
                        </a>
                      )}
                      {images.back && (
                        <a href={images.back} target="_blank" rel="noopener noreferrer" className="block">
                          <img src={images.back} alt="Check back" className="w-full rounded border border-border" />
                          <div className="text-[10px] text-center text-muted-foreground mt-1">Back</div>
                        </a>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ) : (
              <Card><CardContent className="py-4 text-sm text-muted-foreground">No check linked to this request.</CardContent></Card>
            )}

            {/* Claim / homeowner info — prefer tenant-provided request fields, fall back to claim */}
            {(claim || req.homeowner_name || req.claim_number || req.policy_number) && (
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <div className="font-semibold text-sm flex items-center gap-2">
                    <Home className="h-4 w-4" /> Claim & homeowner
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                    <Field label="Claim #" value={req.claim_number || claim?.claim_number || "—"} />
                    <Field label="Policy #" value={req.policy_number || claim?.policy_number || "—"} />
                    <Field label="Loss type" value={req.loss_type || claim?.loss_type || "—"} />
                    <Field
                      label="Date of loss"
                      value={
                        req.date_of_loss
                          ? format(new Date(req.date_of_loss), "MMM d, yyyy")
                          : claim?.loss_date
                          ? format(new Date(claim.loss_date), "MMM d, yyyy")
                          : "—"
                      }
                    />
                    <Field label="Insurance" value={req.insurance_company || claim?.insurance_company || "—"} className="col-span-2" />
                    <Field label={<><User className="h-3 w-3 inline mr-1" />Homeowner</>} value={req.homeowner_name || claim?.policyholder_name || "—"} className="col-span-2" />
                    {(req.homeowner_email || claim?.policyholder_email) && (
                      <Field label={<><Mail className="h-3 w-3 inline mr-1" />Email</>} value={req.homeowner_email || claim!.policyholder_email!} />
                    )}
                    {(req.homeowner_phone || claim?.policyholder_phone) && (
                      <Field label={<><Phone className="h-3 w-3 inline mr-1" />Phone</>} value={req.homeowner_phone || claim!.policyholder_phone!} />
                    )}
                    {(req.property_address || claim?.policyholder_address) && (
                      <Field label={<><MapPin className="h-3 w-3 inline mr-1" />Address</>} value={req.property_address || claim!.policyholder_address!} className="col-span-2" />
                    )}
                    {req.homeowner_ssn_last_four && (
                      <Field label="SSN (last 4)" value={`•••-••-${req.homeowner_ssn_last_four}`} />
                    )}
                    {claim?.adjuster_name && <Field label="Adjuster" value={`${claim.adjuster_name}${claim.adjuster_phone ? ` · ${claim.adjuster_phone}` : ""}`} className="col-span-2" />}
                    {claim?.loan_number && !req.loan_number && <Field label="Loan # (claim)" value={claim.loan_number} />}
                  </div>
                  {claim?.loss_description && (
                    <div className="text-xs bg-muted/40 rounded p-2 whitespace-pre-wrap">{claim.loss_description}</div>
                  )}
                  {req.claim_id && (
                    <div className="pt-1">
                      <SendCheckTrackingLinkButton
                        claimId={req.claim_id}
                        tenantId={req.tenant_id}
                        defaultName={req.homeowner_name || claim?.policyholder_name}
                        defaultEmail={req.homeowner_email || claim?.policyholder_email}
                        defaultPhone={req.homeowner_phone || claim?.policyholder_phone}
                        label="Send tracking link to homeowner"
                        senderOverride="checksops"
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            )}


            {/* Loss draft documents — add/generate/upload/send */}
            {lossDraftId && (
              <Card>
                <CardContent className="pt-4">
                  <LossDraftDocsManager
                    supabaseClient={supabase}
                    lossDraftId={lossDraftId}
                    claimId={req.claim_id}
                    actorId={user?.id ?? null}
                    docs={lossDocs as any}
                    onChanged={() => void load()}
                    canSendSignature={!!(req.homeowner_email && (req.homeowner_name || claim?.policyholder_name))}
                    onSendForSignature={({ docId, path, fileName, documentLabel, signedUrl }) => {
                      setPendingDoc({ path, url: signedUrl, fileName, lossDraftDocId: docId, documentLabel });
                      setPlacedFields([]);
                      setPlacerOpen(true);
                    }}
                    claimContext={{
                      homeowner_name: req.homeowner_name || claim?.policyholder_name,
                      homeowner_email: req.homeowner_email || claim?.policyholder_email,
                      property_address: req.property_address || claim?.policyholder_address || check?.property_address,
                      claim_number: req.claim_number || claim?.claim_number || check?.detected_claim_number,
                      policy_number: req.policy_number || claim?.policy_number,
                      carrier: req.insurance_company || claim?.insurance_company || check?.carrier_name,
                      loss_date: req.date_of_loss || claim?.loss_date,
                      mortgage_company: req.mortgage_company,
                      loan_number: req.loan_number || claim?.loan_number,
                    }}
                  />
                </CardContent>
              </Card>
            )}

            {/* Files */}
            <Card>
              <CardContent className="pt-4 space-y-3">
                <div className="font-semibold text-sm flex items-center justify-between">
                  <span className="flex items-center gap-2"><FileText className="h-4 w-4" /> Attachments</span>
                  <span className="text-xs text-muted-foreground">{files.length}</span>
                </div>
                {files.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No attachments yet.</p>
                ) : (
                  <ul className="text-sm divide-y divide-border">
                    {files.map((f) => (
                      <li key={f.id} className="py-2 flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{f.file_name}</div>
                          <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-2">
                            {f.category && <span>{f.category}</span>}
                            {f.category === "mortgage_ops_signature" && <span className="text-amber-600">for homeowner signature</span>}
                            <span>{formatDistanceToNow(new Date(f.created_at), { addSuffix: true })}</span>
                          </div>
                          {f.description && <div className="text-xs text-muted-foreground truncate">{f.description}</div>}
                        </div>
                        <Button size="sm" variant="ghost" onClick={() => downloadFile(f.file_path, f.file_name)}>
                          <Download className="h-4 w-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

              </CardContent>
            </Card>

            {/* Send document for homeowner signature */}
            {check?.id && req.status === "in_progress" && req.assigned_employee_id === user?.id && (
              <Card className="border-primary/40">
                <CardContent className="pt-4 space-y-3">
                  <div className="font-semibold text-sm flex items-center gap-2">
                    <Send className="h-4 w-4 text-primary" /> Send document to homeowner
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Upload a document (e.g. 3rd-party authorization, mortgagee endorsement).
                    If it needs the homeowner's signature, keep the checkbox on — the tenant will
                    be notified in their check thread to route it to the homeowner
                    {req.homeowner_name ? ` (${req.homeowner_name})` : ""}
                    {req.homeowner_email ? ` at ${req.homeowner_email}` : ""}.
                  </p>
                  <Input
                    placeholder="Document name / purpose (e.g. 3rd-party authorization)"
                    value={uploadDesc}
                    onChange={(e) => setUploadDesc(e.target.value)}
                  />
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={uploadForSignature}
                      onChange={(e) => setUploadForSignature(e.target.checked)}
                    />
                    Requires homeowner signature (tenant will be notified to send)
                  </label>
                  <label className="inline-flex">
                    <input
                      type="file"
                      className="hidden"
                      disabled={uploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadDoc(f);
                        e.currentTarget.value = "";
                      }}
                    />
                    <Button asChild size="sm" disabled={uploading}>
                      <span>
                        {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Upload className="h-4 w-4 mr-1" />}
                        {uploadForSignature ? "Upload & send for signature" : "Upload document"}
                      </span>
                    </Button>
                  </label>
                </CardContent>
              </Card>
            )}

            {/* Signature requests — sent to homeowner via e-sign */}
            {req.claim_id && (
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <div className="font-semibold text-sm flex items-center gap-2">
                    <FileText className="h-4 w-4" /> Signature requests
                    <span className="text-xs text-muted-foreground font-normal">({sigRequests.length})</span>
                  </div>
                  {sigRequests.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No signature requests yet. Upload a PDF above with "Requires homeowner signature" on to email it to the homeowner for e-signature — the same flow as Freedom CRM.
                    </p>
                  ) : (
                    <ul className="text-sm divide-y divide-border">
                      {sigRequests.map((s) => (
                        <li key={s.id} className="py-2 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium">{s.document_name}</span>
                            <Badge variant={s.status === "completed" ? "default" : s.status === "declined" || s.status === "failed" ? "destructive" : "secondary"} className="text-[10px]">
                              {s.status.replace("_", " ")}
                            </Badge>
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            Sent {formatDistanceToNow(new Date(s.created_at), { addSuffix: true })}
                          </div>
                          {s.signature_signers?.map((sg) => (
                            <div key={sg.id} className="text-xs flex items-center justify-between gap-2 pl-2">
                              <span className="truncate">
                                {sg.signer_name} <span className="text-muted-foreground">· {sg.signer_email}</span>
                              </span>
                              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                                {sg.status === "signed" && sg.signed_at
                                  ? `Signed ${format(new Date(sg.signed_at), "MMM d")}`
                                  : sg.viewed_at
                                  ? `Viewed ${format(new Date(sg.viewed_at), "MMM d")}`
                                  : sg.delivery_status === "sent"
                                  ? "Email sent"
                                  : sg.delivery_status === "failed"
                                  ? "Send failed"
                                  : sg.status}
                              </span>
                            </div>
                          ))}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            )}


            {/* Updates / messages with tenant */}
            {check?.id && (
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <div className="font-semibold text-sm flex items-center gap-2">
                    <Send className="h-4 w-4" /> Updates to tenant
                  </div>
                  <div className="max-h-64 overflow-auto space-y-2 border border-border rounded p-2 bg-muted/20">
                    {messages.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-4">No messages yet.</p>
                    ) : (
                      messages.map((m) => (
                        <div key={m.id} className={`text-sm rounded p-2 ${m.sender_id === user?.id ? "bg-primary/10 ml-8" : "bg-card mr-8 border border-border"}`}>
                          <div className="whitespace-pre-wrap">{m.body}</div>
                          <div className="text-[10px] text-muted-foreground mt-1">
                            {m.sender_id === user?.id ? "You" : "Tenant"} · {formatDistanceToNow(new Date(m.created_at), { addSuffix: true })}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                  {req.status === "in_progress" && req.assigned_employee_id === user?.id && (
                    <div className="space-y-2">
                      <Textarea
                        rows={2}
                        placeholder="Send an update to the tenant (also visible in their check thread)…"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                      <Button size="sm" disabled={posting || !draft.trim()} onClick={postMessage}>
                        {posting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />}
                        Send update
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            <Separator />
            <div className="text-[11px] text-muted-foreground">
              Request ID: {req.id}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>

    {/* Signature field placer — same UX as Freedom CRM. */}
    <Dialog open={placerOpen} onOpenChange={(v) => { if (!sending) setPlacerOpen(v); }}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Place signature fields</DialogTitle>
          <DialogDescription>
            Click the document to drop signature, date, or text fields where the homeowner
            should sign. When you're ready, click Send to email the request.
          </DialogDescription>
        </DialogHeader>
        {pendingDoc && (
          <FieldPlacementEditor
            documentUrl={pendingDoc.url}
            onFieldsChange={setPlacedFields}
            signerCount={1}
          />
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => setPlacerOpen(false)}
            disabled={sending}
          >
            Save draft (don't send yet)
          </Button>
          <Button onClick={sendPlacedSignatureRequest} disabled={sending}>
            {sending ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-1" /> Sending…</>
            ) : (
              <><Send className="h-4 w-4 mr-1" /> Send to homeowner ({placedFields.length} field{placedFields.length === 1 ? "" : "s"})</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function Field({ label, value, className }: { label: React.ReactNode; value: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate">{value}</div>
    </div>
  );
}
