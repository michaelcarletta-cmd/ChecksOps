import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Maximum photos to include in PDF
const MAX_PHOTOS = 20;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { claimId, reportTitle, photoUrls, companyBranding, includeAiContext } = await req.json();

    if (!claimId) {
      return new Response(
        JSON.stringify({ error: "No claim ID provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch claim data
    const { data: claimData } = await supabase
      .from("claims")
      .select("*")
      .eq("id", claimId)
      .single();

    const allPhotos = photoUrls || [];
    const photosToInclude = allPhotos.slice(0, MAX_PHOTOS);
    
    console.log(`Generating PDF photo report with ${photosToInclude.length} photos, includeAiContext: ${includeAiContext}`);

    const reportDate = new Date().toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });

    // Generate HTML for PDF - photos are referenced by URL, not embedded
    const photoRowsHtml = photosToInclude.map((photo: any, idx: number) => {
      // Build AI analysis section if available - keep it concise to fit on one page
      let aiAnalysisHtml = '';
      if (photo.aiAnalysis) {
        const analysis = photo.aiAnalysis;
        
        // Limit detected damages to top 3 to prevent overflow
        const topDamages = (analysis.detected_damages || []).slice(0, 3);
        
        aiAnalysisHtml = `
          <div class="ai-analysis">
            <div class="ai-header">
              <span class="ai-title">Damage Assessment</span>
            </div>
            <div class="ai-grid">
              ${analysis.material_type ? `<div class="ai-item"><span class="ai-label">Material:</span> <span class="ai-value">${escapeHtml(analysis.material_type)}</span></div>` : ''}
            </div>
            ${topDamages.length > 0 ? `
              <div class="ai-damages">
                <div class="ai-damages-title">Detected Damages:</div>
                ${topDamages.map((d: any) => `
                  <div class="ai-damage-item">
                    <span class="damage-type">${escapeHtml(d.type)}</span>
                    <span class="damage-severity severity-${escapeHtml(d.severity || 'moderate')}">${escapeHtml(d.severity || 'N/A')}</span>
                    ${d.location ? `<span class="damage-location">at ${escapeHtml(d.location)}</span>` : ''}
                  </div>
                `).join('')}
              </div>
            ` : ''}
            ${analysis.summary ? `<div class="ai-summary">${escapeHtml(analysis.summary)}</div>` : ''}
          </div>
        `;
      } else if (includeAiContext && photo.aiContext) {
        aiAnalysisHtml = `
          <div class="ai-context">
            <span class="ai-label">Damage Assessment:</span>
            <span class="ai-text">${escapeHtml(photo.aiContext)}</span>
          </div>
        `;
      }

      return `
        ${idx > 0 ? '<div class="page-break"></div>' : ''}
        <div class="photo-card">
          <div class="photo-header">
            <span class="photo-number">Photo ${photo.photoNumber || idx + 1}</span>
            <span class="photo-category">${escapeHtml(photo.category || 'General')}</span>
          </div>
          <div class="photo-container">
            <img src="${escapeHtml(photo.url)}" alt="Photo ${photo.photoNumber || idx + 1}" />
          </div>
          <div class="photo-details">
            <div class="photo-filename">${escapeHtml(photo.fileName || `Photo ${idx + 1}`)}</div>
            ${photo.description ? `<div class="photo-description">${escapeHtml(photo.description)}</div>` : ''}
            ${aiAnalysisHtml}
          </div>
        </div>
      `;
    }).join('');

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(reportTitle || 'Photo Report')}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
      background: white; 
      color: #333; 
      line-height: 1.4;
    }
    .header { 
      background: linear-gradient(135deg, #1e3a5f 0%, #2d5a87 100%); 
      color: white; 
      padding: 30px; 
      text-align: center;
    }
    .header h1 { font-size: 24px; margin-bottom: 8px; }
    .header .company { font-size: 16px; opacity: 0.9; margin-bottom: 4px; }
    .header .date { font-size: 13px; opacity: 0.8; }
    .claim-info {
      background: white;
      padding: 15px 30px;
      border-bottom: 1px solid #ddd;
    }
    .claim-info-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 15px;
    }
    .claim-info-item { flex: 1; min-width: 150px; }
    .claim-info-label { font-size: 10px; color: #666; text-transform: uppercase; }
    .claim-info-value { font-size: 14px; font-weight: 600; }
    .photos-container { 
      padding: 0;
    }
    .photo-card { 
      background: white; 
      page-break-inside: avoid;
      break-inside: avoid;
      padding: 15px 30px;
    }
    .page-break {
      page-break-after: always;
      break-after: always;
      height: 0;
      display: block;
    }
    .photo-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #eee;
    }
    .photo-number { font-weight: 600; color: #1e3a5f; font-size: 14px; }
    .photo-category { 
      font-size: 11px; 
      padding: 3px 8px; 
      background: #e3f2fd; 
      color: #1976d2; 
      border-radius: 10px;
    }
    .photo-container { 
      padding: 10px 0;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
    }
    .photo-container img { 
      max-width: 100%; 
      max-height: 4.5in;
      object-fit: contain;
      border-radius: 4px;
    }
    .photo-details { 
      padding: 8px 0 0 0; 
    }
    .photo-filename { font-weight: 500; font-size: 12px; margin-bottom: 2px; }
    .photo-description { font-size: 12px; color: #666; margin-bottom: 4px; }
    .ai-context {
      margin-top: 6px;
      padding: 8px;
      background: linear-gradient(135deg, #f0f7ff 0%, #e8f4f8 100%);
      border-left: 3px solid #2196f3;
      border-radius: 4px;
    }
    .ai-label {
      display: block;
      font-size: 10px;
      font-weight: 600;
      color: #1976d2;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .ai-text {
      font-size: 11px;
      color: #333;
      line-height: 1.4;
    }
    .ai-analysis {
      margin-top: 8px;
      padding: 10px;
      background: linear-gradient(135deg, #f8fbff 0%, #f0f7ff 100%);
      border: 1px solid #d4e5f7;
      border-left: 3px solid #1976d2;
      border-radius: 4px;
    }
    .ai-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      padding-bottom: 4px;
      border-bottom: 1px solid #e3f2fd;
    }
    .ai-title {
      font-size: 11px;
      font-weight: 600;
      color: #1565c0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .ai-grid {
      display: flex;
      gap: 16px;
      margin-bottom: 6px;
    }
    .ai-item { font-size: 11px; }
    .ai-item .ai-label {
      display: inline;
      font-weight: 600;
      color: #555;
      text-transform: none;
      margin-bottom: 0;
    }
    .ai-item .ai-value {
      font-weight: 500;
      color: #333;
      text-transform: capitalize;
    }
    .ai-condition-excellent, .ai-condition-good { color: #2e7d32; font-weight: 600; }
    .ai-condition-fair { color: #f57c00; font-weight: 600; }
    .ai-condition-poor { color: #d84315; font-weight: 600; }
    .ai-condition-failed { color: #c62828; font-weight: 700; }
    .ai-notes {
      font-size: 11px;
      color: #444;
      line-height: 1.3;
      margin-bottom: 6px;
    }
    .ai-damages { margin-top: 6px; }
    .ai-damages-title {
      font-size: 10px;
      font-weight: 600;
      color: #c62828;
      margin-bottom: 4px;
    }
    .ai-damage-item {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      margin-bottom: 3px;
      background: #fff5f5;
      border: 1px solid #ffcdd2;
      border-radius: 4px;
      font-size: 10px;
    }
    .damage-type { font-weight: 600; color: #c62828; }
    .damage-severity {
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .severity-minor { background: #fff3e0; color: #e65100; }
    .severity-moderate { background: #ffecb3; color: #ff6f00; }
    .severity-severe { background: #ffcdd2; color: #c62828; }
    .damage-location { color: #666; font-style: italic; font-size: 10px; }
    .ai-summary {
      margin-top: 6px;
      padding: 6px 8px;
      background: #e3f2fd;
      border-radius: 4px;
      font-size: 11px;
      font-style: italic;
      color: #1565c0;
      line-height: 1.3;
    }
    .footer {
      text-align: center;
      padding: 15px;
      color: #666;
      font-size: 11px;
      border-top: 1px solid #ddd;
      background: white;
    }
    @media print {
      body { background: white; }
      .page-break { page-break-after: always; break-after: always; }
      .photo-card { page-break-inside: avoid; break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="company">${escapeHtml(companyBranding?.company_name || 'Freedom Adjustment')}</div>
    <h1>${escapeHtml(reportTitle || 'Photo Documentation Report')}</h1>
    <div class="date">${reportDate}</div>
  </div>
  
  <div class="claim-info">
    <div class="claim-info-grid">
      <div class="claim-info-item">
        <div class="claim-info-label">Claim Number</div>
        <div class="claim-info-value">${escapeHtml(claimData?.claim_number || 'N/A')}</div>
      </div>
      <div class="claim-info-item">
        <div class="claim-info-label">Policyholder</div>
        <div class="claim-info-value">${escapeHtml(claimData?.policyholder_name || 'N/A')}</div>
      </div>
      <div class="claim-info-item">
        <div class="claim-info-label">Property Address</div>
        <div class="claim-info-value">${escapeHtml(claimData?.policyholder_address || 'N/A')}</div>
      </div>
      <div class="claim-info-item">
        <div class="claim-info-label">Loss Date</div>
        <div class="claim-info-value">${claimData?.loss_date ? new Date(claimData.loss_date).toLocaleDateString() : 'N/A'}</div>
      </div>
    </div>
  </div>

  <div class="photos-container">
    ${photoRowsHtml}
  </div>

  <div class="footer">
    Generated on ${reportDate} • ${photosToInclude.length} photos included
    ${allPhotos.length > MAX_PHOTOS ? ` • ${allPhotos.length - MAX_PHOTOS} additional photos available in system` : ''}
  </div>
</body>
</html>`;

    // Return HTML for client-side PDF generation (using html2pdf.js)
    return new Response(
      JSON.stringify({ 
        html,
        photoCount: photosToInclude.length,
        totalPhotos: allPhotos.length
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error generating photo report PDF:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
