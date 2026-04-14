import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Maximum photos to embed - set to 0 to skip embedding (prevents memory issues with large photos)
const MAX_PHOTOS_TO_EMBED = 0;
// Maximum size per image (500KB - most photos exceed this so we skip them)
const MAX_IMAGE_SIZE = 500 * 1024;

// Use AI to select the most relevant photos for the report
async function selectBestPhotos(
  reportContent: string,
  allPhotos: { photoNumber: number; fileName: string; category: string; description: string; url: string }[],
  maxPhotos: number
): Promise<number[]> {
  if (allPhotos.length <= maxPhotos) {
    return allPhotos.slice(0, maxPhotos).map(p => p.photoNumber);
  }

  try {
    const { generate } = await import("../_shared/ai/generate.ts");

    const photoSummary = allPhotos.map(p => 
      `Photo ${p.photoNumber}: "${p.fileName}" - Category: ${p.category}${p.description ? `, Description: ${p.description}` : ''}`
    ).join('\n');

    const result = await generate({
      task: 'classification',
      system: `You are a photo selection assistant for insurance claim reports. Select the most relevant photos to include based on the report content. Select photos that:
1. Are specifically referenced or discussed in the report
2. Show the most significant damage
3. Provide the best visual documentation of key findings
4. Cover different aspects of the damage (variety is good)

Return ONLY a JSON array of photo numbers to include, like: [1, 3, 5, 7]. Select up to ${maxPhotos} photos maximum.`,
      user: `Based on this report content, select the ${maxPhotos} most relevant photos to embed in the document.

REPORT CONTENT:
${reportContent.substring(0, 4000)}

AVAILABLE PHOTOS:
${photoSummary}

Return ONLY a JSON array of photo numbers (e.g., [1, 3, 5, 7]). No other text.`,
      searchMode: 'off',
    });

    console.log(`[generate-photo-report-docx] model=${result.model}, cached=${result.cached}`);

    const content = result.text;
    const match = content.match(/\[[\d,\s]+\]/);
    if (match) {
      const selectedNumbers = JSON.parse(match[0]) as number[];
      console.log(`AI selected photos: ${selectedNumbers.join(', ')}`);
      return selectedNumbers.slice(0, maxPhotos);
    }
    
    return allPhotos.slice(0, maxPhotos).map(p => p.photoNumber);
  } catch (error) {
    console.error("Error in AI photo selection:", error);
    return allPhotos.slice(0, maxPhotos).map(p => p.photoNumber);
  }
}

// Download image and convert to base64 - resize if needed
async function downloadImageAsBase64(url: string): Promise<{ base64: string; contentType: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to download image: ${response.status}`);
      return null;
    }
    
    const contentType = response.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await response.arrayBuffer();
    
    // Skip images that are too large (over 2MB to prevent memory issues)
    if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
      console.log(`Skipping large image (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)}MB > 2MB limit)`);
      return null;
    }
    
    console.log(`Downloaded image: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`);
    
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Convert to base64
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64 = btoa(binary);
    
    return { base64, contentType };
  } catch (error) {
    console.error("Error downloading image:", error);
    return null;
  }
}

// Get image extension from content type
function getImageExtension(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("webp")) return "webp";
  return "jpeg";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { reportContent, claimId, reportTitle, reportType, photoUrls, weatherData, companyBranding, includeLogoHeader, headerLogoUrl } = await req.json();

    if (!reportContent) {
      return new Response(
        JSON.stringify({ error: "No report content provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch claim data for additional context
    let claimData: any = null;
    if (claimId) {
      const { data: claim } = await supabase
        .from("claims")
        .select("*")
        .eq("id", claimId)
        .single();
      claimData = claim;
    }

    // Fetch company branding if not provided
    let branding = companyBranding;
    if (!branding) {
      const { data: brandingData } = await supabase
        .from("company_branding")
        .select("*")
        .limit(1)
        .single();
      branding = brandingData;
    }

    const allPhotos = photoUrls || [];
    console.log(`Total photos available: ${allPhotos.length}`);
    
    // Skip photo embedding entirely to prevent memory issues - photos are typically 4MB+ each
    // The report will include text references to photos instead
    const downloadedImages: { base64: string; extension: string; photoNumber: number; fileName: string; category: string; description: string }[] = [];
    const skippedPhotos = allPhotos.length;
    
    console.log(`Skipping photo embedding to prevent memory issues. ${skippedPhotos} photos referenced in text only.`);

    // Use PizZip to create the Word document
    const PizZip = (await import("https://esm.sh/pizzip@3.1.4")).default;

    // Format the report date
    const reportDate = new Date().toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });

    // Build weather summary if available
    let weatherSummary = "";
    if (weatherData && weatherData.daily) {
      const idx = weatherData.dayIndex >= 0 ? weatherData.dayIndex : 1;
      weatherSummary = `Weather on ${weatherData.lossDate}: ${weatherData.daily.weatherDescription?.[idx] || 'N/A'}, ` +
        `High ${weatherData.daily.maxTemp?.[idx]}°F, Wind ${weatherData.daily.maxWindSpeed?.[idx]} mph`;
    }

    // Create DOCX with embedded images
    const zip = new PizZip();
    
    // Check if we should add a header with logo
    const logoUrl = headerLogoUrl || branding?.letterhead_url || branding?.logo_url || null;
    const hasLogoHeader = includeLogoHeader && logoUrl;
    let headerLogoBase64 = "";
    let headerLogoExtension = "png";
    
    if (hasLogoHeader) {
      try {
        const logoResponse = await fetch(logoUrl);
        if (logoResponse.ok) {
          const logoBuffer = await logoResponse.arrayBuffer();
          // Only include if under 500KB
          if (logoBuffer.byteLength < 500 * 1024) {
            const uint8Array = new Uint8Array(logoBuffer);
            let binary = '';
            for (let i = 0; i < uint8Array.length; i++) {
              binary += String.fromCharCode(uint8Array[i]);
            }
            headerLogoBase64 = btoa(binary);
            const contentType = logoResponse.headers.get("content-type") || "image/png";
            headerLogoExtension = contentType.includes("png") ? "png" : contentType.includes("gif") ? "gif" : "jpeg";
            console.log(`Logo downloaded: ${(logoBuffer.byteLength / 1024).toFixed(1)}KB`);
          }
        }
      } catch (e) {
        console.error("Failed to download logo:", e);
      }
    }
    
    // Build content types with image types
    const imageExtensions = [...new Set([...downloadedImages.map(img => img.extension), headerLogoBase64 ? headerLogoExtension : null].filter(Boolean))] as string[];
    const contentTypesExtensions = imageExtensions.map(ext => {
      const mimeType = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
      return `<Default Extension="${ext}" ContentType="${mimeType}"/>`;
    }).join("\n  ");

    // [Content_Types].xml - add header when branding is available
    const showHeader = includeLogoHeader !== false;
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${contentTypesExtensions}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  ${showHeader ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}
</Types>`);
    
    // _rels/.rels
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
    
    // Build image relationships
    const imageRelationships = downloadedImages.map((img, idx) => 
      `<Relationship Id="rId${idx + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${idx + 1}.${img.extension}"/>`
    ).join("\n  ");
    
    // word/_rels/document.xml.rels
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  ${showHeader ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ''}
  ${imageRelationships}
</Relationships>`);

    // Add images to word/media/
    for (let i = 0; i < downloadedImages.length; i++) {
      const img = downloadedImages[i];
      // Decode base64 to binary
      const binaryString = atob(img.base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let j = 0; j < binaryString.length; j++) {
        bytes[j] = binaryString.charCodeAt(j);
      }
      zip.file(`word/media/image${i + 1}.${img.extension}`, bytes);
      // Clear the base64 string to free memory
      img.base64 = '';
    }
    
    // Add header logo to media if we have it
    if (headerLogoBase64) {
      const binaryString = atob(headerLogoBase64);
      const bytes = new Uint8Array(binaryString.length);
      for (let j = 0; j < binaryString.length; j++) {
        bytes[j] = binaryString.charCodeAt(j);
      }
      zip.file(`word/media/header_logo.${headerLogoExtension}`, bytes);
      
      // Create header relationships
      zip.file("word/_rels/header1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/header_logo.${headerLogoExtension}"/>
</Relationships>`);
    }
    
    // Build header XML — logo + contact line, or text fallback
    if (showHeader) {
      // Logo: ~220px wide x 70px tall → 2.29in x 0.73in in EMUs
      const logoWidth = 2095500;
      const logoHeight = 666750;
      
      // Contact line under logo/name
      const escHeader = (str: string) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const contactParts = [branding?.company_phone, branding?.company_email].filter(Boolean);
      const contactLine = contactParts.length > 0 ? contactParts.join('  •  ') : '';
      const contactParagraph = contactLine ? `
  <w:p>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:r><w:rPr><w:sz w:val="18"/><w:color w:val="666666"/></w:rPr><w:t>${escHeader(contactLine)}</w:t></w:r>
  </w:p>` : '';
      
      if (headerLogoBase64) {
        // Logo header with contact line
        zip.file("word/header1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:r>
      <w:drawing>
        <wp:inline distT="0" distB="0" distL="0" distR="0">
          <wp:extent cx="${logoWidth}" cy="${logoHeight}"/>
          <wp:docPr id="100" name="Header Logo"/>
          <a:graphic>
            <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
              <pic:pic>
                <pic:nvPicPr>
                  <pic:cNvPr id="100" name="header_logo.${headerLogoExtension}"/>
                  <pic:cNvPicPr/>
                </pic:nvPicPr>
                <pic:blipFill>
                  <a:blip r:embed="rId1"/>
                  <a:stretch><a:fillRect/></a:stretch>
                </pic:blipFill>
                <pic:spPr>
                  <a:xfrm>
                    <a:off x="0" y="0"/>
                    <a:ext cx="${logoWidth}" cy="${logoHeight}"/>
                  </a:xfrm>
                  <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                </pic:spPr>
              </pic:pic>
            </a:graphicData>
          </a:graphic>
        </wp:inline>
      </w:drawing>
    </w:r>
  </w:p>${contactParagraph}
</w:hdr>`);
      } else {
        // Text-only fallback header — company name bold + contact line
        zip.file("word/header1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p>
    <w:pPr><w:jc w:val="center"/></w:pPr>
    <w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>${escHeader(branding?.company_name || 'Freedom Adjustment')}</w:t></w:r>
  </w:p>${contactParagraph}
</w:hdr>`);
      }
    }
    
    // word/styles.xml
    zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1">
    <w:name w:val="Normal"/>
    <w:pPr><w:spacing w:after="200" w:line="276" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Title"/>
    <w:pPr><w:spacing w:after="300"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="48"/><w:color w:val="1E3A5F"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Heading 1"/>
    <w:pPr><w:spacing w:before="400" w:after="200"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="32"/><w:color w:val="1E3A5F"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="Heading 2"/>
    <w:pPr><w:spacing w:before="300" w:after="150"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:b/><w:sz w:val="28"/><w:color w:val="374151"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="PhotoCaption">
    <w:name w:val="Photo Caption"/>
    <w:pPr><w:spacing w:before="100" w:after="300"/><w:jc w:val="center"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:i/><w:sz w:val="20"/><w:color w:val="666666"/></w:rPr>
  </w:style>
</w:styles>`);

    // Escape XML special characters in content
    const escapeXml = (str: string) => {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };

    // Convert content to paragraphs with proper XML escaping
    const contentParagraphs = reportContent.split('\n').map((line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return '<w:p/>';
      
      // Check if it's a heading
      if (trimmed.match(/^[A-Z][A-Z\s&]+:?$/) || trimmed.match(/^(SECTION|PART|CHAPTER)\s/i)) {
        return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXml(trimmed)}</w:t></w:r></w:p>`;
      }
      if (trimmed.match(/^\d+\.\s+[A-Z]/) || trimmed.match(/^Photo\s+\d+/i)) {
        return `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>${escapeXml(trimmed)}</w:t></w:r></w:p>`;
      }
      
      return `<w:p><w:r><w:t>${escapeXml(trimmed)}</w:t></w:r></w:p>`;
    }).join('\n    ');

    // Build photo gallery section with embedded images - smaller size
    // Image dimensions: width = 4 inches = 3657600 EMUs, height proportional (4:3 aspect)
    const imageWidth = 3657600; // 4 inches in EMUs
    const imageHeight = 2743200; // 3 inches in EMUs (4:3 aspect ratio)
    
    const photoGalleryXml = downloadedImages.map((img, idx) => {
      return `
    <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Photo ${img.photoNumber}: ${escapeXml(img.fileName)}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:i/></w:rPr><w:t>Category: ${escapeXml(img.category)}${img.description ? ' | ' + escapeXml(img.description) : ''}</w:t></w:r></w:p>
    <w:p>
      <w:pPr><w:jc w:val="center"/></w:pPr>
      <w:r>
        <w:drawing>
          <wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
            <wp:extent cx="${imageWidth}" cy="${imageHeight}"/>
            <wp:docPr id="${idx + 1}" name="Photo ${img.photoNumber}"/>
            <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
              <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
                <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
                  <pic:nvPicPr>
                    <pic:cNvPr id="${idx + 1}" name="image${idx + 1}.${img.extension}"/>
                    <pic:cNvPicPr/>
                  </pic:nvPicPr>
                  <pic:blipFill>
                    <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId${idx + 10}"/>
                    <a:stretch><a:fillRect/></a:stretch>
                  </pic:blipFill>
                  <pic:spPr>
                    <a:xfrm>
                      <a:off x="0" y="0"/>
                      <a:ext cx="${imageWidth}" cy="${imageHeight}"/>
                    </a:xfrm>
                    <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
                  </pic:spPr>
                </pic:pic>
              </a:graphicData>
            </a:graphic>
          </wp:inline>
        </w:drawing>
      </w:r>
    </w:p>
    <w:p/>`;
    }).join('\n');

    // Note about AI selection
    const totalPhotos = allPhotos.length;
    const embeddedCount = downloadedImages.length;
    const selectionNote = totalPhotos > embeddedCount ? 
      `<w:p><w:r><w:rPr><w:i/><w:color w:val="666666"/></w:rPr><w:t>Note: AI selected the ${embeddedCount} most relevant photos from ${totalPhotos} available. See the Photos tab for the complete set.</w:t></w:r></w:p>` : '';
    
    // word/document.xml - Main content with embedded images
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${escapeXml(reportTitle || "Photo Analysis Report")}</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/><w:color w:val="666666"/></w:rPr><w:t>${escapeXml(branding?.company_name || "Freedom Adjustment")}</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/><w:color w:val="666666"/></w:rPr><w:t>${escapeXml(reportDate)}</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Claim Information</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Claim Number: </w:t></w:r><w:r><w:t>${escapeXml(claimData?.claim_number || "")}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Policyholder: </w:t></w:r><w:r><w:t>${escapeXml(claimData?.policyholder_name || "")}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Property Address: </w:t></w:r><w:r><w:t>${escapeXml(claimData?.policyholder_address || "")}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Loss Date: </w:t></w:r><w:r><w:t>${escapeXml(claimData?.loss_date ? new Date(claimData.loss_date).toLocaleDateString() : "")}</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Insurance Company: </w:t></w:r><w:r><w:t>${escapeXml(claimData?.insurance_company || "")}</w:t></w:r></w:p>
    ${weatherSummary ? `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Weather Conditions: </w:t></w:r><w:r><w:t>${escapeXml(weatherSummary)}</w:t></w:r></w:p>` : ''}
    <w:p/>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Analysis Report</w:t></w:r></w:p>
    ${contentParagraphs}
    <w:p/>
    ${downloadedImages.length > 0 ? `
    <w:p><w:r><w:br w:type="page"/></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Photo Documentation</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:i/><w:color w:val="666666"/></w:rPr><w:t>The following ${downloadedImages.length} photos were selected by AI as most relevant to this report:</w:t></w:r></w:p>
    ${selectionNote}
    ${photoGalleryXml}
    ` : `
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Photo Documentation</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:i/><w:color w:val="666666"/></w:rPr><w:t>Photos could not be embedded due to file size limitations. Please refer to the Photos tab in the application for full resolution images.</w:t></w:r></w:p>
    `}
    <w:sectPr>${showHeader ? '<w:headerReference w:type="default" r:id="rId2"/>' : ''}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`);

    // Generate the output
    const outputBuffer = zip.generate({
      type: "uint8array",
      compression: "DEFLATE",
    });

    // Save to storage
    const fileName = `${claimId}/reports/ai_photo_report_${Date.now()}.docx`;
    const { error: uploadError } = await supabase.storage
      .from("claim-files")
      .upload(fileName, outputBuffer, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      throw new Error("Failed to save report to storage");
    }

    // Create claim file record
    await supabase.from("claim_files").insert({
      claim_id: claimId,
      file_name: `AI Photo Report - ${new Date().toLocaleDateString()}.docx`,
      file_path: fileName,
      file_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      file_size: outputBuffer.length,
    });

    // Get signed URL for download
    const { data: signedUrlData } = await supabase.storage
      .from("claim-files")
      .createSignedUrl(fileName, 3600);

    console.log(`Report generated with ${downloadedImages.length} AI-selected photos (${allPhotos.length - downloadedImages.length} not included)`);

    return new Response(
      JSON.stringify({ 
        success: true,
        downloadUrl: signedUrlData?.signedUrl,
        fileName: `AI Photo Report - ${new Date().toLocaleDateString()}.docx`,
        photosEmbedded: downloadedImages.length,
        photosSkipped: allPhotos.length - downloadedImages.length,
        aiSelected: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error generating Word document:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
