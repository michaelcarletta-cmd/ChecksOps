import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import type { FolderKey } from "../_shared/darwin-contracts.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/** Category = what the doc is; optional when classification uncertain (don't guess). */
type DocCategory = "policy" | "estimate" | "photos" | "carrier_comms" | "invoice" | "supplement" | "other";

/** Structured doc request; supplements missingDocs string[] for UI and templates. */
type MissingDocRequest = {
  key: string;
  title: string;
  whyNeeded: string;
  whereToFind?: string;
  priority: "high" | "med" | "low";
};

/** Invoice scope bucket for debris vs documentation (scope splitter). */
type InvoiceScopeBucket = "physical_removal" | "packout_storage" | "documentation_inventory" | "cleaning_mitigation" | "unknown_unclassified";

type ClaimFactsPack = {
  meta: {
    claimId: string;
    state?: string | null;
    carrier?: string | null;
    audience?: "carrier" | "regulator" | "internal";
    regulatoryComplaint?: boolean;
    drp?: boolean;
    lossType?: string | null;
    createdAt: string;
    servicesPerformed?: string[];
  };
  /** Global evidence ledger: counts by folder for UI summary. */
  evidenceIndexSummary?: { byFolderKey: Partial<Record<FolderKey, number>>; totalPagesKnownAcrossDocs?: number; totalPagesKnown?: number };
  documents: Array<{
    docId: string;
    docName: string;
    category?: DocCategory;
    categoryHint?: string;
    folderKey: FolderKey;
    pageCount?: number;
  }>;
  policy?: {
    policyNumber?: string | null;
    effectiveDate?: string | null;
    expirationDate?: string | null;
    coverages: Array<{
      name: string;
      limit?: string | null;
      deductible?: string | null;
      evidence: Array<{ docId: string; docName: string; page?: number; sectionHint?: string }>;
      confidence: 0 | 0.5 | 1;
    }>;
    missingDocs: string[];
  };
  estimate?: {
    source?: "carrier" | "shop" | "unknown";
    totals?: Record<string, number>;
    laborRates?: Record<string, number>;
    lineItemHighlights: Array<{
      label: string;
      amount?: number;
      evidence: Array<{ docId: string; docName: string; page?: number; lineHint?: string }>;
    }>;
    missingDocs: string[];
  };
  objections?: Array<{
    verbatim: string;
    source: { docId: string; docName: string; page?: number; lineHint?: string };
    inferredType?: string;
    confidence: 0 | 0.5 | 1;
  }>;
  evidenceGaps: string[];
  missingDocRequests?: MissingDocRequest[];
  /** Invoice line items classified by scope (debris vs documentation). */
  invoiceScopeBuckets?: Partial<Record<InvoiceScopeBucket, { label: string; amount?: number; evidence: Array<{ docId: string; docName: string }> }[]>>;
};

function isEstimateDoc(f: any): boolean {
  const classification = (f.document_classification || '').toLowerCase();
  const documentType = (f.document_type || '').toLowerCase();
  const subtype = (f.document_subtype || '').toLowerCase();
  const folderName = ((f as any).claim_folders?.name || '').toLowerCase();
  const name = (f.file_name || '').toLowerCase();
  const summary = (f.document_summary || '').toLowerCase();

  if (classification === 'estimate') return true;
  if (documentType === 'estimate' || documentType === 'carrier_estimate') return true;
  if (subtype.includes('estimate')) return true;
  if (folderName.includes('estimate') || folderName.includes('scope') || folderName.includes('supplement')) return true;

  return [
    'estimate',
    'xactimate',
    'symbility',
    'scope',
    'rcv',
    'acv',
    'loss sheet',
    'repair list',
    'line item',
  ].some((token) => name.includes(token) || summary.includes(token));
}

function inferEstimateSource(f: any): 'carrier' | 'shop' | 'unknown' {
  const subtype = (f.document_subtype || '').toLowerCase();
  const documentType = (f.document_type || '').toLowerCase();
  const folderName = ((f as any).claim_folders?.name || '').toLowerCase();
  const name = (f.file_name || '').toLowerCase();

  if (subtype === 'carrier_estimate' || documentType === 'carrier_estimate' || name.includes('carrier')) return 'carrier';
  if (
    subtype === 'pa_estimate' ||
    subtype === 'contractor_estimate' ||
    subtype === 'supplement_estimate' ||
    folderName.includes('supplement') ||
    name.includes('supplement')
  ) {
    return 'shop';
  }

  return 'unknown';
}

function mapFolderToKey(folderName: string): FolderKey {
  const f = folderName.toLowerCase();
  if (f.includes("policy")) return "policy";
  if (f.includes("estimate")) return "estimates";
  if (f.includes("correspondence") || f.includes("letter") || f.includes("denial")) return "carrier";
  if (f.includes("photo")) return "photos";
  if (f.includes("invoice")) return "invoices";
  if (f.includes("supplement")) return "supplements";
  if (f.includes("export")) return "exports";
  return "intake";
}

function mapToCategory(f: any, folderKey: FolderKey): DocCategory {
  const classification = (f.document_classification || "").toLowerCase();
  const name = (f.file_name || "").toLowerCase();
  if (classification === "policy" || name.includes("policy") || name.includes("declaration")) return "policy";
  if (classification === "estimate" || name.includes("estimate") || name.includes("xactimate")) return "estimate";
  if (classification === "denial" || classification === "correspondence" || classification === "engineering_report") return "carrier_comms";
  if (classification === "invoice" || name.includes("invoice") || name.includes("receipt")) return "invoice";
  if (name.includes("supplement")) return "supplement";
  if (folderKey === "photos") return "photos";
  return "other";
}

function parseStateFromAddress(address: string | null): string | null {
  if (!address) return null;
  const u = address.toUpperCase();
  if (u.includes(" PA") || u.includes("PENNSYLVANIA") || u.includes(", PA")) return "PA";
  if (u.includes(" NJ") || u.includes("NEW JERSEY") || u.includes(", NJ")) return "NJ";
  const m = u.match(/\s([A-Z]{2})[,\s]+\d{5}/);
  return m ? m[1] : null;
}

/** Classify a line item label into scope bucket (debris vs documentation). Unmatched labels go to unknown_unclassified. */
function classifyLineScope(label: string): InvoiceScopeBucket {
  const L = (label || "").toLowerCase();
  if (/\b(haul[- ]?off|debris|removal|demolition|tear[- ]?out|dump|haul)\b/.test(L)) return "physical_removal";
  if (/\b(pack[- ]?out|storage|contents|inventory)\b/.test(L)) return "packout_storage";
  if (/\b(inventory|documentation|photo|inspect|scope)\b/.test(L) && !/\b(pack|storage)\b/.test(L)) return "documentation_inventory";
  if (/\b(clean|mitigation|dry|dehumid|sanitize)\b/.test(L)) return "cleaning_mitigation";
  return "unknown_unclassified";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const { claimId } = (await req.json()) as { claimId: string };
    if (!claimId) {
      return new Response(JSON.stringify({ error: "claimId required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const [claimRes, filesRes, photosRes] = await Promise.all([
      supabase.from("claims").select("id, claim_number, policyholder_address, insurance_company, loss_type").eq("id", claimId).single(),
      supabase
        .from("claim_files")
        .select("id, file_name, document_classification, document_type, document_subtype, document_summary, classification_metadata, uploaded_at, extracted_text, claim_folders(name)")
        .eq("claim_id", claimId),
      supabase.from("claim_photos").select("id, file_name, category").eq("claim_id", claimId),
    ]);

    const claim = claimRes.data;
    const files = filesRes.data || [];
    const photos = photosRes.data || [];

    const createdAt = new Date().toISOString();
    const state = claim ? parseStateFromAddress(claim.policyholder_address) : null;

    const documents: ClaimFactsPack["documents"] = [];

    const hintForOther = (fileName: string): string | undefined => {
      let base = (fileName || "").replace(/\.[^.]*$/, "").replace(/[-_]/g, " ").trim();
      base = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
      if (base.length < 2 || base.length > 40) return undefined;
      const lower = base.toLowerCase();
      const generic = ["scan", "document", "image", "file", "doc", "pdf", "img", "photo", "attachment", "upload"];
      if (generic.some((g) => lower === g || lower.startsWith(g + " ") || lower.endsWith(" " + g))) return undefined;
      return base.slice(0, 40);
    };
    for (const f of files) {
      const folderName = (f as any).claim_folders?.name || "";
      const folderKey: FolderKey = mapFolderToKey(folderName);
      const category = mapToCategory(f, folderKey);
      const entry: { docId: string; docName: string; category: DocCategory; categoryHint?: string; folderKey: FolderKey } = {
        docId: f.id,
        docName: f.file_name,
        category,
        folderKey,
      };
      if (category === "other") {
        const hint = hintForOther(f.file_name);
        if (hint) entry.categoryHint = hint;
      }
      documents.push(entry);
    }
    for (const p of photos) {
      documents.push({
        docId: p.id,
        docName: p.file_name,
        category: "photos",
        folderKey: "photos",
      });
    }

    const pack: ClaimFactsPack = {
      meta: {
        claimId,
        state: state ?? null,
        carrier: claim?.insurance_company ?? null,
        audience: "carrier",
        regulatoryComplaint: false,
        drp: false,
        lossType: claim?.loss_type ?? null,
        createdAt,
        servicesPerformed: undefined,
      },
      documents,
      evidenceGaps: [],
    };

    // Global evidence ledger for UI: "We have 3 policy docs / 0 carrier letters / 1 invoice"
    const byFolderKey: Partial<Record<FolderKey, number>> = {};
    let totalPagesKnownAcrossDocs = 0;
    for (const d of documents) {
      byFolderKey[d.folderKey] = (byFolderKey[d.folderKey] ?? 0) + 1;
      if (typeof d.pageCount === "number" && d.pageCount > 0) totalPagesKnownAcrossDocs += d.pageCount;
    }
    pack.evidenceIndexSummary = {
      byFolderKey,
      totalPagesKnownAcrossDocs: totalPagesKnownAcrossDocs > 0 ? totalPagesKnownAcrossDocs : undefined,
      totalPagesKnown: totalPagesKnownAcrossDocs > 0 ? totalPagesKnownAcrossDocs : undefined,
    };

    const policyDocs = files.filter((f: any) => {
      const c = (f.document_classification || "").toLowerCase();
      const n = (f.file_name || "").toLowerCase();
      return c === "policy" || n.includes("policy") || n.includes("dec") || n.includes("declaration");
    });

    if (policyDocs.length > 0) {
      const missingDocs: string[] = [];
      const coverages: NonNullable<ClaimFactsPack["policy"]>["coverages"] = [];
      const meta = policyDocs[0].classification_metadata as any;
      if (meta?.policyNumber) {
        pack.policy = pack.policy || {
          coverages: [],
          missingDocs: [],
        };
        (pack.policy as any).policyNumber = meta.policyNumber;
      }
      if (meta?.effectiveDate) (pack.policy as any).effectiveDate = meta.effectiveDate;
      if (meta?.expirationDate) (pack.policy as any).expirationDate = meta.expirationDate;
      if (meta?.coverages && Array.isArray(meta.coverages)) {
        for (const cov of meta.coverages) {
          coverages.push({
            name: cov.name || cov.type || "Coverage",
            limit: cov.limit ?? cov.value ?? null,
            deductible: cov.deductible ?? null,
            evidence: [{ docId: policyDocs[0].id, docName: policyDocs[0].file_name, page: cov.page, sectionHint: cov.section }].filter((e) => e.docId),
            confidence: (cov.confidence === 0 || cov.confidence === 0.5 || cov.confidence === 1) ? cov.confidence : 0.5,
          });
        }
      }
      if (!pack.policy) pack.policy = { coverages: [], missingDocs: [] };
      pack.policy.coverages = coverages.length ? coverages : [];
      if (coverages.length === 0) pack.policy.missingDocs.push("Declarations page (extract coverages/limits)");
    } else {
      pack.evidenceGaps.push("Declarations page");
      pack.evidenceGaps.push("Policy jacket");
    }

    const estimateDocs = files.filter((f: any) => isEstimateDoc(f));

    if (estimateDocs.length > 0) {
      const primaryEstimateDoc =
        estimateDocs.find((f: any) => inferEstimateSource(f) === 'shop') ||
        estimateDocs.find((f: any) => (f.document_subtype || '').toLowerCase() === 'pa_estimate') ||
        estimateDocs[0];
      pack.estimate = {
        source: inferEstimateSource(primaryEstimateDoc),
        lineItemHighlights: [],
        missingDocs: [],
      };
      const meta = primaryEstimateDoc.classification_metadata as any;
      if (meta?.amounts && Array.isArray(meta.amounts)) {
        for (const a of meta.amounts.slice(0, 15)) {
          pack.estimate!.lineItemHighlights.push({
            label: (a as any).description || (a as any).category || "Line item",
            amount: (a as any).amount ?? (a as any).total,
            evidence: [{ docId: primaryEstimateDoc.id, docName: primaryEstimateDoc.file_name, lineHint: (a as any).line }].filter((e) => e.docId),
          });
        }
      }
      if (meta?.total != null) pack.estimate!.totals = { grandTotal: Number(meta.total) };
      if (meta?.laborRates && typeof meta.laborRates === "object") pack.estimate!.laborRates = meta.laborRates;
      if (pack.estimate!.lineItemHighlights.length === 0) pack.estimate!.missingDocs.push("Estimate line items (from estimate doc)");
    } else {
      pack.evidenceGaps.push("Our estimate / scope");
    }

    const hasCarrierEstimate = files.some((f: any) => isEstimateDoc(f) && inferEstimateSource(f) === 'carrier');
    if (!hasCarrierEstimate) pack.evidenceGaps.push("Carrier estimate");

    const objectionDocs = files.filter((f: any) => {
      const c = (f.document_classification || "").toLowerCase();
      const n = (f.file_name || "").toLowerCase();
      return c === "denial" || c === "correspondence" || c === "engineering_report" || n.includes("denial") || n.includes("letter") || n.includes("engineer");
    });

    pack.objections = [];
    for (const f of objectionDocs) {
      const text = (f as any).extracted_text || "";
      if (text.length < 100) continue;
      const sentences = text.split(/(?<=[.!?])\s+/);
      const denialPhrases = [
        /we\s+(?:do\s+not\s+)?(?:find|conclude|determine|deny|are\s+unable)/i,
        /(?:is|are)\s+not\s+covered/i,
        /(?:excluded|exclusion)/i,
        /(?:deny|denied|denying)\s+(?:coverage|the\s+claim)/i,
        /(?:our\s+)?determination\s+is/i,
        /(?:does\s+not\s+)?(?:meet|fall\s+within)/i,
        /(?:pre-?existing|wear\s+and\s+tear|maintenance)/i,
      ];
      for (const s of sentences) {
        const trimmed = s.trim();
        if (trimmed.length < 20 || trimmed.length > 400) continue;
        if (denialPhrases.some((r) => r.test(trimmed))) {
          pack.objections!.push({
            verbatim: trimmed,
            source: { docId: f.id, docName: f.file_name },
            confidence: 0.5,
          });
          if (pack.objections!.length >= 20) break;
        }
      }
    }

    if (photos.length === 0) pack.evidenceGaps.push("Photos (damage documentation)");

    // Structured missing-doc requests (supplements missingDocs/evidenceGaps)
    const missingDocRequests: MissingDocRequest[] = [];
    const seenKeys = new Set<string>();
    const addRequest = (key: string, title: string, whyNeeded: string, whereToFind?: string, priority: "high" | "med" | "low" = "med") => {
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      missingDocRequests.push({ key, title, whyNeeded, whereToFind, priority });
    };
    if (pack.policy?.missingDocs?.length) {
      for (const d of pack.policy.missingDocs) {
        const key = d.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 40) || "policy_doc";
        addRequest(key, d, "Needed to confirm coverage/limits and policy wording.", "Policy packet, agent", d.includes("Declaration") ? "high" : "med");
      }
    }
    if (pack.estimate?.missingDocs?.length) {
      for (const d of pack.estimate.missingDocs) {
        const key = ("est_" + d).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 40);
        addRequest(key, d, "Needed to support scope and line-item basis.", "Estimate doc, carrier portal", "med");
      }
    }
    for (const g of pack.evidenceGaps) {
      const key = ("gap_" + g).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 40);
      addRequest(key, g, "Strengthens defensibility and evidence trail.", undefined, g.includes("Declaration") || g.includes("denial") ? "high" : "med");
    }
    if (missingDocRequests.length > 0) pack.missingDocRequests = missingDocRequests;

    // Scope splitter: classify estimate line items into debris vs documentation buckets
    const UNKNOWN_SCOPE_THRESHOLD = 0.3; // if unknown_unclassified share > 30%, request clearer descriptions
    if (pack.estimate?.lineItemHighlights?.length) {
      const buckets: ClaimFactsPack["invoiceScopeBuckets"] = {};
      for (const line of pack.estimate.lineItemHighlights) {
        const bucket = classifyLineScope(line.label);
        const entry = { label: line.label, amount: line.amount, evidence: line.evidence.map((e) => ({ docId: e.docId, docName: e.docName })) };
        if (!buckets[bucket]) buckets[bucket] = [];
        buckets[bucket].push(entry);
      }
      pack.invoiceScopeBuckets = buckets;
      const totalLines = pack.estimate.lineItemHighlights.length;
      const unknownCount = (buckets.unknown_unclassified ?? []).length;
      if (totalLines > 0 && unknownCount / totalLines > UNKNOWN_SCOPE_THRESHOLD) {
        if (!pack.missingDocRequests) pack.missingDocRequests = [];
        const key = "invoice_clearer_line_descriptions";
        if (!pack.missingDocRequests.some((r) => r.key === key)) {
          pack.missingDocRequests.push({
            key,
            title: "Itemized invoice with clearer line descriptions / contract scope",
            whyNeeded: "Many line items could not be classified (debris vs documentation); clearer descriptions improve scope resolution.",
            priority: "med",
          });
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        claimFactsPack: pack,
        builtAt: createdAt,
        claimId,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("darwin-evidence-index error:", e);
    return new Response(JSON.stringify({ error: e?.message || "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
