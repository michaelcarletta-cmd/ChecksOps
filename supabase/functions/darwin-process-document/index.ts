import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Document classification types
type DocumentClassification = 
  | 'estimate' 
  | 'denial' 
  | 'approval' 
  | 'rfi' 
  | 'engineering_report' 
  | 'policy' 
  | 'correspondence' 
  | 'invoice' 
  | 'photo' 
  | 'other';

interface ClassificationResult {
  classification: DocumentClassification;
  confidence: number;
  metadata: {
    date_mentioned: string | null;
    deadline_mentioned: string | null;
    amounts: Array<{ description: string; amount: number }>;
    key_phrases: string[];
    sender: 'carrier' | 'adjuster' | 'contractor' | 'policyholder' | 'unknown';
    requires_action: boolean;
    urgency: 'high' | 'medium' | 'low';
    summary: string;
    // Type-specific fields
    denial_reason?: string;
    denial_type?: 'full' | 'partial' | 'coverage' | 'causation' | 'procedure';
    estimate_type?: 'xactimate' | 'symbility' | 'contractor' | 'unknown';
    gross_rcv?: number;
    approved_amount?: number;
    payment_type?: 'initial' | 'supplement' | 'final';
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { fileId, claimId, fileName, fileContent } = await req.json();

    console.log("Darwin Document Processing starting...", { fileId, claimId, fileName });

    let file: any = null;
    let textContent = '';
    let targetClaimId = claimId;

    // If fileId provided, fetch file from database
    if (fileId) {
      const { data: fileData, error: fileError } = await supabase
        .from('claim_files')
        .select('*')
        .eq('id', fileId)
        .single();

      if (fileError || !fileData) {
        throw new Error(`File not found: ${fileId}`);
      }

      file = fileData;
      targetClaimId = file.claim_id;

      // Check if already processed
      if (file.processed_by_darwin) {
        return new Response(
          JSON.stringify({ 
            success: true, 
            message: 'File already processed',
            classification: file.document_classification 
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // GUARANTEE extracted_text is populated before any analysis
      if (file.extracted_text && file.extracted_text.length > 50) {
        textContent = file.extracted_text;
        console.log(`[TextExtract] Using existing extracted_text (${textContent.length} chars) for ${file.file_name}`);
      } else {
        // Download file and extract text
        const { data: fileBlob, error: downloadError } = await supabase.storage
          .from('claim-files')
          .download(file.file_path);

        if (!downloadError && fileBlob) {
          const fileType = file.file_type || '';
          if (fileType.includes('text') || file.file_name.endsWith('.txt')) {
            textContent = await fileBlob.text();
          } else if (fileType.includes('pdf')) {
            // Attempt PDF text extraction via raw bytes
            const pdfBytes = new Uint8Array(await fileBlob.arrayBuffer());
            textContent = extractPdfText(pdfBytes);
            console.log(`[TextExtract] PDF raw text extraction: ${textContent.length} chars for ${file.file_name}`);

            // If PDF text extraction yields < 300 chars, use OCR via vision AI
            if (textContent.length < 300) {
              console.log(`[TextExtract] PDF text < 300 chars, attempting OCR via vision for ${file.file_name}`);
              const ocrText = await ocrViaVision(pdfBytes, file.file_name);
              if (ocrText && ocrText.length > textContent.length) {
                textContent = ocrText;
                console.log(`[TextExtract] OCR yielded ${textContent.length} chars for ${file.file_name}`);
              }
            }
          } else if (/\.(png|jpg|jpeg|webp|gif|bmp|tiff?)$/i.test(file.file_name)) {
            // Image files: OCR via vision
            console.log(`[TextExtract] Image file, attempting OCR via vision for ${file.file_name}`);
            const imgBytes = new Uint8Array(await fileBlob.arrayBuffer());
            const ocrText = await ocrViaVision(imgBytes, file.file_name);
            if (ocrText) {
              textContent = ocrText;
              console.log(`[TextExtract] OCR yielded ${textContent.length} chars for ${file.file_name}`);
            }
          }
        }

        // Persist extracted_text to claim_files so it's always available
        if (textContent && textContent.length > 50 && !textContent.startsWith('[PDF Document')) {
          await supabase
            .from('claim_files')
            .update({ extracted_text: textContent.substring(0, 100000) })
            .eq('id', fileId);
          console.log(`[TextExtract] Stored extracted_text (${Math.min(textContent.length, 100000)} chars) for file ${fileId}`);
        }
      }
    } else if (fileContent) {
      // Direct content provided
      textContent = typeof fileContent === 'string' 
        ? fileContent 
        : atob(fileContent);
    }

    // If no text content, try to classify by filename patterns
    if (!textContent || textContent.length < 50) {
      const classificationFromName = classifyByFilename(fileName || file?.file_name || '');
      
      // Update file record with basic classification
      if (file) {
        await supabase
          .from('claim_files')
          .update({
            document_classification: classificationFromName,
            classification_confidence: 0.4,
            classification_metadata: { 
              method: 'filename_pattern',
              summary: `Classified as ${classificationFromName} based on filename` 
            },
            processed_by_darwin: true,
            darwin_processed_at: new Date().toISOString(),
          })
          .eq('id', fileId);
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          classification: classificationFromName,
          confidence: 0.4,
          method: 'filename_pattern'
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call AI for classification
    const classificationResult = await classifyDocument(textContent, fileName || file?.file_name || '');

    // Update file record with classification + store extracted text
    if (file) {
      const updatePayload: Record<string, unknown> = {
        document_classification: classificationResult.classification,
        classification_confidence: classificationResult.confidence,
        classification_metadata: classificationResult.metadata,
        processed_by_darwin: true,
        darwin_processed_at: new Date().toISOString(),
      };
      // Store extracted text for regex fallback and future analysis
      if (textContent && textContent.length > 50 && !textContent.startsWith('[PDF Document')) {
        updatePayload.extracted_text = textContent.substring(0, 100000); // cap at 100k chars
      }
      await supabase
        .from('claim_files')
        .update(updatePayload)
        .eq('id', fileId);
    }

    // Log the classification action
    await supabase
      .from('darwin_action_log')
      .insert({
        claim_id: targetClaimId,
        action_type: 'document_classified',
        action_details: {
          file_id: fileId,
          file_name: fileName || file?.file_name,
          classification: classificationResult.classification,
          confidence: classificationResult.confidence,
          metadata: classificationResult.metadata,
        },
        was_auto_executed: true,
        result: `Classified as ${classificationResult.classification} (${Math.round(classificationResult.confidence * 100)}% confidence): ${classificationResult.metadata.summary}`,
        trigger_source: 'darwin_process_document',
      });

    // === DOCUMENT-DRIVEN TIMELINE: Extract dates → claim_events ===
    if (targetClaimId && classificationResult.confidence >= 0.6) {
      // Log classification metadata for debugging date extraction
      console.log(`[DateExtract] classificationResult.metadata for ${fileName || file?.file_name}:`, JSON.stringify({
        document_date: (classificationResult.metadata as any).document_date,
        date_mentioned: classificationResult.metadata.date_mentioned,
        dates_found: (classificationResult.metadata as any).dates_found,
        deadline_mentioned: classificationResult.metadata.deadline_mentioned,
        date_confidence: (classificationResult.metadata as any).date_confidence,
      }));

      try {
        const insertedCount = await extractDatesToClaimEvents(
          supabase, targetClaimId, fileId, fileName || file?.file_name || '',
          classificationResult, textContent
        );
        console.log(`[DateExtract] Inserted ${insertedCount} claim_events for file ${fileId}`);
      } catch (err) {
        console.error('[DateExtract] FAILED for file', fileId, err);
      }
    }

    // === CROSS-CLAIM VECTOR INDEX: Chunk + Embed for retrieval ===
    if (textContent && textContent.length >= 100 && targetClaimId) {
      indexDocumentForRetrieval(
        supabase, targetClaimId, fileId, textContent,
        classificationResult, file
      ).catch(err => console.error('Cross-claim indexing error:', err));
    }

    // Check if claim has autonomy enabled and take actions
    const { data: automation } = await supabase
      .from('claim_automations')
      .select('*')
      .eq('claim_id', targetClaimId)
      .eq('is_enabled', true)
      .single();

    // Trigger deep analysis for key document types (high confidence only)
    if (classificationResult.confidence >= 0.8) {
      // Fire and forget - don't wait for deep analysis to complete
      triggerDeepAnalysis(
        supabase,
        targetClaimId,
        classificationResult.classification,
        fileId,
        file?.file_path
      ).catch(err => console.error('Deep analysis trigger error:', err));
    }

    // Process automation actions if enabled
    if (automation && classificationResult.confidence >= 0.8) {
      await processDocumentActions(
        supabase, 
        targetClaimId, 
        classificationResult, 
        automation,
        fileId
      );
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        classification: classificationResult.classification,
        confidence: classificationResult.confidence,
        metadata: classificationResult.metadata,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Darwin Document Processing error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// === PDF TEXT EXTRACTION (raw byte parsing) ===
function extractPdfText(bytes: Uint8Array): string {
  const rawText = new TextDecoder("latin1").decode(bytes);
  const textParts: string[] = [];
  
  // PDF BT/ET text extraction
  const btEtRegex = /BT\s([\s\S]*?)ET/g;
  let match;
  while ((match = btEtRegex.exec(rawText)) !== null) {
    const block = match[1];
    const strRegex = /\(([^)]*)\)/g;
    let strMatch;
    while ((strMatch = strRegex.exec(block)) !== null) {
      const decoded = strMatch[1]
        .replace(/\\n/g, '\n').replace(/\\r/g, '\r')
        .replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\');
      if (decoded.trim()) textParts.push(decoded);
    }
  }
  
  // If BT/ET yielded very little, try ASCII extraction
  if (textParts.length < 5) {
    const asciiRegex = /[A-Za-z0-9][A-Za-z0-9 ,.\-\/#:@$%&()]{4,}/g;
    let asciiMatch;
    while ((asciiMatch = asciiRegex.exec(rawText)) !== null) {
      textParts.push(asciiMatch[0].trim());
    }
  }
  
  return textParts.join(' ');
}

// === OCR VIA VISION AI (for scanned PDFs/images) ===
async function ocrViaVision(bytes: Uint8Array, fileName: string): Promise<string | null> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) return null;

  try {
    // Convert to base64
    const chunks: string[] = [];
    const chunkSize = 32768;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      chunks.push(String.fromCharCode(...chunk));
    }
    const base64 = btoa(chunks.join(''));
    
    const isPdf = fileName.toLowerCase().endsWith('.pdf');
    const mimeType = isPdf ? 'application/pdf' : 
      fileName.toLowerCase().match(/\.(png)$/) ? 'image/png' :
      fileName.toLowerCase().match(/\.(webp)$/) ? 'image/webp' :
      'image/jpeg';

    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: 'Extract ALL text content from this document image. Return the raw text exactly as it appears, preserving dates, numbers, names, and addresses. Do not summarize or interpret.' },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
            { type: 'text', text: 'Extract all text from this document. Return only the raw text content.' }
          ]}
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      console.error(`[OCR] Vision API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (error) {
    console.error('[OCR] Error:', error);
    return null;
  }
}

function classifyByFilename(filename: string): DocumentClassification {
  const lower = filename.toLowerCase();
  
  if (/estimate|xactimate|symbility|rcv|acv|scope/i.test(lower)) return 'estimate';
  if (/denial|denied|decline/i.test(lower)) return 'denial';
  if (/approval|approved|payment|settlement/i.test(lower)) return 'approval';
  if (/rfi|request.*info|additional.*info/i.test(lower)) return 'rfi';
  if (/engineer|structural|report/i.test(lower)) return 'engineering_report';
  
  // Policy detection
  const isPolicyKeyword = /policy|coverage|dec.*page|declaration/i.test(lower);
  const isPolicyNumberFormat = /^h[o0][-]?\d/i.test(lower) || /^dp[-]?\d/i.test(lower) || /^[a-z]{1,4}\d{4,}/i.test(lower);
  if (isPolicyKeyword || isPolicyNumberFormat) return 'policy';
  
  if (/invoice|bill|receipt/i.test(lower)) return 'invoice';
  if (/\.(jpg|jpeg|png|gif|heic|webp)$/i.test(lower)) return 'photo';
  
  return 'correspondence';
}

// Date validation helper - rejects unreasonable dates
function validateExtractedDate(dateStr: string | null): {
  isValid: boolean;
  correctedDate: string | null;
  warning: string | null;
} {
  if (!dateStr || dateStr === 'null') return { isValid: true, correctedDate: null, warning: null };
  
  const extracted = new Date(dateStr);
  if (isNaN(extracted.getTime())) {
    return { isValid: false, correctedDate: null, warning: `Invalid date format: ${dateStr}` };
  }
  
  const now = new Date();
  const tenYearsAgo = new Date();
  tenYearsAgo.setFullYear(now.getFullYear() - 10);
  
  // Reject dates more than 10 years old
  if (extracted < tenYearsAgo) {
    return {
      isValid: false,
      correctedDate: null,
      warning: `Extracted date ${dateStr} appears too old, likely a misread`
    };
  }
  
  // Reject future dates
  if (extracted > now) {
    return {
      isValid: false,
      correctedDate: null,
      warning: `Extracted date ${dateStr} is in the future`
    };
  }
  
  return { isValid: true, correctedDate: dateStr, warning: null };
}

async function classifyDocument(textContent: string, filename: string): Promise<ClassificationResult> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  
  if (!LOVABLE_API_KEY) {
    // Fallback to filename-based classification
    return {
      classification: classifyByFilename(filename),
      confidence: 0.5,
      metadata: {
        date_mentioned: null,
        deadline_mentioned: null,
        amounts: [],
        key_phrases: [],
        sender: 'unknown',
        requires_action: false,
        urgency: 'low',
        summary: 'Classified by filename pattern (AI unavailable)',
      }
    };
  }

  // Inject current date context for accurate date extraction
  const now = new Date();
  const currentDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const currentYear = now.getFullYear();

  const systemPrompt = `You are a document classifier for insurance claims.

IMPORTANT DATE CONTEXT:
- TODAY'S DATE: ${currentDate}
- CURRENT YEAR: ${currentYear}

Analyze the document and classify it.

DATE EXTRACTION RULES (CRITICAL):
1. Extract the DOCUMENT DATE - the date the letter/document was written or issued
2. This is typically found in the letterhead, header, or near the signature
3. Do NOT confuse this with loss dates, claim dates, or policy dates mentioned in the body
4. For 2-digit years: interpret based on current year (${currentYear}):
   - Years 00-29 are 2000-2029 (e.g., "26" = 2026)
   - Years 30-99 are 1930-1999 (e.g., "95" = 1995)
5. If no clear document date is found, return null - do NOT guess
6. Most insurance documents you receive will be from the past 2-3 years, rarely older

Return ONLY valid JSON with this structure:
{
  "classification": "estimate|denial|approval|rfi|engineering_report|policy|correspondence|invoice|photo|other",
  "confidence": 0.0-1.0,
  "metadata": {
    "document_date": "YYYY-MM-DD or null - the date this document was ISSUED/WRITTEN",
    "date_confidence": 0.0-1.0,
    "date_mentioned": "YYYY-MM-DD or null - DEPRECATED, same as document_date for backwards compatibility",
    "dates_found": [{"type": "letter_date|loss_date|claim_date|policy_date|deadline", "date": "YYYY-MM-DD", "context": "brief context"}],
    "deadline_mentioned": "YYYY-MM-DD or null",
    "amounts": [{"description": "...", "amount": 0.00}],
    "key_phrases": ["up to 5 key phrases"],
    "sender": "carrier|adjuster|contractor|policyholder|unknown",
    "requires_action": true/false,
    "urgency": "high|medium|low",
    "summary": "One sentence summary of the document"
  }
}

For DENIALS, also include:
- "denial_reason": Main reason given
- "denial_type": "full|partial|coverage|causation|procedure"

For ESTIMATES, also include:
- "estimate_type": "xactimate|symbility|contractor|unknown"
- "gross_rcv": Total RCV amount as number

For APPROVALS, also include:
- "approved_amount": Payment amount as number
- "payment_type": "initial|supplement|final"`;

  try {
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Filename: ${filename}\n\nDocument content:\n${textContent.substring(0, 15000)}` }
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      throw new Error(`AI API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    
    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }

    const result = JSON.parse(jsonMatch[0]) as ClassificationResult;
    
    // Post-extraction date validation
    const metadata = result.metadata as any;
    const documentDate = metadata.document_date || metadata.date_mentioned;
    const dateValidation = validateExtractedDate(documentDate);
    
    if (!dateValidation.isValid) {
      console.log(`Date validation failed: ${dateValidation.warning}`);
      // Clear invalid dates and lower confidence
      metadata.document_date = null;
      metadata.date_mentioned = null;
      metadata.date_confidence = 0;
      metadata.date_validation_warning = dateValidation.warning;
    } else if (documentDate) {
      // Ensure both fields are set for backwards compatibility
      metadata.document_date = dateValidation.correctedDate;
      metadata.date_mentioned = dateValidation.correctedDate;
    }
    
    return result;
  } catch (error) {
    console.error('AI classification error:', error);
    // Fallback to filename-based classification
    return {
      classification: classifyByFilename(filename),
      confidence: 0.5,
      metadata: {
        date_mentioned: null,
        deadline_mentioned: null,
        amounts: [],
        key_phrases: [],
        sender: 'unknown',
        requires_action: false,
        urgency: 'low',
        summary: 'Classification fallback due to AI error',
      }
    };
  }
}

// Trigger deep analysis for key document types (denial, engineer report, estimate)
async function triggerDeepAnalysis(
  supabase: any,
  claimId: string,
  classification: DocumentClassification,
  fileId: string,
  filePath: string | undefined
) {
  // Map classification to analysis type
  const analysisMap: Record<string, string> = {
    'denial': 'denial_rebuttal',
    'engineering_report': 'engineer_report_rebuttal',
    'estimate': 'estimate_gap_analysis',
  };

  const analysisType = analysisMap[classification];
  if (!analysisType || !filePath) return; // No deep analysis for this type

  console.log(`Triggering deep analysis: ${analysisType} for file ${fileId}`);

  try {
    // Check if this file was already analyzed in the last hour (prevent duplicate analyses)
    const { data: recentAnalysis } = await supabase
      .from('darwin_analysis_results')
      .select('id')
      .eq('claim_id', claimId)
      .eq('analysis_type', analysisType)
      .gte('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .limit(1);

    if (recentAnalysis && recentAnalysis.length > 0) {
      console.log(`Skipping ${analysisType} - already analyzed recently`);
      return;
    }

    // Download file for analysis
    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from('claim-files')
      .download(filePath);

    if (downloadError || !fileBlob) {
      console.error('Could not download file for deep analysis:', downloadError);
      return;
    }

    // Convert to base64
    const arrayBuffer = await fileBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode(...chunk);
    }
    const base64 = btoa(binary);

    // Call darwin-ai-analysis
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    fetch(`${SUPABASE_URL}/functions/v1/darwin-ai-analysis`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        claimId,
        analysisType,
        pdfContent: base64,
        pdfFileName: filePath.split('/').pop(),
        additionalContext: {
          auto_triggered: true,
          source_file_id: fileId,
          trigger_reason: `Automatically analyzed upon ${classification} detection`
        }
      })
    }).catch(err => console.error('Deep analysis call failed:', err));

    // Log the auto-analysis action
    await supabase.from('darwin_action_log').insert({
      claim_id: claimId,
      action_type: 'auto_deep_analysis',
      action_details: {
        file_id: fileId,
        classification,
        analysis_type: analysisType,
      },
      was_auto_executed: true,
      result: `Automatically triggered ${analysisType} for detected ${classification}`,
      trigger_source: 'darwin_document_intelligence',
    });

    console.log(`Deep analysis ${analysisType} triggered successfully for file ${fileId}`);
  } catch (error) {
    console.error('triggerDeepAnalysis error:', error);
    // Don't throw - deep analysis failure shouldn't affect classification
  }
}

// ============================================================
// CROSS-CLAIM VECTOR INDEXING
// Chunk, tag, and embed document text for retrieval
// ============================================================

const EVIDENCE_TYPE_MAP: Record<string, string> = {
  'estimate': 'estimate',
  'denial': 'denial_letter',
  'approval': 'approval_letter',
  'engineering_report': 'engineer_report',
  'policy': 'policy',
  'correspondence': 'correspondence',
  'invoice': 'invoice',
  'rfi': 'correspondence',
  'photo': 'photo_analysis',
  'other': 'other',
};

const LOSS_TYPE_MAP: Record<string, string> = {
  'wind': 'wind', 'hail': 'hail', 'water': 'water', 'fire': 'fire',
  'lightning': 'lightning', 'tornado': 'tornado', 'hurricane': 'hurricane',
  'theft': 'theft', 'vandalism': 'vandalism', 'collapse': 'collapse',
  'mold': 'mold', 'freeze': 'freeze',
};

function detectLossType(text: string): string | null {
  const lower = (text || '').toLowerCase();
  for (const [keyword, type] of Object.entries(LOSS_TYPE_MAP)) {
    if (lower.includes(keyword)) return type;
  }
  return null;
}

function detectTrade(text: string): string | null {
  const lower = (text || '').toLowerCase();
  const tradeMap: Record<string, string> = {
    'roof': 'roof', 'shingle': 'roof', 'siding': 'siding', 'gutter': 'gutters',
    'window': 'windows', 'door': 'doors', 'interior': 'interior', 'drywall': 'interior',
    'hvac': 'hvac', 'plumbing': 'plumbing', 'electrical': 'electrical',
    'foundation': 'foundation', 'fence': 'fence', 'deck': 'deck', 'garage': 'garage',
  };
  for (const [keyword, trade] of Object.entries(tradeMap)) {
    if (lower.includes(keyword)) return trade;
  }
  return null;
}

function detectDecisionType(classification: string, metadata: any): string {
  if (classification === 'denial') {
    return metadata?.denial_type === 'partial' ? 'deny_partial' : 'deny_full';
  }
  if (classification === 'approval') return 'accept';
  if (classification === 'estimate') return 'pending';
  return 'unknown';
}

function chunkText(text: string, chunkSize = 600, overlap = 100): string[] {
  const chunks: string[] = [];
  // Try to split on markdown headers first
  const sections = text.split(/(?=^#{1,3}\s)/m);
  
  for (const section of sections) {
    if (section.length <= chunkSize) {
      if (section.trim().length > 20) chunks.push(section.trim());
      continue;
    }
    // Sub-chunk long sections
    for (let i = 0; i < section.length; i += chunkSize - overlap) {
      const chunk = section.substring(i, i + chunkSize).trim();
      if (chunk.length > 20) chunks.push(chunk);
    }
  }
  return chunks;
}

async function indexDocumentForRetrieval(
  supabase: any,
  claimId: string,
  fileId: string,
  textContent: string,
  classificationResult: ClassificationResult,
  file: any
) {
  try {
    console.log(`[CrossClaim Index] Starting indexing for file ${fileId} on claim ${claimId}`);
    
    // Get claim metadata for tagging
    const { data: claim } = await supabase
      .from('claims')
      .select('insurance_company, loss_type, loss_date, policyholder_address')
      .eq('id', claimId)
      .single();

    const carrierName = claim?.insurance_company || null;
    const claimLossType = detectLossType(claim?.loss_type || '') || detectLossType(textContent);
    const trade = detectTrade(textContent);
    const evidenceType = EVIDENCE_TYPE_MAP[classificationResult.classification] || 'other';
    const decisionType = detectDecisionType(classificationResult.classification, classificationResult.metadata);
    
    // Extract denial rationale if present
    const denialRationale = classificationResult.metadata?.denial_reason || null;
    const citedReasons = classificationResult.metadata?.key_phrases || [];

    // Determine state from address
    const stateMatch = (claim?.policyholder_address || '').match(/\b([A-Z]{2})\b\s*\d{5}/);
    const stateCode = stateMatch ? stateMatch[1] : null;

    // Chunk the text
    const chunks = chunkText(textContent);
    console.log(`[CrossClaim Index] Created ${chunks.length} chunks for file ${fileId}`);

    if (chunks.length === 0) return;

    // Delete existing chunks for this file (in case of reprocess)
    await supabase.from('claim_document_chunks').delete().eq('file_id', fileId);

    // Insert chunks
    const chunkRows = chunks.map((content, index) => ({
      claim_id: claimId,
      file_id: fileId,
      chunk_index: index,
      content,
      carrier_name: carrierName,
      loss_type: claimLossType,
      trade,
      decision_type: decisionType,
      evidence_type: evidenceType,
      denial_rationale: denialRationale,
      cited_denial_reasons: citedReasons.length > 0 ? citedReasons : null,
      state_code: stateCode,
      loss_date: claim?.loss_date || null,
    }));

    const { data: insertedChunks, error: insertError } = await supabase
      .from('claim_document_chunks')
      .insert(chunkRows)
      .select('id, content');

    if (insertError) {
      console.error('[CrossClaim Index] Insert error:', insertError.message);
      return;
    }

    console.log(`[CrossClaim Index] Inserted ${insertedChunks.length} chunks, generating embeddings...`);

    // Generate embeddings via the generate-embeddings function
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    const texts = insertedChunks.map((c: any) => c.content);
    const chunkIds = insertedChunks.map((c: any) => c.id);

    // Call generate-embeddings with the OpenAI key
    const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
    if (!OPENAI_API_KEY) {
      console.log('[CrossClaim Index] No OPENAI_API_KEY, skipping embeddings');
      return;
    }

    // Generate embeddings in batches of 50
    const BATCH_SIZE = 50;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batchTexts = texts.slice(i, i + BATCH_SIZE);
      const batchIds = chunkIds.slice(i, i + BATCH_SIZE);

      const embResponse = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: batchTexts,
        }),
      });

      if (!embResponse.ok) {
        console.error('[CrossClaim Index] Embedding API error:', embResponse.status);
        continue;
      }

      const embData = await embResponse.json();
      const embeddings = embData.data.map((item: any) => item.embedding);

      for (let j = 0; j < batchIds.length; j++) {
        await supabase
          .from('claim_document_chunks')
          .update({ embedding: embeddings[j] })
          .eq('id', batchIds[j]);
      }
    }

    console.log(`[CrossClaim Index] Successfully indexed ${chunks.length} chunks with embeddings for file ${fileId}`);
  } catch (error) {
    console.error('[CrossClaim Index] Error:', error);
  }
}

// Status mapping: document type -> keywords to find in claim_statuses
const STATUS_KEYWORDS: Record<string, string[]> = {
  'estimate': ['estimate received', 'estimate from carrier', 'waiting on carrier estimate'],
  'denial': ['denial', 'denied', 'carrier denial'],
  'approval': ['approved', 'check received', 'settlement'],
  'rfi': ['waiting on', 'documents sent', 'additional'],
};

// Find the best matching status from the configured statuses
async function findMatchingStatus(supabase: any, documentType: string, fallback: string): Promise<string> {
  try {
    const { data: statuses } = await supabase
      .from('claim_statuses')
      .select('name')
      .eq('is_active', true)
      .order('display_order');

    if (!statuses || statuses.length === 0) return fallback;

    const keywords = STATUS_KEYWORDS[documentType] || [];
    
    // Find a status that contains one of our keywords (case insensitive)
    for (const keyword of keywords) {
      const match = statuses.find((s: any) => 
        s.name.toLowerCase().includes(keyword.toLowerCase())
      );
      if (match) return match.name;
    }

    return fallback;
  } catch (error) {
    console.error('Error finding matching status:', error);
    return fallback;
  }
}

async function processDocumentActions(
  supabase: any,
  claimId: string,
  classification: ClassificationResult,
  automation: any,
  fileId: string
) {
  const isFullyAutonomous = automation.autonomy_level === 'fully_autonomous';
  // Semi-autonomous should also auto-update status (only emails to insurance need review)
  const isAutonomous = ['semi_autonomous', 'fully_autonomous'].includes(automation.autonomy_level);

  // Get claim details for email drafting
  let claim: any = null;
  if (isAutonomous) {
    const { data: claimData } = await supabase
      .from('claims')
      .select('id, claim_number, policyholder_name, policyholder_email, policyholder_phone, client_id')
      .eq('id', claimId)
      .single();
    claim = claimData;
  }

  switch (classification.classification) {
    case 'denial':
      // Always create escalation for denials (never auto-respond)
      await supabase.from('darwin_action_log').insert({
        claim_id: claimId,
        action_type: 'escalation',
        action_details: {
          reason: 'denial_detected',
          file_id: fileId,
          denial_reason: classification.metadata.denial_reason,
          denial_type: classification.metadata.denial_type,
        },
        was_auto_executed: true,
        result: `DENIAL DETECTED: ${classification.metadata.denial_reason || 'Reason not extracted'}. Requires immediate attention.`,
        trigger_source: 'darwin_document_actions',
      });

      // Create urgent task
      await supabase.from('tasks').insert({
        claim_id: claimId,
        title: 'Review Denial Letter',
        description: `A denial letter was detected. Reason: ${classification.metadata.denial_reason || 'See document'}. ${classification.metadata.deadline_mentioned ? `Deadline: ${classification.metadata.deadline_mentioned}` : ''}`,
        priority: 'high',
        due_date: classification.metadata.deadline_mentioned || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        status: 'pending',
      });

      // Update claim status if autonomous (semi or fully)
      if (isAutonomous) {
        const denialStatus = await findMatchingStatus(supabase, 'denial', 'Carrier Denial');
        await supabase.from('claims').update({ status: denialStatus }).eq('id', claimId);
        
        // Draft client notification email for denials (requires review due to sensitivity)
        if (claim?.policyholder_email) {
          try {
            await draftClientUpdateEmail(supabase, claimId, claim, denialStatus, classification.metadata.summary, false);
            console.log(`Successfully drafted denial email for claim ${claimId}`);
          } catch (emailError: any) {
            console.error(`Failed to draft denial client email:`, emailError);
            await supabase.from('darwin_action_log').insert({
              claim_id: claimId,
              action_type: 'error',
              action_details: { error: emailError.message, context: 'draftClientUpdateEmail_denial' },
              was_auto_executed: true,
              result: `Failed to draft client email: ${emailError.message}`,
              trigger_source: 'darwin_process_document',
            });
          }
        }
      }
      break;

    case 'estimate':
      // Create task to review estimate
      await supabase.from('tasks').insert({
        claim_id: claimId,
        title: 'Review Estimate',
        description: `New ${classification.metadata.estimate_type || ''} estimate detected. ${classification.metadata.gross_rcv ? `RCV: $${classification.metadata.gross_rcv.toLocaleString()}` : ''}`,
        priority: 'medium',
        due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        status: 'pending',
      });

      // Extract to accounting if we have amounts
      if (classification.metadata.gross_rcv && classification.metadata.gross_rcv > 0) {
        // Check for existing settlement record
        const { data: existingSettlement } = await supabase
          .from('claim_settlements')
          .select('id')
          .eq('claim_id', claimId)
          .limit(1);

        if (!existingSettlement || existingSettlement.length === 0) {
          await supabase.from('claim_settlements').insert({
            claim_id: claimId,
            estimate_amount: classification.metadata.gross_rcv,
            notes: `Auto-extracted from ${classification.metadata.estimate_type || 'estimate'} by Darwin`,
          });
        } else {
          await supabase.from('claim_settlements').update({
            estimate_amount: classification.metadata.gross_rcv,
            notes: `Updated from ${classification.metadata.estimate_type || 'estimate'} by Darwin`,
          }).eq('id', existingSettlement[0].id);
        }
      }

      // Update status if autonomous (semi or fully)
      if (isAutonomous) {
        const estimateStatus = await findMatchingStatus(supabase, 'estimate', 'Estimate Received from Carrier');
        await supabase.from('claims').update({ status: estimateStatus }).eq('id', claimId);
        
        // Draft client notification email
        if (claim?.policyholder_email) {
          try {
            const estimateAmount = classification.metadata.gross_rcv 
              ? ` The estimate amount is $${classification.metadata.gross_rcv.toLocaleString()}.` 
              : '';
            await draftClientUpdateEmail(
              supabase, 
              claimId, 
              claim, 
              estimateStatus, 
              `We have received an estimate for your claim.${estimateAmount}`,
              true // Can auto-send for estimates
            );
            console.log(`Successfully drafted estimate email for claim ${claimId}`);
          } catch (emailError: any) {
            console.error(`Failed to draft estimate client email:`, emailError);
            await supabase.from('darwin_action_log').insert({
              claim_id: claimId,
              action_type: 'error',
              action_details: { error: emailError.message, context: 'draftClientUpdateEmail_estimate' },
              was_auto_executed: true,
              result: `Failed to draft client email: ${emailError.message}`,
              trigger_source: 'darwin_process_document',
            });
          }
        }
      }
      break;

    case 'approval':
      // Create task for payment processing
      await supabase.from('tasks').insert({
        claim_id: claimId,
        title: 'Process Payment',
        description: `${classification.metadata.payment_type || 'Payment'} approval received. ${classification.metadata.approved_amount ? `Amount: $${classification.metadata.approved_amount.toLocaleString()}` : ''}`,
        priority: 'high',
        due_date: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        status: 'pending',
      });

      // Update claim status if autonomous (semi or fully)
      if (isAutonomous) {
        const approvalStatus = await findMatchingStatus(supabase, 'approval', 'Check Received - No Mortgage');
        await supabase.from('claims').update({ status: approvalStatus }).eq('id', claimId);
        
        // Draft client notification email for approval (good news, can auto-send)
        if (claim?.policyholder_email) {
          try {
            const approvalAmount = classification.metadata.approved_amount 
              ? ` The approved amount is $${classification.metadata.approved_amount.toLocaleString()}.` 
              : '';
            await draftClientUpdateEmail(
              supabase, 
              claimId, 
              claim, 
              approvalStatus, 
              `Great news! Your claim has been approved.${approvalAmount}`,
              true // Can auto-send for approvals
            );
            console.log(`Successfully drafted approval email for claim ${claimId}`);
          } catch (emailError: any) {
            console.error(`Failed to draft approval client email:`, emailError);
            await supabase.from('darwin_action_log').insert({
              claim_id: claimId,
              action_type: 'error',
              action_details: { error: emailError.message, context: 'draftClientUpdateEmail_approval' },
              was_auto_executed: true,
              result: `Failed to draft client email: ${emailError.message}`,
              trigger_source: 'darwin_process_document',
            });
          }
        }
      }
      break;

    case 'rfi':
      // Create urgent task with deadline
      await supabase.from('tasks').insert({
        claim_id: claimId,
        title: 'Respond to RFI',
        description: `Request for Information received. ${classification.metadata.deadline_mentioned ? `Deadline: ${classification.metadata.deadline_mentioned}` : 'Respond promptly.'}`,
        priority: 'high',
        due_date: classification.metadata.deadline_mentioned || new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        status: 'pending',
      });

      // Log as requiring action
      await supabase.from('darwin_action_log').insert({
        claim_id: claimId,
        action_type: 'escalation',
        action_details: {
          reason: 'rfi_received',
          file_id: fileId,
          deadline: classification.metadata.deadline_mentioned,
        },
        was_auto_executed: true,
        result: `RFI received. ${classification.metadata.deadline_mentioned ? `Deadline: ${classification.metadata.deadline_mentioned}` : 'Respond promptly.'}`,
        trigger_source: 'darwin_document_actions',
      });
      
      // Draft client notification email for RFI (may need info from them)
      if (isAutonomous && claim?.policyholder_email) {
        try {
          const deadlineInfo = classification.metadata.deadline_mentioned 
            ? ` The insurance company has requested a response by ${classification.metadata.deadline_mentioned}.` 
            : '';
          await draftClientUpdateEmail(
            supabase, 
            claimId, 
            claim, 
            'Information Requested', 
            `The insurance company has requested additional information for your claim.${deadlineInfo} We may need to gather some details from you.`,
            true // Can auto-send RFI notifications
          );
          console.log(`Successfully drafted RFI email for claim ${claimId}`);
        } catch (emailError: any) {
          console.error(`Failed to draft RFI client email:`, emailError);
          await supabase.from('darwin_action_log').insert({
            claim_id: claimId,
            action_type: 'error',
            action_details: { error: emailError.message, context: 'draftClientUpdateEmail_rfi' },
            was_auto_executed: true,
            result: `Failed to draft client email: ${emailError.message}`,
            trigger_source: 'darwin_process_document',
          });
        }
      }
      break;

    case 'engineering_report':
      // Create task to review engineering report
      await supabase.from('tasks').insert({
        claim_id: claimId,
        title: 'Review Engineering Report',
        description: `Engineering report uploaded. ${classification.metadata.summary}`,
        priority: 'medium',
        due_date: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        status: 'pending',
      });
      break;
  }
}

// Draft a client update email and queue it for sending
async function draftClientUpdateEmail(
  supabase: any,
  claimId: string,
  claim: any,
  newStatus: string,
  updateMessage: string,
  canAutoSend: boolean = false
) {
  const policyholderName = claim.policyholder_name || 'Valued Policyholder';
  const firstName = policyholderName.split(' ')[0];
  
  const emailSubject = `Claim Update: ${claim.claim_number} - ${newStatus}`;
  const emailBody = `Dear ${firstName},

We wanted to keep you informed about the status of your claim (${claim.claim_number}).

${updateMessage}

Your claim status has been updated to: ${newStatus}

If you have any questions or need additional information, please don't hesitate to reach out to us. You can also view your claim details in the client portal.

Best regards,
Freedom Claims Team`;

  // Insert pending action for the autonomous agent to process
  await supabase.from('claim_ai_pending_actions').insert({
    claim_id: claimId,
    action_type: 'email_response',
    draft_content: {
      to_email: claim.policyholder_email,
      to_name: policyholderName,
      subject: emailSubject,
      body: emailBody,
      recipient_type: 'client', // This allows auto-send in semi-autonomous mode
    },
    ai_reasoning: `Automated client notification for status change to "${newStatus}". ${canAutoSend ? 'Can be auto-sent to client.' : 'Requires review before sending.'}`,
    status: 'pending',
  });

  // Log the draft creation
  await supabase.from('darwin_action_log').insert({
    claim_id: claimId,
    action_type: 'email_drafted',
    action_details: {
      recipient: claim.policyholder_email,
      recipient_type: 'client',
      new_status: newStatus,
      can_auto_send: canAutoSend,
    },
    was_auto_executed: true,
    result: `Drafted client update email for status change to "${newStatus}" - ${canAutoSend ? 'queued for auto-send' : 'requires review'}`,
    trigger_source: 'darwin_status_notification',
  });

  console.log(`Drafted client update email for claim ${claim.claim_number} - status: ${newStatus}`);
}

// === EVIDENCE SNIPPET EXTRACTOR ===
// Extracts a relevant text snippet from document content based on doc type
function extractEvidenceSnippet(text: string, docType: string): string | null {
  if (!text || text.length < 20) return null;
  
  const snippetPatterns: Record<string, RegExp[]> = {
    'denial': [
      /(?:deny|denied|denial|decline|declined)[^.]{0,200}\./gi,
      /(?:not covered|excluded|exclusion|does not apply)[^.]{0,150}\./gi,
    ],
    'approval': [
      /(?:approved|approval|payment|enclosed|settlement)[^.]{0,200}\./gi,
    ],
    'estimate': [
      /(?:total|grand total|rcv|acv|replacement cost)[^.]{0,150}\./gi,
    ],
    'rfi': [
      /(?:request|require|provide|submit|needed)[^.]{0,200}\./gi,
    ],
    'engineering_report': [
      /(?:opinion|conclusion|finding|determined|assessment)[^.]{0,200}\./gi,
    ],
  };

  const patterns = snippetPatterns[docType] || [];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return match[0].substring(0, 250).trim();
    }
  }

  // Fallback: first meaningful 200 chars
  const firstContent = text.replace(/\s+/g, ' ').trim().substring(0, 200);
  return firstContent.length > 20 ? firstContent : null;
}

// =========================================================================
// DOCUMENT-DRIVEN TIMELINE: Extract dates from classification → claim_events
// =========================================================================
async function extractDatesToClaimEvents(
  supabase: any,
  claimId: string,
  fileId: string,
  fileName: string,
  classificationResult: ClassificationResult,
  textContent?: string | null,
): Promise<number> {
  const metadata = classificationResult.metadata as any;
  const docType = classificationResult.classification;

  // Collect all date entries to insert
  const events: Array<{
    claim_id: string;
    event_type: string;
    occurred_at: string;
    summary: string;
    source_artifact_id: string | null;
    source_artifact_type: string;
    date_source: string;
    date_confidence: number;
    date_evidence: string | null;
    doc_type: string;
    metadata_json: Record<string, unknown>;
  }> = [];

  // === ANCHOR EVENT_TYPE MAPPING ===
  // Map document classification to specific anchor event_types
  const DOC_TYPE_TO_ANCHOR_EVENT: Record<string, string> = {
    'denial': 'denial_issued',
    'approval': 'payment',
    'estimate': 'estimate_issued',
    'engineering_report': 'engineer_report_issued',
    'rfi': 'ror_issued',
    'policy': 'policy_issued',
    'invoice': 'invoice_issued',
    'correspondence': 'correspondence_issued',
  };

  // 1) Document issuance date → use anchor event_type
  const documentDate = metadata.document_date || metadata.date_mentioned;
  const anchorEventType = DOC_TYPE_TO_ANCHOR_EVENT[docType] || `${docType}_issued`;
  if (documentDate) {
    const validation = validateExtractedDate(documentDate);
    if (validation.isValid && validation.correctedDate) {
      // Extract evidence snippet from text content
      const evidenceSnippet = extractEvidenceSnippet(textContent || '', docType);
      events.push({
        claim_id: claimId,
        event_type: anchorEventType,
        occurred_at: new Date(validation.correctedDate).toISOString(),
        summary: `${docType.replace(/_/g, ' ')} issued: ${fileName}`,
        source_artifact_id: fileId || null,
        source_artifact_type: 'claim_file',
        date_source: 'document_extracted',
        date_confidence: metadata.date_confidence ?? classificationResult.confidence,
        date_evidence: evidenceSnippet || `Document date extracted from ${fileName}`,
        doc_type: docType,
        metadata_json: { file_name: fileName, extraction_method: 'ai_classification', evidence_snippet: evidenceSnippet },
      });
    }
  }

  // 2) All dates_found entries (loss_date, deadline, claim_date, etc.)
  const datesFound = metadata.dates_found;
  if (Array.isArray(datesFound)) {
    for (const df of datesFound) {
      if (!df?.date || df.type === 'letter_date') continue; // letter_date already handled above
      const validation = validateExtractedDate(df.date);
      if (!validation.isValid || !validation.correctedDate) continue;

      const eventTypeMap: Record<string, string> = {
        loss_date: 'loss_event',
        claim_date: 'fnol_received',
        policy_date: 'policy_period',
        deadline: 'deadline',
        inspection_date: 'inspection',
        payment_date: 'payment',
        acknowledgment_date: 'acknowledgement_issued',
      };
      const eventType = eventTypeMap[df.type] || df.type || 'date_mentioned';

      events.push({
        claim_id: claimId,
        event_type: eventType,
        occurred_at: new Date(validation.correctedDate).toISOString(),
        summary: df.context || `${df.type}: ${df.date}`,
        source_artifact_id: fileId || null,
        source_artifact_type: 'claim_file',
        date_source: 'document_extracted',
        date_confidence: metadata.date_confidence ?? 0.8,
        date_evidence: df.context || null,
        doc_type: docType,
        metadata_json: { file_name: fileName, date_type: df.type, extraction_method: 'ai_classification' },
      });
    }
  }

  // 3) Deadline date
  if (metadata.deadline_mentioned) {
    const validation = validateExtractedDate(metadata.deadline_mentioned);
    if (validation.isValid && validation.correctedDate) {
      events.push({
        claim_id: claimId,
        event_type: 'deadline',
        occurred_at: new Date(validation.correctedDate).toISOString(),
        summary: `Deadline mentioned in ${fileName}`,
        source_artifact_id: fileId || null,
        source_artifact_type: 'claim_file',
        date_source: 'document_extracted',
        date_confidence: metadata.date_confidence ?? 0.7,
        date_evidence: `Deadline extracted from ${fileName}`,
        doc_type: docType,
        metadata_json: { file_name: fileName, extraction_method: 'ai_classification' },
      });
    }
  }

  // 4) FALLBACK: If no structured dates from classifier, regex-extract from document text
  const hasDocDate = !!(metadata.document_date || metadata.date_mentioned);
  const hasDatesFound = Array.isArray(metadata.dates_found) && metadata.dates_found.length > 0;
  if (events.length === 0 || (!hasDocDate && !hasDatesFound)) {
    console.log(`[DateExtract] No structured dates from classifier for ${fileName} (hasDocDate=${hasDocDate}, hasDatesFound=${hasDatesFound}), attempting text regex fallback...`);

    // Prefer passed-in textContent, then fall back to DB
    let extractedText: string | null = null;
    if (textContent && textContent.length > 50 && !textContent.startsWith('[PDF Document')) {
      extractedText = textContent;
    } else if (fileId) {
      const { data: fileRecord } = await supabase
        .from('claim_files')
        .select('extracted_text')
        .eq('id', fileId)
        .single();
      extractedText = fileRecord?.extracted_text || null;
    }

    if (extractedText && extractedText.length > 10) {
      console.log(`[DateExtract][Regex] extracted_text length=${extractedText.length}`);
      const regexDates = extractDatesFromTextRegex(extractedText, claimId, fileId, fileName, docType);
      events.push(...regexDates);
    } else {
      console.log(`[DateExtract] No extracted_text available for ${fileName} (fileId: ${fileId}), skipping regex fallback`);
    }
  }

  // 5) If STILL no dates extracted at all, create a system_upload event
  if (events.length === 0) {
    events.push({
      claim_id: claimId,
      event_type: 'file_uploaded',
      occurred_at: new Date().toISOString(),
      summary: `File uploaded: ${fileName}`,
      source_artifact_id: fileId || null,
      source_artifact_type: 'claim_file',
      date_source: 'system_upload',
      date_confidence: 1.0,
      date_evidence: null,
      doc_type: docType,
      metadata_json: { file_name: fileName, extraction_method: 'upload_timestamp' },
    });
  }

  // Deduplicate: don't insert if same claim + event_type + occurred_at + source_artifact_id exists
  let insertedCount = 0;
  for (const evt of events) {
    const { data: existing } = await supabase
      .from('claim_events')
      .select('id')
      .eq('claim_id', evt.claim_id)
      .eq('event_type', evt.event_type)
      .eq('occurred_at', evt.occurred_at)
      .eq('source_artifact_id', evt.source_artifact_id)
      .limit(1);

    if (!existing || existing.length === 0) {
      const { error } = await supabase.from('claim_events').insert(evt);
      if (error) {
        console.error(`[DateExtract] Failed to insert claim_event: ${error.message}`, JSON.stringify(evt));
      } else {
        insertedCount++;
        console.log(`[DateExtract] claim_event inserted: ${evt.event_type} @ ${evt.occurred_at} from ${fileName}`);
      }
    } else {
      console.log(`[DateExtract] Skipped duplicate: ${evt.event_type} @ ${evt.occurred_at} from ${fileName}`);
    }
  }

  console.log(`[DateExtract] Summary for ${fileName}: ${events.length} candidates, ${insertedCount} inserted`);
  return insertedCount;
}

// === STRICT DATE PARSER (no timezone drift) ===
const MONTH_MAP: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

export function parseDateStrict(raw: string): string | null {
  // Strip surrounding punctuation
  const cleaned = raw.replace(/^[.,;:\s]+|[.,;:\s]+$/g, '').trim();
  if (!cleaned) return null;

  let yyyy: string, mm: string, dd: string;

  // MM/DD/YYYY or M/D/YY
  const slashMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slashMatch) {
    mm = slashMatch[1].padStart(2, '0');
    dd = slashMatch[2].padStart(2, '0');
    let yr = slashMatch[3];
    if (yr.length === 2) yr = `20${yr}`;
    yyyy = yr;
    return validateAndReturn(yyyy, mm, dd);
  }

  // YYYY-MM-DD
  const isoMatch = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    yyyy = isoMatch[1]; mm = isoMatch[2]; dd = isoMatch[3];
    return validateAndReturn(yyyy, mm, dd);
  }

  // Month DD, YYYY or Mon. DD, YYYY
  const wordMatch = cleaned.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (wordMatch) {
    const monthKey = wordMatch[1].toLowerCase().replace('.', '');
    mm = MONTH_MAP[monthKey];
    if (!mm) return null;
    dd = wordMatch[2].padStart(2, '0');
    yyyy = wordMatch[3];
    return validateAndReturn(yyyy, mm, dd);
  }

  return null;
}

function validateAndReturn(yyyy: string, mm: string, dd: string): string | null {
  const y = parseInt(yyyy), m = parseInt(mm), d = parseInt(dd);
  if (y < 2000 || y > new Date().getFullYear() + 1) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${yyyy}-${mm}-${dd}T12:00:00.000Z`;
}

// === DATE CAPTURE PATTERN (reused by all labeled regexes) ===
const DATE_CAPTURE = `((?:\\d{1,2}\\/\\d{1,2}\\/\\d{2,4})|(?:\\d{4}-\\d{2}-\\d{2})|(?:[A-Za-z]{3,9}\\.?\\s+\\d{1,2},?\\s+\\d{4}))`;

// === REGEX FALLBACK DATE EXTRACTOR ===
type ClaimEventRow = {
  claim_id: string;
  event_type: string;
  occurred_at: string;
  summary: string;
  source_artifact_id: string | null;
  source_artifact_type: string;
  date_source: string;
  date_confidence: number;
  date_evidence: string | null;
  doc_type: string;
  metadata_json: Record<string, unknown>;
};

function extractDatesFromTextRegex(
  text: string,
  claimId: string,
  fileId: string | null,
  fileName: string,
  docType: string,
): ClaimEventRow[] {
  const events: ClaimEventRow[] = [];

  const labelPatterns: Array<{ regex: RegExp; eventType: string; confidence: number }> = [
    { regex: new RegExp(`(?:date\\s+of\\s+loss|DOL|loss\\s+date)\\s*[:\\-]\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'loss_event', confidence: 0.9 },
    { regex: new RegExp(`(?:inspection\\s+date)\\s*[:\\-]\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'inspection', confidence: 0.85 },
    { regex: new RegExp(`(?:estimate\\s+date)\\s*[:\\-]\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'estimate_issued', confidence: 0.85 },
    { regex: new RegExp(`(?:payment\\s+date)\\s*[:\\-]\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'payment', confidence: 0.85 },
    { regex: new RegExp(`(?:issued|dated)\\s*[:\\-]\\s*${DATE_CAPTURE}`, 'gi'), eventType: `${docType}_issued`, confidence: 0.75 },
  ];

  const standalonePatterns = [
    /(\d{1,2}\/\d{1,2}\/\d{2,4})/g,
    /(\d{4}-\d{2}-\d{2})/g,
    /((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/gi,
    /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},?\s+\d{4})/gi,
  ];

  const seen = new Set<string>();

  function getSnippet(matchIndex: number): string {
    const start = Math.max(0, matchIndex - 40);
    const end = Math.min(text.length, matchIndex + 60);
    return text.substring(start, end).replace(/\n/g, ' ').trim();
  }

  // Pass 1: labeled dates
  let labeledFound = 0;
  for (const lp of labelPatterns) {
    let match: RegExpExecArray | null;
    const regex = new RegExp(lp.regex.source, lp.regex.flags);
    while ((match = regex.exec(text)) !== null) {
      const rawDate = match[1];
      const occurredAt = parseDateStrict(rawDate);
      if (!occurredAt) continue;
      const key = `${lp.eventType}|${occurredAt}|${fileId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labeledFound++;

      events.push({
        claim_id: claimId,
        event_type: lp.eventType,
        occurred_at: occurredAt,
        summary: `${lp.eventType.replace(/_/g, ' ')}: ${rawDate} (regex from ${fileName})`,
        source_artifact_id: fileId || null,
        source_artifact_type: 'claim_file',
        date_source: 'document_text_regex',
        date_confidence: lp.confidence,
        date_evidence: getSnippet(match.index),
        doc_type: docType,
        metadata_json: { file_name: fileName, extraction_method: 'text_regex_labeled', label: lp.eventType },
      });
    }
  }

  // Pass 2: unlabeled standalone dates (only if < 3 labeled found)
  let unlabeledFound = 0;
  if (labeledFound < 3) {
    for (const dp of standalonePatterns) {
      let match: RegExpExecArray | null;
      const regex = new RegExp(dp.source, dp.flags);
      while ((match = regex.exec(text)) !== null) {
        const rawDate = match[1];
        const occurredAt = parseDateStrict(rawDate);
        if (!occurredAt) continue;
        const key = `date_mentioned|${occurredAt}|${fileId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unlabeledFound++;

        events.push({
          claim_id: claimId,
          event_type: 'date_mentioned',
          occurred_at: occurredAt,
          summary: `Date found in ${fileName}: ${rawDate}`,
          source_artifact_id: fileId || null,
          source_artifact_type: 'claim_file',
          date_source: 'document_text_regex',
          date_confidence: 0.6,
          date_evidence: getSnippet(match.index),
          doc_type: docType,
          metadata_json: { file_name: fileName, extraction_method: 'text_regex_unlabeled' },
        });

        // Cap total at 15
        if (events.length >= 15) break;
      }
      if (events.length >= 15) break;
    }
  }

  // Required logging
  console.log(`[DateExtract][Regex] labeledFound=${labeledFound} unlabeledFound=${unlabeledFound} totalAdded=${events.length}`);
  for (const sample of events.slice(0, 3)) {
    console.log(`[DateExtract][Regex] Sample: event_type=${sample.event_type} occurred_at=${sample.occurred_at} evidence="${(sample.date_evidence || '').substring(0, 80)}"`);
  }

  return events;
}
