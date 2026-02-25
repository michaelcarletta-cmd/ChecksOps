import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { polData, claimId } = await req.json();

    if (!polData) {
      return new Response(
        JSON.stringify({ error: "No POL data provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch company branding
    const { data: branding } = await supabase
      .from("company_branding")
      .select("*")
      .limit(1)
      .single();

    // Create Word document
    const PizZip = (await import("https://esm.sh/pizzip@3.1.4")).default;
    const Docxtemplater = (await import("https://esm.sh/docxtemplater@3.42.0")).default;

    const templateContent = await createPOLDocxTemplate();
    
    const zip = new PizZip(templateContent);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => "",
    });

    const reportDate = new Date().toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });

    // Format amounts
    const formatAmount = (val: string | number) => {
      const num = parseFloat(String(val)) || 0;
      return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };

    const templateData = {
      company_name: branding?.company_name || "Freedom Adjustment",
      company_address: branding?.company_address || "",
      company_phone: branding?.company_phone || "",
      company_email: branding?.company_email || "",
      generated_date: reportDate,
      insured_name: polData.insured_name || "",
      insured_phone: polData.insured_phone || "",
      insured_email: polData.insured_email || "",
      policy_number: polData.policy_number || "",
      claim_number: polData.claim_number || "",
      date_of_loss: polData.date_of_loss || "",
      property_address: polData.property_address || "",
      insurance_company: polData.insurance_company || "",
      insurance_phone: polData.insurance_phone || "",
      insurance_email: polData.insurance_email || "",
      adjuster_name: polData.adjuster_name || "",
      adjuster_phone: polData.adjuster_phone || "",
      adjuster_email: polData.adjuster_email || "",
      loss_type: polData.loss_type || "",
      loss_description: polData.loss_description || "",
      damage_narrative: polData.ai_damage_narrative || polData.loss_description || "",
      building_damage: formatAmount(polData.building_damage),
      contents_damage: formatAmount(polData.contents_damage),
      additional_living_expense: formatAmount(polData.additional_living_expense),
      total_claimed: formatAmount(polData.total_claimed),
    };

    doc.render(templateData);

    const outputBuffer = doc.getZip().generate({
      type: "uint8array",
      compression: "DEFLATE",
    });

    // Save to storage
    const fileName = `${claimId}/reports/proof_of_loss_${Date.now()}.docx`;
    const { error: uploadError } = await supabase.storage
      .from("claim-files")
      .upload(fileName, outputBuffer, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      throw new Error("Failed to save POL to storage");
    }

    // Create claim file record
    const displayFileName = `Proof of Loss - ${new Date().toLocaleDateString()}.docx`;
    
    // Get AI Assistant Reports folder
    const { data: folder } = await supabase
      .from("claim_folders")
      .select("id")
      .eq("claim_id", claimId)
      .eq("name", "AI Assistant Reports")
      .single();

    await supabase.from("claim_files").insert({
      claim_id: claimId,
      file_name: displayFileName,
      file_path: fileName,
      file_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      file_size: outputBuffer.length,
      folder_id: folder?.id || null,
    });

    // Get signed URL for download
    const { data: signedUrlData } = await supabase.storage
      .from("claim-files")
      .createSignedUrl(fileName, 3600);

    return new Response(
      JSON.stringify({ 
        success: true,
        downloadUrl: signedUrlData?.signedUrl,
        fileName: displayFileName,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error generating POL Word document:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function createPOLDocxTemplate(): Promise<Uint8Array> {
  const PizZip = (await import("https://esm.sh/pizzip@3.1.4")).default;
  
  const zip = new PizZip();
  
  // [Content_Types].xml
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);
  
  // _rels/.rels
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  
  // word/_rels/document.xml.rels
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  
  // word/styles.xml
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="200" w:line="276" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:pPr><w:spacing w:after="300"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="36"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
    <w:pPr><w:spacing w:before="400" w:after="200"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="Heading 2"/>
    <w:pPr><w:spacing w:before="300" w:after="150"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:b/><w:sz w:val="24"/></w:rPr>
  </w:style>
</w:styles>`);
  
  // word/document.xml - POL-specific template
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>PROOF OF LOSS</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>{company_name}</w:t></w:r></w:p>
    <w:p/>
    
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>INSURED INFORMATION</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Insured Name: </w:t></w:r><w:r><w:t>{insured_name}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Phone: </w:t></w:r><w:r><w:t>{insured_phone}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Email: </w:t></w:r><w:r><w:t>{insured_email}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Property Address: </w:t></w:r><w:r><w:t>{property_address}</w:t></w:r></w:p>
    <w:p/>
    
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>POLICY &amp; CLAIM INFORMATION</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Policy Number: </w:t></w:r><w:r><w:t>{policy_number}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Claim Number: </w:t></w:r><w:r><w:t>{claim_number}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Insurance Company: </w:t></w:r><w:r><w:t>{insurance_company}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Insurance Phone: </w:t></w:r><w:r><w:t>{insurance_phone}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Insurance Email: </w:t></w:r><w:r><w:t>{insurance_email}</w:t></w:r></w:p>
    <w:p/>
    
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>ADJUSTER INFORMATION</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Adjuster Name: </w:t></w:r><w:r><w:t>{adjuster_name}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Adjuster Phone: </w:t></w:r><w:r><w:t>{adjuster_phone}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Adjuster Email: </w:t></w:r><w:r><w:t>{adjuster_email}</w:t></w:r></w:p>
    <w:p/>
    
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>LOSS INFORMATION</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Date of Loss: </w:t></w:r><w:r><w:t>{date_of_loss}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Type of Loss: </w:t></w:r><w:r><w:t>{loss_type}</w:t></w:r></w:p>
    <w:p/>
    
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Description of Loss:</w:t></w:r></w:p>
    <w:p><w:r><w:t>{loss_description}</w:t></w:r></w:p>
    <w:p/>
    
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Detailed Damage Narrative:</w:t></w:r></w:p>
    <w:p><w:r><w:t>{damage_narrative}</w:t></w:r></w:p>
    <w:p/>
    
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>AMOUNT OF CLAIM</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Building Damage: </w:t></w:r><w:r><w:t>$ {building_damage}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Contents Damage: </w:t></w:r><w:r><w:t>$ {contents_damage}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Additional Living Expense: </w:t></w:r><w:r><w:t>$ {additional_living_expense}</w:t></w:r></w:p>
    <w:p><w:pPr><w:pBdr><w:top w:val="single" w:sz="6" w:space="1" w:color="000000"/></w:pBdr></w:pPr></w:p>
    <w:p><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>TOTAL AMOUNT CLAIMED: $ {total_claimed}</w:t></w:r></w:p>
    <w:p/>
    <w:p/>
    
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>CERTIFICATION</w:t></w:r></w:p>
    <w:p><w:r><w:t>The undersigned hereby certifies that the above amounts are correct and represent the actual cash value or replacement cost of the damaged property, and that no material information has been concealed or misrepresented.</w:t></w:r></w:p>
    <w:p/>
    <w:p/>
    
    <w:p><w:r><w:t>___________________________________          ________________</w:t></w:r></w:p>
    <w:p><w:r><w:t>Signature of Insured                                      Date</w:t></w:r></w:p>
    <w:p/>
    <w:p/>
    
    <w:p><w:r><w:t>___________________________________          ________________</w:t></w:r></w:p>
    <w:p><w:r><w:t>Signature of Public Adjuster                           Date</w:t></w:r></w:p>
    <w:p/>
    <w:p/>
    
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/><w:i/><w:color w:val="666666"/></w:rPr><w:t>Generated on {generated_date} by {company_name}</w:t></w:r></w:p>
    
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`);
  
  return zip.generate({ type: "uint8array" });
}
