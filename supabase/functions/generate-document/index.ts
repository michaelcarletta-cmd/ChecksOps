import { createClient } from "@supabase/supabase-js";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { templateId, claimId } = await req.json();

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Fetch template
    const { data: template, error: templateError } = await supabaseClient
      .from("document_templates")
      .select("*")
      .eq("id", templateId)
      .single();

    if (templateError) throw templateError;

    // Fetch claim data
    const { data: claim, error: claimError } = await supabaseClient
      .from("claims")
      .select(`
        *,
        insurance_companies(name),
        loss_types(name),
        referrers(name, company),
        mortgage_companies(name, contact_name, phone, email)
      `)
      .eq("id", claimId)
      .single();

    if (claimError) throw claimError;

    // Fetch settlement data
    const { data: settlements } = await supabaseClient
      .from("claim_settlements")
      .select("*")
      .eq("claim_id", claimId);

    // Fetch checks data
    const { data: checks } = await supabaseClient
      .from("claim_checks")
      .select("*")
      .eq("claim_id", claimId);

    // Calculate settlement totals
    const settlement = settlements?.[0] || {};
    const dwellingRcv = Number(settlement.replacement_cost_value) || 0;
    const dwellingRecDep = Number(settlement.recoverable_depreciation) || 0;
    const dwellingNonRecDep = Number(settlement.non_recoverable_depreciation) || 0;
    const dwellingDeductible = Number(settlement.deductible) || 0;
    const dwellingAcv = dwellingRcv - dwellingRecDep - dwellingNonRecDep;
    const dwellingNet = dwellingAcv - dwellingDeductible;

    const otherStructuresRcv = Number(settlement.other_structures_rcv) || 0;
    const otherStructuresRecDep = Number(settlement.other_structures_recoverable_depreciation) || 0;
    const otherStructuresNonRecDep = Number(settlement.other_structures_non_recoverable_depreciation) || 0;
    const otherStructuresDeductible = Number(settlement.other_structures_deductible) || 0;
    const otherStructuresAcv = otherStructuresRcv - otherStructuresRecDep - otherStructuresNonRecDep;
    const otherStructuresNet = otherStructuresAcv - otherStructuresDeductible;

    const pwiRcv = Number(settlement.pwi_rcv) || 0;
    const pwiRecDep = Number(settlement.pwi_recoverable_depreciation) || 0;
    const pwiNonRecDep = Number(settlement.pwi_non_recoverable_depreciation) || 0;
    const pwiDeductible = Number(settlement.pwi_deductible) || 0;
    const pwiAcv = pwiRcv - pwiRecDep - pwiNonRecDep;
    const pwiNet = pwiAcv - pwiDeductible;

    const totalRcv = dwellingRcv + otherStructuresRcv + pwiRcv;
    const totalDeductible = dwellingDeductible + otherStructuresDeductible + pwiDeductible;
    const totalNet = dwellingNet + otherStructuresNet + pwiNet;
    const priorOffer = Number(settlement.prior_offer) || 0;
    const totalRecoverableDep = dwellingRecDep + otherStructuresRecDep + pwiRecDep;
    const totalNonRecoverableDep = dwellingNonRecDep + otherStructuresNonRecDep + pwiNonRecDep;

    const totalChecks = checks?.reduce((sum, c) => sum + (Number(c.amount) || 0), 0) || 0;
    const outstanding = (totalRcv - totalDeductible) - totalChecks;

    const formatCurrency = (val: number) => `$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // Download template file
    const { data: fileData, error: downloadError } = await supabaseClient.storage
      .from("document-templates")
      .download(template.file_path);

    if (downloadError) throw downloadError;

    // Check file type based on extension
    const fileName = template.file_name.toLowerCase();
    const isPDF = fileName.endsWith('.pdf');

    // For PDFs, return the file as-is (no merge field replacement possible)
    if (isPDF) {
      const arrayBuffer = await fileData.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      
      const outputFileName = `${claim.claim_number || 'document'}-${template.name.replace(/\s+/g, "_")}.pdf`;

      return new Response(
        JSON.stringify({
          content: Array.from(uint8Array),
          fileName: outputFileName,
          isPDF: true,
        }),
        {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        }
      );
    }

    // For Word documents (.docx), process with docxtemplater
    const arrayBuffer = await fileData.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);

    // Use pre-imported PizZip and Docxtemplater
    const zip = new PizZip(uint8Array);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => "",
      delimiters: {
        start: "${",
        end: "}"
      }
    });

    // Parse address from policyholder_address field
    const addressParts = (claim.policyholder_address || "").split(",").map((s: string) => s.trim());
    const street = addressParts[0] || "";
    const city = addressParts[1] || "";
    const stateZip = (addressParts[2] || "").split(" ");
    const state = stateZip[0] || "";
    const zipCode = stateZip[1] || "";

    // Format date safely - handle YYYY-MM-DD format without timezone issues
    const formatDate = (dateStr: string | null): string => {
      if (!dateStr) return "";
      try {
        // Parse YYYY-MM-DD format directly to avoid timezone issues
        const parts = dateStr.split('T')[0].split('-');
        if (parts.length === 3) {
          const [year, month, day] = parts;
          return `${parseInt(month)}/${parseInt(day)}/${year}`;
        }
        return dateStr;
      } catch {
        return dateStr || "";
      }
    };

    // Prepare data for template matching the ${field} format
    const templateData = {
      // Main claim info
      claim: {
        claim_number: claim.claim_number || "",
        loss_type: claim.loss_types?.name || claim.loss_type || "",
        loss_date: formatDate(claim.loss_date),
        loss_description: claim.loss_description || "",
        amount: claim.claim_amount ? `$${claim.claim_amount.toLocaleString()}` : "",
        status: claim.status || "",
      },
      // Flat claim fields for simpler template usage
      claim_number: claim.claim_number || "",
      loss_type: claim.loss_types?.name || claim.loss_type || "",
      loss_date: formatDate(claim.loss_date),
      loss_description: claim.loss_description || "",
      // Policyholder info
      policyholder: claim.policyholder_name || "",
      policyholder_name: claim.policyholder_name || "",
      policyholder_email: claim.policyholder_email || "",
      policyholder_phone: claim.policyholder_phone || "",
      // Address (nested object and full string)
      address: {
        street: street,
        city: city,
        state: state,
        zip: zipCode,
        full: claim.policyholder_address || ""
      },
      // Flat address fields for simpler template usage
      property_address: claim.policyholder_address || "",
      street: street,
      city: city,
      state: state,
      zip: zipCode,
      // Insurance info
      insurance_company: claim.insurance_companies?.name || claim.insurance_company || "",
      insurance_phone: claim.insurance_phone || "",
      insurance_email: claim.insurance_email || "",
      policy: claim.policy_number || "",
      policy_number: claim.policy_number || "",
      // Adjuster info
      adjuster: {
        name: claim.adjuster_name || "",
        phone: claim.adjuster_phone || "",
        email: claim.adjuster_email || "",
      },
      adjuster_name: claim.adjuster_name || "",
      adjuster_phone: claim.adjuster_phone || "",
      adjuster_email: claim.adjuster_email || "",
      // Referrer info
      referrer: {
        name: claim.referrers?.name || "",
        company: claim.referrers?.company || "",
      },
      referrer_name: claim.referrers?.name || "",
      referrer_company: claim.referrers?.company || "",
      // Mortgage info
      mortgage: {
        company: claim.mortgage_companies?.name || "",
        contact: claim.mortgage_companies?.contact_name || "",
        phone: claim.mortgage_companies?.phone || "",
        email: claim.mortgage_companies?.email || "",
      },
      mortgage_company: claim.mortgage_companies?.name || "",
      loan_number: claim.loan_number || "",
      ssn_last_four: claim.ssn_last_four || "",
      // Current date
      date: new Date().toLocaleDateString(),
      today: new Date().toLocaleDateString(),
      // Settlement/Accounting data (nested for settlement.field syntax)
      settlement: {
        dwelling_rcv: formatCurrency(dwellingRcv),
        dwelling_acv: formatCurrency(dwellingAcv),
        dwelling_net: formatCurrency(dwellingNet),
        dwelling_deductible: formatCurrency(dwellingDeductible),
        dwelling_recoverable_dep: formatCurrency(dwellingRecDep),
        dwelling_non_recoverable_dep: formatCurrency(dwellingNonRecDep),
        other_structures_rcv: formatCurrency(otherStructuresRcv),
        other_structures_acv: formatCurrency(otherStructuresAcv),
        other_structures_net: formatCurrency(otherStructuresNet),
        other_structures_deductible: formatCurrency(otherStructuresDeductible),
        other_structures_recoverable_dep: formatCurrency(otherStructuresRecDep),
        other_structures_non_recoverable_dep: formatCurrency(otherStructuresNonRecDep),
        pwi_rcv: formatCurrency(pwiRcv),
        pwi_acv: formatCurrency(pwiAcv),
        pwi_net: formatCurrency(pwiNet),
        pwi_deductible: formatCurrency(pwiDeductible),
        pwi_recoverable_dep: formatCurrency(pwiRecDep),
        pwi_non_recoverable_dep: formatCurrency(pwiNonRecDep),
        total_rcv: formatCurrency(totalRcv),
        total_net: formatCurrency(totalNet),
        total_deductible: formatCurrency(totalDeductible),
        total_recoverable_dep: formatCurrency(totalRecoverableDep),
        total_non_recoverable_dep: formatCurrency(totalNonRecoverableDep),
        prior_offer: formatCurrency(priorOffer),
        total_checks: formatCurrency(totalChecks),
        outstanding: formatCurrency(outstanding),
      },
      // Flat settlement fields for simpler template usage
      dwelling_rcv: formatCurrency(dwellingRcv),
      dwelling_acv: formatCurrency(dwellingAcv),
      dwelling_net: formatCurrency(dwellingNet),
      dwelling_deductible: formatCurrency(dwellingDeductible),
      dwelling_recoverable_dep: formatCurrency(dwellingRecDep),
      dwelling_non_recoverable_dep: formatCurrency(dwellingNonRecDep),
      other_structures_rcv: formatCurrency(otherStructuresRcv),
      other_structures_acv: formatCurrency(otherStructuresAcv),
      other_structures_net: formatCurrency(otherStructuresNet),
      other_structures_deductible: formatCurrency(otherStructuresDeductible),
      other_structures_recoverable_dep: formatCurrency(otherStructuresRecDep),
      other_structures_non_recoverable_dep: formatCurrency(otherStructuresNonRecDep),
      pwi_rcv: formatCurrency(pwiRcv),
      pwi_acv: formatCurrency(pwiAcv),
      pwi_net: formatCurrency(pwiNet),
      pwi_deductible: formatCurrency(pwiDeductible),
      pwi_recoverable_dep: formatCurrency(pwiRecDep),
      pwi_non_recoverable_dep: formatCurrency(pwiNonRecDep),
      total_rcv: formatCurrency(totalRcv),
      total_net: formatCurrency(totalNet),
      total_deductible: formatCurrency(totalDeductible),
      total_recoverable_dep: formatCurrency(totalRecoverableDep),
      total_non_recoverable_dep: formatCurrency(totalNonRecoverableDep),
      prior_offer: formatCurrency(priorOffer),
      total_checks: formatCurrency(totalChecks),
      outstanding: formatCurrency(outstanding),
      deductible: formatCurrency(totalDeductible),
      rcv: formatCurrency(totalRcv),
      estimate_amount: settlement.estimate_amount ? formatCurrency(Number(settlement.estimate_amount)) : "",
    };

    console.log("Template data being rendered:", JSON.stringify(templateData, null, 2));

    // Render the document
    doc.render(templateData);

    // Generate the output file
    const outputBuffer = doc.getZip().generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    const outputFileName = `${claim.claim_number || 'document'}-${template.name.replace(/\s+/g, "_")}.docx`;

    return new Response(
      JSON.stringify({
        content: outputBuffer,
        fileName: outputFileName,
        isPDF: false,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    console.error("Error generating document:", error);
    
    // Handle docxtemplater-specific errors with better messages
    if (error && typeof error === 'object' && 'properties' in error) {
      const docxError = error as any;
      if (docxError.properties?.errors) {
        const errorDetails = docxError.properties.errors.map((e: any) => ({
          message: e.message,
          field: e.properties?.xtag || e.properties?.context,
          explanation: e.properties?.explanation
        }));
        
        console.info({ error: errorDetails });
        
        return new Response(
          JSON.stringify({ 
            error: "Template format error",
            details: "The Word template has formatting issues. Please ensure merge fields like {{field_name}} are not split by formatting (bold, italic, etc.). Try retyping the merge fields without any formatting.",
            technical: errorDetails
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }
    }
    
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }
});
