// Generate a ChecksOps-branded PDF (Third Party Authorization or Lien Waiver)
// pre-filled with claim + homeowner + mortgage info, upload to claim-files,
// and return the storage path + signed URL so it can be routed through the
// signature field placer.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Template = "tpa" | "lien_waiver";

interface Payload {
  claim_id: string;
  loss_draft_id?: string | null;
  check_intake_item_id?: string | null;
  template: Template;
  homeowner_name: string;
  property_address?: string | null;
  claim_number?: string | null;
  policy_number?: string | null;
  carrier?: string | null;
  loss_date?: string | null;
  mortgage_company?: string | null;
  loan_number?: string | null;
  contractor_name?: string | null;
  contractor_amount?: string | null;
}

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const TEMPLATE_TITLES: Record<Template, string> = {
  tpa: "Third Party Authorization",
  lien_waiver: "Lien Waiver & Release",
};

function tpaBody(p: Payload): string[] {
  return [
    `I, ${p.homeowner_name}, the undersigned homeowner and policyholder, hereby authorize`,
    `ChecksOps and its representatives to act on my behalf in all matters relating to the`,
    `insurance claim described below, including but not limited to communicating with my`,
    `insurance carrier, mortgage company, and any other party involved in the handling,`,
    `endorsement, disbursement, and tracking of insurance loss proceeds.`,
    ``,
    `Property Address:   ${p.property_address ?? "________________________________________"}`,
    `Insurance Carrier:  ${p.carrier ?? "________________________________________"}`,
    `Claim Number:       ${p.claim_number ?? "________________________________________"}`,
    `Policy Number:      ${p.policy_number ?? "________________________________________"}`,
    `Date of Loss:       ${p.loss_date ?? "________________________________________"}`,
    `Mortgage Company:   ${p.mortgage_company ?? "________________________________________"}`,
    `Loan Number:        ${p.loan_number ?? "________________________________________"}`,
    ``,
    `This authorization allows the named parties to release information related to the`,
    `above claim to ChecksOps, and empowers ChecksOps to receive, endorse, hold in escrow,`,
    `and disburse insurance proceeds in accordance with the loss draft handling process.`,
    ``,
    `This authorization remains in effect until revoked in writing.`,
  ];
}

function lienWaiverBody(p: Payload): string[] {
  return [
    `In consideration of payment received or to be received in connection with work performed`,
    `on the property described below, the undersigned hereby waives and releases any and all`,
    `mechanic's lien, stop notice, or bond right that it has, or may have, on the property`,
    `for labor, services, equipment, or material furnished to the property.`,
    ``,
    `Property Address:   ${p.property_address ?? "________________________________________"}`,
    `Homeowner:          ${p.homeowner_name}`,
    `Insurance Carrier:  ${p.carrier ?? "________________________________________"}`,
    `Claim Number:       ${p.claim_number ?? "________________________________________"}`,
    `Contractor:         ${p.contractor_name ?? "________________________________________"}`,
    `Amount Paid:        ${p.contractor_amount ?? "________________________________________"}`,
    ``,
    `The undersigned represents that all labor, services, equipment, and material furnished`,
    `have been paid for in full, and that no other person or entity has any claim of lien or`,
    `right to a claim of lien against the property arising out of the undersigned's work.`,
    ``,
    `This waiver is unconditional and effective as of the date signed below.`,
  ];
}

async function buildPdf(p: Payload): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`${TEMPLATE_TITLES[p.template]} — ${p.homeowner_name}`);
  doc.setAuthor("ChecksOps");

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]); // Letter
  const { width, height } = page.getSize();
  const margin = 54;
  let y = height - margin;

  // Header — ChecksOps branding
  page.drawText("ChecksOps", { x: margin, y, size: 20, font: bold, color: rgb(0.15, 0.35, 0.85) });
  page.drawText("Insurance Check Handling & Escrow", {
    x: margin, y: y - 16, size: 9, font, color: rgb(0.4, 0.4, 0.4),
  });
  page.drawText("checksops.com", {
    x: width - margin - font.widthOfTextAtSize("checksops.com", 9),
    y, size: 9, font, color: rgb(0.4, 0.4, 0.4),
  });
  y -= 40;
  page.drawLine({
    start: { x: margin, y }, end: { x: width - margin, y },
    thickness: 0.75, color: rgb(0.15, 0.35, 0.85),
  });
  y -= 24;

  // Title
  page.drawText(TEMPLATE_TITLES[p.template].toUpperCase(), {
    x: margin, y, size: 14, font: bold, color: rgb(0.1, 0.1, 0.1),
  });
  y -= 24;

  // Body
  const lines = p.template === "tpa" ? tpaBody(p) : lienWaiverBody(p);
  for (const ln of lines) {
    page.drawText(ln, { x: margin, y, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
    y -= 14;
  }
  y -= 28;

  // Signature block placeholders — the field placer will overlay actual fields.
  page.drawText("Signature:", { x: margin, y, size: 10, font: bold });
  page.drawLine({
    start: { x: margin + 70, y: y - 2 }, end: { x: margin + 320, y: y - 2 },
    thickness: 0.5, color: rgb(0.2, 0.2, 0.2),
  });
  page.drawText("Date:", { x: margin + 350, y, size: 10, font: bold });
  page.drawLine({
    start: { x: margin + 390, y: y - 2 }, end: { x: width - margin, y: y - 2 },
    thickness: 0.5, color: rgb(0.2, 0.2, 0.2),
  });
  y -= 22;
  page.drawText(`Printed name: ${p.homeowner_name}`, { x: margin, y, size: 9, font, color: rgb(0.35, 0.35, 0.35) });
  y -= 40;

  page.drawText(
    `Generated by ChecksOps on ${new Date().toLocaleDateString("en-US")}`,
    { x: margin, y: margin - 10, size: 8, font, color: rgb(0.55, 0.55, 0.55) },
  );

  return await doc.save();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const sbUrl = Deno.env.get("SUPABASE_URL")!;
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const auth = req.headers.get("Authorization") || "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return respond({ error: "Missing auth" }, 401);

  const admin = createClient(sbUrl, svcKey);
  const { data: userRes, error: userErr } = await admin.auth.getUser(jwt);
  const user = userRes?.user;
  if (userErr || !user) {
    console.error("generate-checksops-doc auth failed:", userErr?.message);
    return respond({ error: "Not authenticated" }, 401);
  }
  try {
    const payload = (await req.json()) as Payload;
    if (!payload?.claim_id || !payload?.template || !payload?.homeowner_name) {
      return respond({ error: "claim_id, template, homeowner_name required" }, 400);
    }
    if (payload.template !== "tpa" && payload.template !== "lien_waiver") {
      return respond({ error: "Unsupported template" }, 400);
    }

    const pdfBytes = await buildPdf(payload);
    const label = payload.template === "tpa" ? "third-party-authorization" : "lien-waiver";
    const fileName = `${label}-${Date.now()}.pdf`;
    const path = `checks/${payload.claim_id}/checksops-templates/${fileName}`;

    const { error: upErr } = await admin.storage
      .from("claim-files")
      .upload(path, pdfBytes, { contentType: "application/pdf", upsert: false });
    if (upErr) throw upErr;

    const { data: signed } = await admin.storage
      .from("claim-files")
      .createSignedUrl(path, 3600);

    return respond({
      ok: true,
      path,
      file_name: fileName,
      signed_url: signed?.signedUrl ?? null,
      document_label: TEMPLATE_TITLES[payload.template],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("generate-checksops-doc failed:", msg);
    return respond({ error: msg }, 500);
  }
});
