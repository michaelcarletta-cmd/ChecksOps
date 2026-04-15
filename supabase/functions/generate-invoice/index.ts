import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const logStep = (step: string, details?: any) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[GENERATE-INVOICE] ${step}${detailsStr}`);
};

function generateInvoiceHtml(data: any): string {
  const { invoiceNumber, invoiceDate, dueDate, sender, recipient, lineItems, subtotal, notes, claimNumber, policyholderName, workDescription, settlementBreakdown, supplementAmount, photos } = data;

  const itemsHtml = lineItems.map((item: any) => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">${item.description}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">${item.quantity}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">$${item.unitPrice.toFixed(2)}</td>
      <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">$${(item.quantity * item.unitPrice).toFixed(2)}</td>
    </tr>
  `).join('');

  // Use sender info (company branding or contractor)
  const companyName = sender?.name || 'Your Company';
  const companyEmail = sender?.email || '';
  const companyPhone = sender?.phone || '';
  const companyAddress = sender?.address || '';
  const companyLogo = sender?.logoUrl || '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Invoice ${invoiceNumber}</title>
  <style>
    /* Base styles */
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 40px; color: #1f2937; }
    
    /* Page break controls for PDF/Print */
    @media print {
      body { padding: 20px; }
      .page-break { page-break-before: always; }
      .avoid-break { page-break-inside: avoid; }
      .keep-together { page-break-inside: avoid; break-inside: avoid; }
      .invoice-header { page-break-after: avoid; }
      .breakdown-section { page-break-inside: avoid; }
      .totals { page-break-inside: avoid; }
      .notes { page-break-inside: avoid; }
      .footer { page-break-before: avoid; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; page-break-after: auto; }
      thead { display: table-header-group; }
      tfoot { display: table-footer-group; }
    }
    
    /* Header styles */
    .invoice-header { display: flex; justify-content: space-between; margin-bottom: 30px; align-items: flex-start; }
    .company-info { display: flex; flex-direction: column; gap: 6px; }
    .company-logo { max-height: 60px; max-width: 180px; margin-bottom: 10px; object-fit: contain; }
    .company-name { font-size: 24px; font-weight: bold; color: #1f2937; margin-bottom: 6px; }
    .company-info p { margin: 3px 0; color: #6b7280; font-size: 13px; }
    .invoice-details { text-align: right; }
    .invoice-details h2 { margin: 0 0 10px 0; font-size: 28px; color: #111827; }
    .invoice-details p { margin: 3px 0; color: #6b7280; font-size: 13px; }
    .invoice-details strong { color: #111827; }
    
    /* Sections - compact to fit better */
    .recipient-section { margin-bottom: 20px; padding: 15px; background: #f9fafb; border-radius: 8px; }
    .recipient-section h3 { margin: 0 0 8px 0; color: #374151; font-size: 12px; text-transform: uppercase; }
    .recipient-section p { margin: 3px 0; color: #1f2937; font-size: 14px; }
    .property-section { margin-bottom: 20px; padding: 12px 15px; background: #eff6ff; border-radius: 8px; border-left: 4px solid #3b82f6; }
    .property-section h3 { margin: 0 0 6px 0; color: #1e40af; font-size: 12px; text-transform: uppercase; }
    .property-section p { margin: 3px 0; color: #1e3a8a; font-size: 14px; }
    
    /* Table styles */
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th { background: #1f2937; color: white; padding: 10px 8px; text-align: left; font-weight: 600; font-size: 13px; }
    th:nth-child(2), th:nth-child(3), th:nth-child(4) { text-align: center; }
    th:last-child { text-align: right; }
    td { padding: 10px 8px; border-bottom: 1px solid #e5e7eb; font-size: 13px; }
    
    /* Totals */
    .totals { margin-left: auto; width: 280px; margin-top: 15px; }
    .totals .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-size: 14px; }
    .totals .row.total { border-top: 2px solid #1f2937; border-bottom: none; font-size: 18px; font-weight: bold; padding-top: 12px; }
    
    /* Notes */
    .notes { margin-top: 25px; padding: 15px; background: #fef3c7; border-radius: 8px; border-left: 4px solid #f59e0b; }
    .notes h4 { margin: 0 0 6px 0; color: #92400e; font-size: 13px; }
    .notes p { margin: 0; color: #78350f; font-size: 13px; }
    
    /* Footer */
    .footer { margin-top: 40px; text-align: center; color: #9ca3af; font-size: 11px; padding-top: 15px; border-top: 1px solid #e5e7eb; }
    
    /* Badge */
    .claim-badge { display: inline-block; background: #dbeafe; color: #1e40af; padding: 3px 10px; border-radius: 20px; font-size: 11px; }
    
    /* Breakdown section - compact grid */
    .breakdown-section { margin-bottom: 20px; padding: 15px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; }
    .breakdown-section h3 { margin: 0 0 12px 0; color: #334155; font-size: 12px; text-transform: uppercase; font-weight: 600; }
    .breakdown-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .breakdown-item { display: flex; justify-content: space-between; padding: 6px 10px; background: white; border-radius: 6px; border: 1px solid #e2e8f0; }
    .breakdown-item.highlight { background: #ecfdf5; border-color: #10b981; }
    .breakdown-item.outstanding { background: #fef2f2; border-color: #ef4444; }
    .breakdown-item .label { color: #64748b; font-size: 12px; }
    .breakdown-item .value { font-weight: 600; color: #1e293b; font-size: 12px; }
    .breakdown-item.highlight .value { color: #059669; }
    .breakdown-item.outstanding .value { color: #dc2626; }
    
    /* Work description - handle long text better */
    .work-section { margin-bottom: 20px; padding: 15px; background: #f0fdf4; border-radius: 8px; border-left: 4px solid #22c55e; }
    .work-section h3 { margin: 0 0 10px 0; color: #166534; font-size: 12px; text-transform: uppercase; }
    .work-section p { margin: 0; color: #15803d; line-height: 1.5; font-size: 13px; white-space: pre-wrap; word-wrap: break-word; }
  </style>
</head>
<body>
  <div class="invoice-header">
    <div class="company-info">
      ${companyLogo ? `<img src="${companyLogo}" alt="${companyName} Logo" class="company-logo" />` : ''}
      <div class="company-name">${companyName}</div>
      ${companyAddress ? `<p>${companyAddress}</p>` : ''}
      ${companyPhone ? `<p>Phone: ${companyPhone}</p>` : ''}
      ${companyEmail ? `<p>Email: ${companyEmail}</p>` : ''}
      ${claimNumber ? `<span class="claim-badge">Claim #${claimNumber}</span>` : ''}
    </div>
    <div class="invoice-details">
      <h2>INVOICE</h2>
      <p><strong>Invoice #:</strong> ${invoiceNumber}</p>
      <p><strong>Date:</strong> ${new Date(invoiceDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
      <p><strong>Due Date:</strong> ${new Date(dueDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
    </div>
  </div>

  <div class="recipient-section">
    <h3>Bill To</h3>
    <p><strong>${recipient.name}</strong></p>
    ${recipient.email ? `<p>${recipient.email}</p>` : ''}
    ${recipient.address ? `<p>${recipient.address.replace(/\n/g, '<br>')}</p>` : ''}
  </div>

  ${policyholderName ? `
  <div class="property-section">
    <h3>Property Owner / Insured</h3>
    <p><strong>${policyholderName}</strong></p>
  </div>
  ` : ''}

  ${settlementBreakdown ? `
  <div class="breakdown-section avoid-break keep-together">
    <h3>Settlement Breakdown by Coverage</h3>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 15px; font-size: 12px;">
      <thead>
        <tr style="background: #f1f5f9;">
          <th style="padding: 8px; text-align: left; border: 1px solid #e2e8f0;">Coverage</th>
          <th style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">RCV</th>
          <th style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">Recoverable Depreciation</th>
        </tr>
      </thead>
      <tbody>
        ${settlementBreakdown.dwellingRCV > 0 || settlementBreakdown.dwellingRD > 0 ? `
        <tr>
          <td style="padding: 8px; border: 1px solid #e2e8f0;">Dwelling/Structure</td>
          <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">$${settlementBreakdown.dwellingRCV?.toFixed(2) || '0.00'}</td>
          <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">$${settlementBreakdown.dwellingRD?.toFixed(2) || '0.00'}</td>
        </tr>
        ` : ''}
        ${settlementBreakdown.otherStructuresRCV > 0 || settlementBreakdown.otherStructuresRD > 0 ? `
        <tr>
          <td style="padding: 8px; border: 1px solid #e2e8f0;">Other Structures</td>
          <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">$${settlementBreakdown.otherStructuresRCV?.toFixed(2) || '0.00'}</td>
          <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">$${settlementBreakdown.otherStructuresRD?.toFixed(2) || '0.00'}</td>
        </tr>
        ` : ''}
        ${settlementBreakdown.pwiRCV > 0 || settlementBreakdown.pwiRD > 0 ? `
        <tr>
          <td style="padding: 8px; border: 1px solid #e2e8f0;">Paid When Incurred</td>
          <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">$${settlementBreakdown.pwiRCV?.toFixed(2) || '0.00'}</td>
          <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">$${settlementBreakdown.pwiRD?.toFixed(2) || '0.00'}</td>
        </tr>
        ` : ''}
        ${settlementBreakdown.personalPropertyRCV > 0 || settlementBreakdown.personalPropertyRD > 0 ? `
        <tr>
          <td style="padding: 8px; border: 1px solid #e2e8f0;">Personal Property</td>
          <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">$${settlementBreakdown.personalPropertyRCV?.toFixed(2) || '0.00'}</td>
          <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">$${settlementBreakdown.personalPropertyRD?.toFixed(2) || '0.00'}</td>
        </tr>
        ` : ''}
        <tr style="background: #ecfdf5; font-weight: bold;">
          <td style="padding: 8px; border: 1px solid #e2e8f0;">TOTAL</td>
          <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0;">$${settlementBreakdown.rcv?.toFixed(2) || '0.00'}</td>
          <td style="padding: 8px; text-align: right; border: 1px solid #e2e8f0; color: #059669;">$${settlementBreakdown.recoverableDepreciation?.toFixed(2) || '0.00'}</td>
        </tr>
      </tbody>
    </table>
    
    <div class="breakdown-grid">
      <div class="breakdown-item">
        <span class="label">Deductible</span>
        <span class="value">$${settlementBreakdown.deductible?.toFixed(2) || '0.00'}</span>
      </div>
      <div class="breakdown-item">
        <span class="label">Payments Received</span>
        <span class="value">$${settlementBreakdown.paymentsReceived?.toFixed(2) || '0.00'}</span>
      </div>
      ${settlementBreakdown.paymentsOutstanding > 0 ? `
      <div class="breakdown-item outstanding">
        <span class="label">ACV Payments Outstanding</span>
        <span class="value">$${settlementBreakdown.paymentsOutstanding?.toFixed(2) || '0.00'}</span>
      </div>
      ` : ''}
      ${settlementBreakdown.nonRecoverableDepreciation > 0 ? `
      <div class="breakdown-item">
        <span class="label">Non-Recoverable Depreciation</span>
        <span class="value">$${settlementBreakdown.nonRecoverableDepreciation?.toFixed(2) || '0.00'}</span>
      </div>
      ` : ''}
      ${settlementBreakdown.supplement > 0 ? `
      <div class="breakdown-item highlight">
        <span class="label">Supplement Amount</span>
        <span class="value">$${settlementBreakdown.supplement?.toFixed(2) || '0.00'}</span>
      </div>
      ` : ''}
    </div>
  </div>
  ` : ''}

  ${workDescription ? `
  <div class="work-section avoid-break">
    <h3>Work Completed</h3>
    <p>${workDescription}</p>
  </div>
  ` : ''}

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th>Qty</th>
        <th>Unit Price</th>
        <th>Amount</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHtml}
    </tbody>
  </table>

  <div class="totals avoid-break keep-together">
    <div class="row">
      <span>Subtotal</span>
      <span>$${subtotal.toFixed(2)}</span>
    </div>
    <div class="row total">
      <span>Total Due</span>
      <span>$${subtotal.toFixed(2)}</span>
    </div>
  </div>

  ${notes ? `
  <div class="notes avoid-break">
    <h4>Notes</h4>
    <p>${notes}</p>
  </div>
  ` : ''}

  ${photos && photos.length > 0 ? `
  <div class="page-break"></div>
  <div style="margin-top: 20px;">
    <h2 style="font-size: 20px; color: #1f2937; margin-bottom: 15px; border-bottom: 2px solid #1f2937; padding-bottom: 8px;">
      Photo Documentation (${photos.length} ${photos.length === 1 ? 'Photo' : 'Photos'})
    </h2>
    <p style="color: #6b7280; font-size: 12px; margin-bottom: 20px;">
      The following photos document the completed repairs and condition of the property for Claim #${claimNumber || 'N/A'}.
    </p>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
      ${photos.map((photo: any, index: number) => `
        <div class="avoid-break" style="border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <img src="${photo.url}" alt="${photo.name}" style="width: 100%; height: 250px; object-fit: cover;" />
          <div style="padding: 8px 10px; background: #f9fafb;">
            <p style="margin: 0; font-size: 11px; font-weight: 600; color: #374151;">${photo.name}</p>
            ${photo.description ? `<p style="margin: 2px 0 0; font-size: 10px; color: #6b7280;">${photo.description}</p>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  </div>
  ` : ''}

  <div class="footer">
    <p>Thank you for your business!</p>
    ${companyEmail ? `<p>Questions? Contact us at ${companyEmail}</p>` : ''}
  </div>
</body>
</html>
  `;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const data = await req.json();
    logStep("Received invoice data", { 
      invoiceNumber: data.invoiceNumber, 
      sender: data.sender?.name,
      recipient: data.recipient?.name 
    });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Generate HTML invoice
    const invoiceHtml = generateInvoiceHtml(data);
    logStep("Generated invoice HTML");

    // Create PDF-like content by saving HTML to storage
    const fileName = `invoices/${data.invoiceNumber}-${Date.now()}.html`;
    const encoder = new TextEncoder();
    const htmlBuffer = encoder.encode(invoiceHtml);

    const { error: uploadError } = await supabase.storage
      .from("document-templates")
      .upload(fileName, htmlBuffer, {
        contentType: "text/html",
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to save invoice: ${uploadError.message}`);
    }

    // Get signed URL for download
    const { data: signedUrlData, error: urlError } = await supabase.storage
      .from("document-templates")
      .createSignedUrl(fileName, 7 * 24 * 60 * 60); // 7 days

    if (urlError) {
      throw new Error(`Failed to get invoice URL: ${urlError.message}`);
    }

    logStep("Invoice saved successfully", { fileName });

    return new Response(JSON.stringify({ 
      success: true, 
      pdfUrl: signedUrlData.signedUrl,
      fileName 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logStep("ERROR", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
