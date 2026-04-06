import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';
import { isGarbageText } from '../_shared/document-intelligence-types.ts';
import { runSmartClassification, type DocumentClassification as SmartDocClassification } from './classification-v2.ts';
import { analyzePacketText } from './packet-intelligence.ts';
import { classifyVirtualSegments } from './segment-intelligence.ts';

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

interface DocumentIntelligenceQueuePayload {
  claim_id: string;
  file_id: string;
  document_type: string;
  document_classification: string;
  confidence_score: number;
  summary?: string;
}

interface ClaimMasterStateDocIntelSummary {
  total_documents?: number;
  analyzed_documents?: number;
  pending_documents?: number;
  high_priority_action_docs?: number;
  last_document_type?: string | null;
  last_processed_file_id?: string | null;
  last_processed_at?: string | null;
}

async function enqueueDocumentIntelligenceJob(
  supabase: ReturnType<typeof createClient>,
  payload: DocumentIntelligenceQueuePayload
) {
  const queueRow = {
    claim_id: payload.claim_id,
    file_id: payload.file_id,
    status: 'pending',
    priority: payload.confidence_score >= 0.85 ? 100 : 50,
    run_after: new Date().toISOString(),
    payload: payload,
  };

  const { error } = await supabase
    .from('document_intelligence_queue')
    .upsert(queueRow, { onConflict: 'file_id' });

  if (error) {
    console.error('[DocIntelQueue] enqueue error:', error.message);
    throw error;
  }

  console.log('[DocIntelQueue] queued', {
    claim_id: payload.claim_id,
    file_id: payload.file_id,
    document_type: payload.document_type,
  });
}

async function updateClaimMasterStateDocIntelSummary(
  supabase: ReturnType<typeof createClient>,
  claimId: string,
  patch: ClaimMasterStateDocIntelSummary
) {
  const { data: existing } = await supabase
    .from('claim_master_state')
    .select('state_json')
    .eq('claim_id', claimId)
    .maybeSingle();

  const currentState = (existing?.state_json ?? {}) as Record<string, unknown>;
  const currentDocIntel = (currentState.document_intelligence ?? {}) as Record<string, unknown>;

  const nextState = {
    ...currentState,
    document_intelligence: {
      ...currentDocIntel,
      ...patch,
    },
    updated_at_iso: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('claim_master_state')
    .upsert({
      claim_id: claimId,
      state_json: nextState,
      updated_at: new Date().toISOString(),
    });

  if (error) {
    console.error('[ClaimMasterState] document_intelligence update error:', error.message);
  }
}

function mapDocumentType(classification: string): string {
  const docTypeMap: Record<string, string> = {
    denial: 'denial_letter',
    estimate: 'carrier_estimate',
    approval: 'coverage_letter',
    rfi: 'carrier_correspondence',
    engineering_report: 'engineering_report',
    policy: 'policy_document',
    correspondence: 'carrier_correspondence',
    invoice: 'invoice',
    photo: 'photos_report',
    other: 'other',
  };
  return docTypeMap[classification] || classification;
}

async function verifyClassification(
  textContent: string,
  fileName: string,
  initialClassification: string
): Promise<{ classification: DocumentClassification; confidence: number; reasons: string[] } | null> {
  try {
    const apiKey = Deno.env.get('OPENAI_API_KEY');
    if (!apiKey) return null;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Return only JSON:
{
  "classification": "estimate|denial|approval|rfi|engineering_report|policy|correspondence|invoice|photo|other",
  "confidence": number,
  "reasons": ["string"]
}
Use the document text and filename. Do not invent facts.`,
          },
          {
            role: 'user',
            content: `File name: ${fileName}\nInitial classification: ${initialClassification}\nDocument text:\n${textContent.slice(0, 12000)}`,
          },
        ],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    return {
      classification: parsed.classification || 'other',
      confidence: Number(parsed.confidence || 0.5),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
    };
  } catch (err) {
    console.error('[ClassificationVerify] error:', err);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const {
      fileId,
      claimId,
      fileName,
      fileContent,
      force,
      forceIntelligence,
    } = await req.json();

    const shouldForceReextract = force === true;
    const shouldBypassProcessedGuard = shouldForceReextract || forceIntelligence === true;

    console.log("Darwin Document Processing starting...", {
      fileId,
      claimId,
      fileName,
      shouldForceReextract,
      forceIntelligence: forceIntelligence === true,
    });

    let file: any = null;
    let textContent = '';
    let targetClaimId = claimId;
    let extractionMethod = 'none';
    let isScanned = false;
    let pageCount: number | null = null;

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

      // Skip only when we're not explicitly forcing re-extraction or intelligence backfill.
      if (file.processed_by_darwin && !shouldBypassProcessedGuard) {
        return new Response(
          JSON.stringify({ 
            success: true, 
            message: 'File already processed',
            classification: file.document_classification,
            document_type: file.document_type || null,
            document_subtype: file.document_subtype || null,
            ready_for_analysis: file.ready_for_analysis ?? false,
            ready_reason: file.ready_for_analysis ? 'ready' : 'previously_blocked',
            text_quality_status: file.text_quality_status || null,
            intelligence: {
              attempted: false,
              written: false,
              skipped_reason: 'already_processed',
              error: null,
            },
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      if (shouldForceReextract && file.processed_by_darwin) {
        console.log(`[Darwin] Force reprocessing file ${fileId}, clearing previous classification`);
      }

      // GUARANTEE extracted_text is populated before any analysis
      // Only re-extract from source when we're doing a true force reprocess or the saved text is garbage.
      const existingTextIsGarbage = file.extracted_text && file.extracted_text.length > 50 && isGarbageText(file.extracted_text);
      const existingTextUsable = file.extracted_text && file.extracted_text.length > 50 && !existingTextIsGarbage;
      
      if (!shouldForceReextract && existingTextUsable) {
        textContent = file.extracted_text;
        extractionMethod = 'existing_text';
        console.log(`[TextExtract] Using existing extracted_text (${textContent.length} chars) for ${file.file_name}`);
      } else {
        if (shouldForceReextract) console.log(`[TextExtract] Force reprocess — re-extracting text from source for ${file.file_name}`);
        if (existingTextIsGarbage) console.log(`[TextExtract] Existing text is garbage (${file.extracted_text.length} chars) — re-extracting from source for ${file.file_name}`);
        // Download file and extract text
        const { data: fileBlob, error: downloadError } = await supabase.storage
          .from('claim-files')
          .download(file.file_path);

        if (!downloadError && fileBlob) {
          const fileType = file.file_type || '';
          if (fileType.includes('text') || file.file_name.endsWith('.txt')) {
            textContent = await fileBlob.text();
            extractionMethod = 'native_text';
          } else if (fileType.includes('pdf')) {
            // Attempt PDF text extraction via raw bytes
            const pdfBytes = new Uint8Array(await fileBlob.arrayBuffer());
            textContent = extractPdfText(pdfBytes);
            extractionMethod = 'pdf_native';
            console.log(`[TextExtract] PDF raw text extraction: ${textContent.length} chars for ${file.file_name}`);

            // Check if extracted text is garbage (binary/image data from embedded photos)
            const pdfQuality = assessTextQuality(textContent);
            const needsOcr = textContent.length < 300 || pdfQuality.status === 'unusable' || pdfQuality.status === 'poor';

            if (needsOcr) {
              console.log(`[TextExtract] PDF text needs OCR (length=${textContent.length}, quality=${pdfQuality.status}, reasons=${pdfQuality.reasons.join('; ')}), attempting OCR via vision for ${file.file_name}`);
              const ocrText = await ocrViaVision(pdfBytes, file.file_name);
              if (ocrText && ocrText.length > 100) {
                // Only replace if OCR produced meaningful text
                const ocrQuality = assessTextQuality(ocrText);
                if (ocrQuality.score > pdfQuality.score) {
                  textContent = ocrText;
                  extractionMethod = 'ocr_vision';
                  isScanned = true;
                  console.log(`[TextExtract] OCR replaced garbage native text (ocr=${ocrText.length} chars, quality=${ocrQuality.status}) for ${file.file_name}`);
                } else {
                  console.log(`[TextExtract] OCR quality (${ocrQuality.status}) not better than native (${pdfQuality.status}), keeping native for ${file.file_name}`);
                }
              } else {
                console.log(`[TextExtract] OCR returned insufficient text for ${file.file_name}`);
              }
            }
          } else if (fileType.includes('word') || /\.(docx?)$/i.test(file.file_name)) {
            // Word document extraction
            const docBytes = new Uint8Array(await fileBlob.arrayBuffer());
            const rawText = new TextDecoder("utf-8", { fatal: false }).decode(docBytes);
            const xmlTextMatches = rawText.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
            if (xmlTextMatches) {
              textContent = xmlTextMatches.map((m: string) => m.replace(/<[^>]+>/g, "")).join(" ");
            } else {
              textContent = rawText.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{3,}/g, " ").trim();
            }
            extractionMethod = 'docx_xml';
            console.log(`[TextExtract] DOCX extraction: ${textContent.length} chars for ${file.file_name}`);
          } else if (/\.(png|jpg|jpeg|webp|gif|bmp|tiff?)$/i.test(file.file_name)) {
            // Image files: OCR via vision
            console.log(`[TextExtract] Image file, attempting OCR via vision for ${file.file_name}`);
            const imgBytes = new Uint8Array(await fileBlob.arrayBuffer());
            const ocrText = await ocrViaVision(imgBytes, file.file_name);
            if (ocrText) {
              textContent = ocrText;
              extractionMethod = 'ocr_vision';
              isScanned = true;
              console.log(`[TextExtract] OCR yielded ${textContent.length} chars for ${file.file_name}`);
            }
          }
        }

        // Persist extracted_text to claim_files so it's always available
        if (textContent && textContent.length > 50 && !textContent.startsWith('[PDF Document')) {
          // Run garbage detection before persisting
          if (isGarbageText(textContent)) {
            console.warn(`[TextExtract] isGarbageText=true for ${file.file_name}, marking unusable`);
            await supabase
              .from('claim_files')
              .update({
                extracted_text: textContent.substring(0, 100000),
                extraction_method: extractionMethod,
                text_quality_status: 'unusable',
                is_scanned: isScanned,
                ready_for_analysis: false,
                needs_reprocessing: true,
                processing_error: 'Extracted text detected as garbage/binary data',
                processed_at: new Date().toISOString(),
                processed_by_darwin: true,
                darwin_processed_at: new Date().toISOString(),
              })
              .eq('id', fileId);

            console.log(`[DocProcessed] file_id=${fileId} file_name=${file.file_name} extraction_method=${extractionMethod} text_quality=unusable is_scanned=${isScanned} ready_for_analysis=false document_type=unknown document_subtype=none reason=garbage_text`);

            return new Response(
              JSON.stringify({
                success: false,
                classification: 'other',
                confidence: 0,
                method: 'garbage_text_detected',
                processing_error: 'Extracted text detected as garbage/binary data',
                ready_for_analysis: false,
                ready_reason: 'text_quality_unusable',
                text_quality_status: 'unusable',
                intelligence: {
                  attempted: false,
                  written: false,
                  skipped_reason: 'not_ready_for_analysis:text_quality_unusable',
                  error: null,
                },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }

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

    // Map classification to expanded document_type
    const docTypeMap: Record<string, string> = {
      'denial': 'denial_letter',
      'estimate': 'carrier_estimate',
      'approval': 'coverage_letter',
      'rfi': 'carrier_correspondence',
      'engineering_report': 'engineering_report',
      'policy': 'policy_document',
      'correspondence': 'carrier_correspondence',
      'invoice': 'invoice',
      'photo': 'photos_report',
      'other': 'other',
    };

    // If no text content, try to classify by filename patterns
    if (!textContent || textContent.length < 50) {
      const classificationFromName = classifyByFilename(fileName || file?.file_name || '');
      
      // Update file record with basic classification
      if (file) {
        const filenameDocType = docTypeMap?.[classificationFromName] || classificationFromName;
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
            document_type: filenameDocType,
            extraction_method: extractionMethod,
            text_quality_status: 'unusable',
            is_scanned: isScanned,
            ready_for_analysis: false,
            needs_reprocessing: true,
            processing_error: 'No readable text extracted from file',
            processed_at: new Date().toISOString(),
          })
          .eq('id', fileId);
      }

      console.log(`[DocProcessed] file_id=${fileId} file_name=${fileName || file?.file_name} extraction_method=${extractionMethod} text_quality=unusable is_scanned=${isScanned} ready_for_analysis=false document_type=${file ? (docTypeMap?.[classificationFromName] || classificationFromName) : 'unknown'} document_subtype=none reason=no_readable_text`);

      return new Response(
        JSON.stringify({ 
          success: false, 
          classification: classificationFromName,
          confidence: 0.4,
          method: 'filename_pattern',
          processing_error: 'No readable text extracted from file',
          ready_for_analysis: false,
          ready_reason: 'clean_text_too_short',
          text_quality_status: 'unusable',
          intelligence: {
            attempted: false,
            written: false,
            skipped_reason: 'not_ready_for_analysis:no_readable_text',
            error: null,
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Call AI for classification
    const baseClassificationResult = await classifyDocument(textContent, fileName || file?.file_name || '');

    const verifyResult = await verifyClassification(
      textContent,
      fileName || file?.file_name || '',
      baseClassificationResult.classification
    );

    const smartClassification = await runSmartClassification({
      fileName: fileName || file?.file_name || '',
      text: textContent,
      aiPrimary: baseClassificationResult,
      aiVerify: verifyResult,
    });

    // Assess text quality
    const textQuality = assessTextQuality(textContent);
    const cleanText = cleanExtractedText(textContent);
    const readyDecision = getReadyForAnalysisDecision({
      cleanText,
      textQualityStatus: textQuality.status,
      processingError: null,
    });
    const readyForAnalysis = readyDecision.ready;
    const readyReason = readyDecision.reason;

    // Intelligence outcome tracking
    let intelligenceAttempted = false;
    let intelligenceWritten = false;
    let intelligenceSkippedReason: string | null = null;
    let intelligenceError: string | null = null;
    let documentSubtype: string | null = null;

    const packetAnalysis =
      cleanText.length >= 1200
        ? analyzePacketText(cleanText)
        : null;

    const packetDominantWins =
      packetAnalysis &&
      packetAnalysis.dominant_classification !== smartClassification.primary &&
      packetAnalysis.dominant_confidence >= 0.7 &&
      packetAnalysis.page_count >= 2;

    const finalClassification = packetDominantWins
      ? packetAnalysis!.dominant_classification
      : smartClassification.primary;

    const finalConfidence = packetDominantWins
      ? Math.max(smartClassification.confidence, packetAnalysis!.dominant_confidence)
      : smartClassification.confidence;

    const finalMixed =
      smartClassification.is_mixed_document ||
      Boolean(packetAnalysis?.mixed_document);

    const finalReviewRequired =
      smartClassification.review_required ||
      Boolean(packetAnalysis?.review_required);

    const finalAutomationSafe =
      smartClassification.automation_safe &&
      !finalMixed &&
      !finalReviewRequired;

    const segmentationResult =
      packetAnalysis &&
      packetAnalysis.mixed_document &&
      cleanText.length >= 2000
        ? classifyVirtualSegments({
            cleanText,
            smartClassification,
          })
        : {
            has_segments: false,
            segment_count: 0,
            summary: {},
            segments: [],
          };

    const classificationResult = {
      ...baseClassificationResult,
      classification: finalClassification as DocumentClassification,
      confidence: finalConfidence,
      metadata: {
        ...baseClassificationResult.metadata,
        smart_candidates: smartClassification.candidates,
        smart_method: smartClassification.method,
        smart_reasoning: smartClassification.reasoning,
        review_required: finalReviewRequired,
        is_mixed_document: finalMixed,
        document_family: smartClassification.document_family,
        automation_safe: finalAutomationSafe,
        packet_analysis: packetAnalysis,
        packet_dominant_wins: packetDominantWins,
      },
    };

    const mappedDocType = docTypeMap[classificationResult.classification] || classificationResult.classification;

    // Update file record with classification + intelligence metadata
    if (file) {
      const updatePayload: Record<string, unknown> = {
        document_classification: classificationResult.classification,
        classification_confidence: classificationResult.confidence,
        classification_metadata: classificationResult.metadata,
        processed_by_darwin: true,
        darwin_processed_at: new Date().toISOString(),
        // New document intelligence fields
        document_type: mappedDocType,
        extraction_method: extractionMethod,
        text_quality_status: textQuality.status,
        confidence_score: classificationResult.confidence,
        is_scanned: isScanned,
        page_count: pageCount,
        ready_for_analysis: readyForAnalysis,
        needs_reprocessing: textQuality.status === 'poor' || textQuality.status === 'unusable',
        processed_at: new Date().toISOString(),
        classification_candidates: smartClassification.candidates,
        classification_method: smartClassification.method,
        classification_reasoning: smartClassification.reasoning,
        classification_review_required: finalReviewRequired,
        is_mixed_document: finalMixed,
        document_family: smartClassification.document_family,
        automation_safe: finalAutomationSafe,
        packet_analysis: packetAnalysis || {},
        packet_page_count: packetAnalysis?.page_count || null,
        packet_dominant_classification: packetAnalysis?.dominant_classification || null,
        packet_mixed_confidence: packetAnalysis?.mixed_confidence || null,
        packet_review_required: packetAnalysis?.review_required || false,
        processing_error: null,
        has_virtual_segments: segmentationResult.has_segments,
        segment_count: segmentationResult.segment_count,
        segmentation_status: segmentationResult.has_segments ? 'segmented' : 'not_segmented',
        segmentation_summary: segmentationResult.summary,
      };
      // Store extracted and clean text
      if (textContent && textContent.length > 50 && !textContent.startsWith('[PDF Document')) {
        updatePayload.extracted_text = textContent.substring(0, 100000);
        updatePayload.clean_text = cleanText.substring(0, 100000);
      }
      // Generate summary from classification metadata
      if (classificationResult.metadata?.summary) {
        updatePayload.document_summary = classificationResult.metadata.summary;
      }
      await supabase
        .from('claim_files')
        .update(updatePayload)
        .eq('id', fileId);

      // === VIRTUAL SEGMENT STORAGE ===
      if (fileId) {
        if (segmentationResult.has_segments) {
          await supabase
            .from('claim_file_segments')
            .delete()
            .eq('file_id', fileId);

          const segmentRows = segmentationResult.segments.map((segment) => ({
            claim_id: targetClaimId,
            file_id: fileId,
            segment_index: segment.segment_index,
            segment_label: segment.segment_label,
            start_page: segment.start_page,
            end_page: segment.end_page,
            text_excerpt: segment.text_excerpt,
            extracted_text: segment.extracted_text.substring(0, 100000),
            clean_text: segment.clean_text.substring(0, 100000),
            segment_classification: segment.segment_classification,
            classification_confidence: segment.classification_confidence,
            classification_candidates: segment.classification_candidates,
            classification_reasoning: segment.classification_reasoning,
            review_required: segment.review_required,
            automation_safe: segment.automation_safe,
            document_family: segment.document_family,
            source_method: 'virtual_segmentation',
          }));

          const { error: segmentError } = await supabase
            .from('claim_file_segments')
            .insert(segmentRows);

          if (segmentError) {
            console.error('[Segmentation] Failed to store segments:', segmentError.message);
          } else {
            console.log(`[Segmentation] Stored ${segmentRows.length} virtual segments for file ${fileId}`);
          }
        } else {
          await supabase
            .from('claim_file_segments')
            .delete()
            .eq('file_id', fileId);
        }
      }

      // Log review-required classifications
      if (targetClaimId && (finalReviewRequired || finalMixed)) {
        await supabase
          .from('darwin_action_log')
          .insert({
            claim_id: targetClaimId,
            action_type: 'document_classification_review_required',
            action_details: {
              file_id: fileId,
              file_name: fileName || file?.file_name,
              primary_classification: smartClassification.primary,
              candidates: smartClassification.candidates,
              reasoning: smartClassification.reasoning,
              is_mixed_document: finalMixed,
              packet_analysis: packetAnalysis,
              packet_dominant_wins: packetDominantWins,
            },
            was_auto_executed: true,
            result: `Classification review required for ${fileName || file?.file_name}`,
            trigger_source: 'darwin_process_document',
          });
      }
    }

    // === STEP 3.5: INLINE STRUCTURED INTELLIGENCE EXTRACTION ===
    // When force=true (backfill/reprocessing), attempt intelligence even if readyForAnalysis is false,
    // as long as there's enough clean text to work with.
    const shouldAttemptIntelligence = readyForAnalysis || (force && cleanText.length >= 100);
    if (!shouldAttemptIntelligence) {
      intelligenceSkippedReason = `not_ready_for_analysis:${readyReason}`;
      console.log(`[DocIntel] skipped file_id=${fileId} reason=${intelligenceSkippedReason}`);
    } else if (targetClaimId && fileId && cleanText.length >= 100) {
      intelligenceAttempted = true;
      try {
        const intelResult = await extractStructuredIntelligence(
          supabase, targetClaimId, fileId, cleanText,
          mappedDocType, classificationResult
        );
        intelligenceWritten = intelResult.written;
        if (intelResult.written && intelResult.success) {
          documentSubtype = (intelResult as any).documentSubtype || null;
          console.log(`[DocIntel] written file_id=${fileId} document_type=${mappedDocType} subtype=${documentSubtype || 'none'}`);
          // Clear processing error and needs_reprocessing on success
          await supabase.from('claim_files').update({
            processing_error: null,
            needs_reprocessing: false,
          }).eq('id', fileId);
        } else if (!intelResult.success) {
          intelligenceError = (intelResult as any).error || 'unknown_error';
          console.error(`[DocIntel] failed file_id=${fileId} error=${intelligenceError}`);
          // Mark for retry
          await supabase.from('claim_files').update({
            processing_error: `intelligence_extraction_failed: ${intelligenceError}`,
            needs_reprocessing: true,
          }).eq('id', fileId);
        } else {
          // success but not written (skipped)
          intelligenceSkippedReason = (intelResult as any).skippedReason || 'unknown_skip';
          console.log(`[DocIntel] skipped file_id=${fileId} reason=${intelligenceSkippedReason}`);
        }
      } catch (intelErr: any) {
        intelligenceError = intelErr?.message || String(intelErr);
        console.error('[DocIntel] Inline extraction failed:', intelligenceError);
        await supabase.from('claim_files').update({
          processing_error: `intelligence_extraction_exception: ${intelligenceError}`,
          needs_reprocessing: true,
        }).eq('id', fileId);
      }
    } else {
      intelligenceSkippedReason = 'missing_claim_or_file_or_text';
    }

    // === STRUCTURED PROCESSING LOG ===
    console.log(`[DocProcessed] file_id=${fileId} file_name=${fileName || file?.file_name} extraction_method=${extractionMethod} text_quality=${textQuality.status} ready_for_analysis=${readyForAnalysis} ready_reason=${readyReason} document_type=${mappedDocType} document_subtype=${documentSubtype || classificationResult.metadata?.document_subtype || 'none'} confidence=${classificationResult.confidence} intelligence_attempted=${intelligenceAttempted} intelligence_written=${intelligenceWritten} intelligence_skipped_reason=${intelligenceSkippedReason || 'none'} intelligence_error=${intelligenceError || 'none'}`);

    // === STEP 4: DURABLE DOCUMENT INTELLIGENCE QUEUE ===
    if (readyForAnalysis && targetClaimId && fileId && cleanText.length >= 100) {
      try {
        if (segmentationResult.has_segments) {
          const { data: savedSegments, error: savedSegmentsError } = await supabase
            .from('claim_file_segments')
            .select('id, segment_index, segment_label, segment_classification, classification_confidence')
            .eq('file_id', fileId)
            .order('segment_index', { ascending: true });

          if (savedSegmentsError) {
            throw savedSegmentsError;
          }

          for (const segment of savedSegments || []) {
            const queueRow = {
              claim_id: targetClaimId,
              file_id: fileId,
              segment_id: segment.id,
              source_scope: 'segment',
              status: 'pending',
              priority: Number(segment.classification_confidence || 0) >= 0.85 ? 100 : 50,
              run_after: new Date().toISOString(),
              payload: {
                claim_id: targetClaimId,
                file_id: fileId,
                segment_id: segment.id,
                source_scope: 'segment',
                document_type: mapDocumentType(segment.segment_classification || 'other'),
                document_classification: segment.segment_classification || 'other',
                confidence_score: Number(segment.classification_confidence || 0.5),
                summary: segment.segment_label,
              },
            };

            const { error: queueError } = await supabase
              .from('document_intelligence_queue')
              .upsert(queueRow, { onConflict: 'segment_id' });

            if (queueError) {
              console.error('[DocIntelQueue] segment enqueue error:', queueError.message);
            }
          }
        } else {
          await enqueueDocumentIntelligenceJob(supabase, {
            claim_id: targetClaimId,
            file_id: fileId,
            document_type: mappedDocType,
            document_classification: classificationResult.classification,
            confidence_score: classificationResult.confidence,
            summary: classificationResult.metadata?.summary,
          });
        }

        await updateClaimMasterStateDocIntelSummary(supabase, targetClaimId, {
          last_document_type: mappedDocType,
          last_processed_file_id: fileId,
          last_processed_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error('[DocIntelQueue] Failed to queue structured extraction:', err);
      }
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
        // Wipe stale events for THIS file before re-extracting
        await supabase.from('claim_events').delete()
          .eq('claim_id', targetClaimId)
          .eq('source_artifact_id', fileId);
        console.log(`[DateExtract] Wiped old claim_events for file ${fileId}`);

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
    if (classificationResult.confidence >= 0.8 && finalAutomationSafe) {
      // Fire and forget - don't wait for deep analysis to complete
      triggerDeepAnalysis(
        supabase,
        targetClaimId,
        classificationResult.classification,
        fileId,
        file?.file_path
      ).catch(err => console.error('Deep analysis trigger error:', err));
    }

    // === CARRIER ARGUMENT DETECTION: Enqueue for batched worker (carrier-side docs only) ===
    if (textContent && textContent.length >= 200 && targetClaimId &&
        classificationResult.confidence >= 0.6 &&
        ['denial', 'correspondence'].includes(classificationResult.classification)) {
      console.log(`[CarrierArgDetect] Enqueuing carrier argument detection for ${file?.file_name || fileId}`);
      supabase.from('carrier_argument_queue').insert({
        claim_id: targetClaimId,
        file_id: fileId || null,
        file_name: file?.file_name || fileName || '',
        extracted_text: textContent.substring(0, 30000),
        status: 'pending',
      }).then(({ error: qErr }) => {
        if (qErr) console.error('[CarrierArgDetect] Queue insert error:', qErr.message);
        else console.log('[CarrierArgDetect] Enqueued successfully');
      });
    }

    // Auto-trigger inventory age resolution when invoices/receipts are processed
    const fileNameLower = (file?.file_name || fileName || '').toLowerCase();

    const isFinancialProofDoc =
      classificationResult.confidence >= 0.6 &&
      (
        classificationResult.classification === 'invoice' ||
        /receipt|invoice|order|purchase|confirmation|warranty/.test(fileNameLower)
      );

    if (isFinancialProofDoc) {
      // Check if claim has inventory items
      const { count: inventoryCount } = await supabase
        .from('claim_home_inventory')
        .select('id', { count: 'exact', head: true })
        .eq('claim_id', targetClaimId);

      if (inventoryCount && inventoryCount > 0) {
        console.log(`[AgeResolve] Invoice/receipt detected, triggering age resolution for ${inventoryCount} inventory items`);
        // Fire and forget
        fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/resolve-item-age`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ claim_id: targetClaimId }),
        }).catch(err => console.error('Age resolve trigger error:', err));
      }
    }

    // Process automation actions if enabled
    if (automation && classificationResult.confidence >= 0.8 && finalAutomationSafe) {
      await processDocumentActions(
        supabase, 
        targetClaimId, 
        classificationResult, 
        automation,
        fileId,
        documentSubtype
      );
    }

    if (targetClaimId) {
      const { count: analyzedCount } = await supabase
        .from('claim_document_intelligence')
        .select('id', { count: 'exact', head: true })
        .eq('claim_id', targetClaimId);

      const { count: pendingCount } = await supabase
        .from('document_intelligence_queue')
        .select('id', { count: 'exact', head: true })
        .eq('claim_id', targetClaimId)
        .in('status', ['pending', 'processing']);

      await updateClaimMasterStateDocIntelSummary(supabase, targetClaimId, {
        analyzed_documents: analyzedCount ?? 0,
        pending_documents: pendingCount ?? 0,
      });
    }

    // === Document Meaning queue summary in claim_master_state ===
    if (targetClaimId) {
      const { count: meaningPendingCount } = await supabase
        .from('document_meaning_queue')
        .select('id', { count: 'exact', head: true })
        .eq('claim_id', targetClaimId)
        .in('status', ['pending', 'processing']);

      const { count: meaningCount } = await supabase
        .from('claim_document_meaning')
        .select('id', { count: 'exact', head: true })
        .eq('claim_id', targetClaimId);

      const { data: existingMeaning } = await supabase
        .from('claim_master_state')
        .select('state_json')
        .eq('claim_id', targetClaimId)
        .maybeSingle();

      const currentStateMeaning = (existingMeaning?.state_json ?? {}) as Record<string, unknown>;
      const currentMeaning = (currentStateMeaning.document_meaning ?? {}) as Record<string, unknown>;

      await supabase
        .from('claim_master_state')
        .upsert({
          claim_id: targetClaimId,
          state_json: {
            ...currentStateMeaning,
            document_meaning: {
              ...currentMeaning,
              analyzed_documents: meaningCount ?? 0,
              pending_documents: meaningPendingCount ?? 0,
              last_document_seen_at: new Date().toISOString(),
            },
            updated_at_iso: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        });
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        classification: classificationResult.classification,
        confidence: classificationResult.confidence,
        metadata: classificationResult.metadata,
        document_type: mappedDocType,
        document_subtype: documentSubtype || classificationResult.metadata?.document_subtype || null,
        ready_for_analysis: readyForAnalysis,
        ready_reason: readyReason,
        text_quality_status: textQuality.status,
        intelligence: {
          attempted: intelligenceAttempted,
          written: intelligenceWritten,
          skipped_reason: intelligenceSkippedReason,
          error: intelligenceError,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("Darwin Document Processing error:", error);

    // Best-effort: write processing_error to claim_files so the failure is visible
    try {
      const body = await req.clone().json().catch(() => ({}));
      const failedFileId = body?.fileId;
      if (failedFileId) {
        const supabase = createClient(
          Deno.env.get('SUPABASE_URL') ?? '',
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        );
        await supabase.from('claim_files').update({
          processing_error: errorMsg,
          needs_reprocessing: true,
          ready_for_analysis: false,
          processed_at: new Date().toISOString(),
        }).eq('id', failedFileId);
        console.log(`[DocProcessed] file_id=${failedFileId} FAILED error="${errorMsg}"`);
      }
    } catch { /* best effort */ }

    return new Response(
      JSON.stringify({ error: errorMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// === TEXT QUALITY ASSESSMENT ===
function assessTextQuality(text: string): { status: 'good' | 'fair' | 'poor' | 'unusable'; score: number; reasons: string[] } {
  if (!text || text.length < 20) return { status: 'unusable', score: 0, reasons: ['No text extracted'] };

  // Multi-sample garbage detection from shared utility
  if (isGarbageText(text)) {
    return { status: 'unusable', score: 0, reasons: ['Multi-sample garbage detection triggered (binary/garbled data)'] };
  }

  const reasons: string[] = [];
  let score = 100;

  // Check for garbage/binary content
  const sample = text.substring(0, 2000);
  const nonAscii = (sample.match(/[^\x20-\x7E\n\r\t]/g) || []).length;
  const nonAsciiRatio = nonAscii / sample.length;
  if (nonAsciiRatio > 0.3) { score -= 60; reasons.push('High non-ASCII ratio (binary/garbled)'); }
  else if (nonAsciiRatio > 0.15) { score -= 30; reasons.push('Moderate non-ASCII content'); }

  // Check for common English words as readability proxy
  const lower = text.toLowerCase();
  const commonWords = ['the', 'and', 'was', 'for', 'that', 'with', 'this', 'from', 'have', 'been', 'claim', 'loss', 'damage', 'policy', 'insurance'];
  const wordHits = commonWords.filter(w => lower.includes(` ${w} `)).length;
  if (text.length > 500 && wordHits < 3) { score -= 25; reasons.push('Low common-word density'); }

  // Length assessment
  if (text.length < 100) { score -= 20; reasons.push('Very short text'); }
  else if (text.length < 300) { score -= 10; reasons.push('Short text'); }

  const status = score >= 70 ? 'good' : score >= 40 ? 'fair' : score >= 20 ? 'poor' : 'unusable';
  return { status, score, reasons };
}

// === CLEAN TEXT (normalize whitespace, strip control chars) ===
function cleanExtractedText(text: string): string {
  if (!text) return '';
  return text
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // strip control chars except \n\r\t
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')        // collapse horizontal whitespace
    .replace(/\n{3,}/g, '\n\n')     // max 2 newlines
    .trim();
}

// === INTELLIGENCE OUTCOME TYPES ===
type StructuredIntelResult =
  | { success: true; written: true; documentSubtype?: string | null; summary?: string | null }
  | { success: true; written: false; skippedReason: string }
  | { success: false; written: false; error: string };

function getReadyForAnalysisDecision(params: {
  cleanText: string;
  textQualityStatus: string | null;
  processingError: string | null;
}): { ready: boolean; reason: string } {
  if (params.processingError) {
    return { ready: false, reason: "processing_error_present" };
  }
  const len = (params.cleanText || "").trim().length;
  if (len < 100) {
    return { ready: false, reason: "clean_text_too_short" };
  }
  if (params.textQualityStatus === "unusable") {
    return { ready: false, reason: "text_quality_unusable" };
  }
  // "poor" quality files often still have enough text for meaningful intelligence.
  // Only block on "unusable"; let the intelligence extractor judge content quality.
  return { ready: true, reason: params.textQualityStatus === "poor" ? "ready_poor_quality" : "ready" };
}

function hasMeaningfulIntelligencePayload(intel: any): boolean {
  if (!intel || typeof intel !== "object") return false;
  const checks = [
    typeof intel.summary === "string" && intel.summary.trim().length >= 20,
    Array.isArray(intel.denial_reasons) && intel.denial_reasons.length > 0,
    Array.isArray(intel.testing_missing) && intel.testing_missing.length > 0,
    Array.isArray(intel.testing_performed) && intel.testing_performed.length > 0,
    Array.isArray(intel.exclusions_cited) && intel.exclusions_cited.length > 0,
    Array.isArray(intel.scope_positions) && intel.scope_positions.length > 0,
    Array.isArray(intel.building_components) && intel.building_components.length > 0,
    !!intel.coverage_position,
    !!intel.cause_of_loss,
    !!intel.sender,
    !!intel.recipient,
    !!intel.estimate_totals,
  ];
  return checks.some(Boolean);
}

// === STRUCTURED INTELLIGENCE EXTRACTION ===
async function extractStructuredIntelligence(
  supabase: any,
  claimId: string,
  fileId: string,
  cleanText: string,
  documentType: string,
  classificationResult: ClassificationResult,
): Promise<StructuredIntelResult> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) {
    return { success: true, written: false, skippedReason: 'no_lovable_api_key' };
  }

  console.log(`[DocIntel] Starting structured extraction for ${fileId} (type: ${documentType})`);

  const docTypeContext: Record<string, string> = {
    'denial_letter': 'Focus on denial reasons, exclusions cited, coverage positions, and any contradictions with policy language.',
    'engineering_report': 'Focus on cause of loss determination, testing performed vs not performed, building components discussed, manufacturer references, and code citations.',
    'carrier_estimate': 'Focus on estimate totals (RCV/ACV), line item categories, scope positions, and any exclusions or limitations noted.',
    'coverage_letter': 'Focus on coverage positions, approved amounts, conditions, and any limitations.',
    'carrier_correspondence': 'Focus on carrier positions, requests, deadlines, and any admissions or concessions.',
    'policy_document': 'Focus on coverage types, limits, deductibles, exclusions, endorsements, and conditions.',
    'invoice': 'Focus on vendor, amounts, dates, and line items.',
    'photos_report': 'Focus on damage descriptions, locations, and severity assessments.',
  };

  const typeHint = docTypeContext[documentType] || 'Extract all relevant claim facts.';

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
          {
            role: 'system',
            content: `You are a document intelligence extractor for insurance claims. Extract structured facts from the document. ${typeHint} Be precise — only extract what is explicitly stated. Do not guess.`
          },
          {
            role: 'user',
            content: `Document type: ${documentType}\n\nDocument content:\n${cleanText.substring(0, 20000)}`
          }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'extract_document_intelligence',
            description: 'Extract structured intelligence from a claim document',
            parameters: {
              type: 'object',
              properties: {
                document_subtype: {
                  type: 'string',
                  description: 'Specific subtype: full_denial, partial_denial, reservation_of_rights, carrier_estimate, pa_estimate, contractor_estimate, supplement_estimate, engineering_report, expert_report, policy_jacket, endorsement, declarations, proof_of_loss, invoice, receipt, inspection_report, mitigation_report, or other'
                },
                summary: {
                  type: 'string',
                  description: 'One-paragraph summary of the document (max 500 chars)'
                },
                sender: { type: 'string', description: 'Who sent/authored this document' },
                recipient: { type: 'string', description: 'Who received this document' },
                cause_of_loss: { type: 'string', description: 'Stated cause of loss/damage' },
                coverage_position: {
                  type: 'string',
                  description: 'The coverage position stated (approved, denied, partial, under review, etc.)'
                },
                key_dates: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      date: { type: 'string', description: 'YYYY-MM-DD' },
                      label: { type: 'string', description: 'What this date represents' }
                    },
                    required: ['date', 'label']
                  },
                  description: 'All significant dates found'
                },
                key_entities: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      role: { type: 'string', description: 'adjuster, engineer, contractor, carrier, insured, attorney, etc.' }
                    },
                    required: ['name', 'role']
                  }
                },
                denial_reasons: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Specific reasons given for denial or limitation'
                },
                exclusions_cited: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Policy exclusions referenced'
                },
                testing_performed: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Tests/inspections that were performed'
                },
                testing_missing: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Standard tests that should have been performed but were not mentioned'
                },
                estimate_totals: {
                  type: 'object',
                  properties: {
                    rcv: { type: 'number', description: 'Replacement Cost Value total' },
                    acv: { type: 'number', description: 'Actual Cash Value total' },
                    depreciation: { type: 'number' },
                    deductible: { type: 'number' }
                  }
                },
                scope_positions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Specific scope items or trade categories discussed'
                },
                building_components: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Building components mentioned (roof, siding, HVAC, plumbing, etc.)'
                },
                code_references: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Building codes, standards, or regulations referenced'
                },
                manufacturer_references: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Manufacturer names, product names, or warranty references'
                },
                citations: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Legal citations, case law, or regulatory references'
                },
                contradictions: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Internal contradictions or inconsistencies found in the document'
                },
              },
              required: ['summary'],
              additionalProperties: false,
            }
          }
        }],
        tool_choice: { type: 'function', function: { name: 'extract_document_intelligence' } },
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      if (response.status === 402) {
        const errMsg = 'AI credits exhausted. Please add credits at Settings > Workspace > Usage.';
        console.error(`[DocIntel] 402 Payment Required: ${errBody}`);
        return { success: false, written: false, error: errMsg };
      }
      if (response.status === 429) {
        const errMsg = 'AI rate limit reached. File will be retried automatically.';
        console.error(`[DocIntel] 429 Rate Limited: ${errBody}`);
        return { success: false, written: false, error: errMsg };
      }
      const errMsg = `AI error: ${response.status}`;
      console.error(`[DocIntel] ${errMsg} ${errBody}`);
      return { success: false, written: false, error: errMsg };
    }

    const aiResult = await response.json();
    const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall?.function?.arguments) {
      console.error('[DocIntel] No tool call in response');
      return { success: true, written: false, skippedReason: 'no_tool_call_in_response' };
    }

    let intel: any;
    try {
      intel = JSON.parse(toolCall.function.arguments);
    } catch {
      console.error('[DocIntel] Failed to parse tool call arguments');
      return { success: false, written: false, error: 'failed_to_parse_tool_call_arguments' };
    }

    // Reject empty/junk payloads
    if (!hasMeaningfulIntelligencePayload(intel)) {
      console.warn(`[DocIntel] Empty/junk intelligence payload for ${fileId}, skipping upsert`);
      return { success: true, written: false, skippedReason: 'empty_intelligence_payload' };
    }

    // Upsert into claim_document_intelligence
    const { error: upsertError } = await supabase
      .from('claim_document_intelligence')
      .upsert({
        claim_file_id: fileId,
        claim_id: claimId,
        document_type: documentType,
        document_subtype: intel.document_subtype || null,
        summary: intel.summary || null,
        key_dates: intel.key_dates || [],
        key_entities: intel.key_entities || [],
        coverage_position: intel.coverage_position || null,
        denial_reasons: intel.denial_reasons || [],
        exclusions_cited: intel.exclusions_cited || [],
        testing_performed: intel.testing_performed || [],
        testing_missing: intel.testing_missing || [],
        estimate_totals: intel.estimate_totals || null,
        scope_positions: intel.scope_positions || [],
        citations: intel.citations || [],
        building_components: intel.building_components || [],
        code_references: intel.code_references || [],
        manufacturer_references: intel.manufacturer_references || [],
        contradictions: intel.contradictions || [],
        sender: intel.sender || null,
        recipient: intel.recipient || null,
        cause_of_loss: intel.cause_of_loss || null,
        extracted_facts: intel,
        confidence_score: classificationResult.confidence,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'claim_file_id' });

    if (upsertError) {
      console.error('[DocIntel] Upsert error:', upsertError.message);
      return { success: false, written: false, error: `upsert_failed: ${upsertError.message}` };
    }

    console.log(`[DocIntel] written intelligence for ${fileId} (type: ${documentType}, subtype: ${intel.document_subtype || 'none'})`);

    // Also update claim_files with subtype and summary
    await supabase.from('claim_files').update({
      document_subtype: intel.document_subtype || null,
      document_summary: intel.summary || null,
    }).eq('id', fileId);

    return { success: true, written: true, documentSubtype: intel.document_subtype || null, summary: intel.summary || null };

  } catch (err: any) {
    const errMsg = err?.message || String(err);
    console.error('[DocIntel] Extraction failed:', errMsg);
    return { success: false, written: false, error: errMsg };
  }
}

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
    "labeled_dates": {
      "letter_date": {"date": "YYYY-MM-DD or null", "snippet": "exact sentence/phrase containing this date"},
      "fnol_date": {"date": "YYYY-MM-DD or null", "snippet": "exact text with labels like 'Date Reported', 'Reported to us', 'Notice of loss received', 'Date of Claim'"},
      "ack_date": {"date": "YYYY-MM-DD or null", "snippet": "acknowledgement letter date text"},
      "ror_date": {"date": "YYYY-MM-DD or null", "snippet": "reservation of rights date text"},
      "denial_date": {"date": "YYYY-MM-DD or null", "snippet": "denial/decline date text"},
      "inspection_date": {"date": "YYYY-MM-DD or null", "snippet": "inspection/site visit date text"},
      "payment_issue_date": {"date": "YYYY-MM-DD or null", "snippet": "check/EFT/payment issued date text"},
      "received_date": {"date": "YYYY-MM-DD or null", "snippet": "date received text if explicitly stated"},
      "loss_date": {"date": "YYYY-MM-DD or null", "snippet": "ONLY when explicitly labeled 'Date of Loss', 'DOL', 'Loss Date', or 'Loss occurred on' within 50 characters of the date. NEVER extract a date as loss_date if it appears in a prior/previous claim narrative or history section."},
      "estimate_date": {"date": "YYYY-MM-DD or null", "snippet": "estimate/scope prepared date text"},
      "prior_loss_dates": [{"date": "YYYY-MM-DD", "snippet": "text mentioning prior/previous/past loss or prior claim"}]
    },
    "claim_numbers_found": ["list of all claim/policy numbers found in the document"],
    "multi_claim_doc": false,
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

LABELED DATE EXTRACTION RULES:
- letter_date: The printed date on the letter/document header
- fnol_date: Look for labels like "Date Reported", "Reported to us on", "Notice of Loss received", "Date of Claim", "Claim reported"
- ack_date: Date on acknowledgement letters
- ror_date: Date on reservation of rights letters
- denial_date: Date denial was issued
- inspection_date: "Inspection Date", "Site visit on", "Inspected on"
- payment_issue_date: "Check date", "Payment date", "EFT date", "Draft date"
- received_date: "Received on", "Date received"
- loss_date: ONLY extract when an explicit label ("Date of Loss", "DOL", "Loss Date", "Loss occurred on") appears within 50 characters of the date value. Do NOT guess. Do NOT extract dates from narrative history as loss dates.
- estimate_date: "Estimate date", "Prepared on", "Scope date"
- prior_loss_dates: If the document mentions prior/previous/past/history losses or prior claims, extract those dates here (array). If text near a date says "prior loss", "previous claim", "history of claims", "past claim", etc., put it in prior_loss_dates, NOT loss_date.
- For each, include the exact text snippet (up to ~100 chars) surrounding the date as evidence
- Set null for any date type not found in the document

CLAIM NUMBER EXTRACTION RULES:
- Extract ALL claim numbers and policy numbers found in the document into "claim_numbers_found" array
- If more than one DISTINCT claim number appears, set "multi_claim_doc": true
- In multi-claim documents, dates from other claims' narratives should NOT be treated as events for the current claim

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

    console.log(`[CrossClaim Index] Inserted ${insertedChunks.length} chunks for file ${fileId}`);

    // Defer embedding generation to avoid CPU timeout in the main processing function.
    // Fire-and-forget call to generate-embeddings edge function which handles this async.
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (SUPABASE_URL && SERVICE_ROLE_KEY) {
      const chunkIds = insertedChunks.map((c: any) => c.id);
      fetch(`${SUPABASE_URL}/functions/v1/generate-embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ chunk_ids: chunkIds, source: 'cross-claim-index' }),
      }).catch(err => console.error('[CrossClaim Index] Deferred embedding call failed:', err));
      console.log(`[CrossClaim Index] Deferred embedding generation for ${chunkIds.length} chunks`);
    } else {
      console.log('[CrossClaim Index] Missing SUPABASE_URL or SERVICE_ROLE_KEY, skipping embeddings');
    }
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
  fileId: string,
  documentSubtype?: string | null
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

  // === LABELED DATES → ANCHOR CLAIM_EVENTS ===
  const LABELED_DATE_TO_EVENT: Record<string, string> = {
    letter_date: DOC_TYPE_TO_ANCHOR_EVENT[docType] || `${docType}_issued`,
    fnol_date: 'fnol_received',
    ack_date: 'acknowledgement_issued',
    ror_date: 'ror_issued',
    denial_date: 'denial_issued',
    inspection_date: 'inspection',
    payment_issue_date: 'payment_issued',
    received_date: 'document_received',
    loss_date: 'loss_event',
    estimate_date: 'estimate_issued',
  };

  // 1) Process labeled_dates from AI classification (primary source)
  const labeledDates = metadata.labeled_dates;
  const isMultiClaimDoc = !!metadata.multi_claim_doc;
  const claimNumbersFound: string[] = Array.isArray(metadata.claim_numbers_found) ? metadata.claim_numbers_found : [];

  if (isMultiClaimDoc) {
    console.log(`[DateExtract] Multi-claim doc detected for ${fileName}, claim_numbers: ${claimNumbersFound.join(', ')}`);
  }

  if (labeledDates && typeof labeledDates === 'object') {
    for (const [labelKey, entry] of Object.entries(labeledDates)) {
      if (labelKey === 'prior_loss_dates') continue; // handled separately below
      const dateEntry = entry as { date?: string; snippet?: string } | null;
      if (!dateEntry?.date) continue;
      const validation = validateExtractedDate(dateEntry.date);
      if (!validation.isValid || !validation.correctedDate) continue;

      let eventType = LABELED_DATE_TO_EVENT[labelKey] || labelKey;
      const snippet = dateEntry.snippet || null;

      // === STRICT loss_event PROXIMITY CHECK ===
      // Only allow loss_event if snippet contains an explicit label within ~50 chars
      if (eventType === 'loss_event' && snippet) {
        const lossLabelPattern = /\b(date\s+of\s+loss|DOL|loss\s+date|loss\s+occurred\s+on)\b/i;
        const priorPattern = /\b(prior|previous|history|past|prior\s+claim|previous\s+claim)\b/i;
        if (priorPattern.test(snippet)) {
          eventType = 'prior_loss_mentioned';
          console.log(`[DateExtract] Reclassified loss_date → prior_loss_mentioned due to prior/history context: "${snippet}"`);
        } else if (!lossLabelPattern.test(snippet)) {
          eventType = 'date_mentioned';
          console.log(`[DateExtract] Reclassified loss_date → date_mentioned (no explicit label within snippet): "${snippet}"`);
        }
      } else if (eventType === 'loss_event' && !snippet) {
        eventType = 'date_mentioned';
        console.log(`[DateExtract] Reclassified loss_date → date_mentioned (no snippet provided)`);
      }

      // Skip non-anchor events from multi-claim docs (unless they match current claim)
      if (isMultiClaimDoc && eventType !== 'loss_event' && eventType !== 'prior_loss_mentioned' && eventType !== 'date_mentioned') {
        // Allow if we can't verify claim numbers, but log warning
        console.log(`[DateExtract] Multi-claim doc event ${eventType} from ${fileName} — may belong to different claim`);
      }

      events.push({
        claim_id: claimId,
        event_type: eventType,
        occurred_at: new Date(validation.correctedDate).toISOString(),
        summary: `${eventType.replace(/_/g, ' ')}: ${fileName}`,
        source_artifact_id: fileId || null,
        source_artifact_type: 'claim_file',
        date_source: 'document_extracted',
        date_confidence: metadata.date_confidence ?? classificationResult.confidence,
        date_evidence: snippet || `${labelKey} extracted from ${fileName}`,
        doc_type: docType,
        metadata_json: {
          file_name: fileName,
          extraction_method: 'ai_labeled_date',
          label: labelKey,
          evidence_snippet: snippet,
          multi_claim_doc: isMultiClaimDoc || undefined,
          claim_numbers_found: claimNumbersFound.length > 0 ? claimNumbersFound : undefined,
        },
      });
    }

    // 1b) Process prior_loss_dates array
    const priorLossDates = labeledDates.prior_loss_dates;
    if (Array.isArray(priorLossDates)) {
      for (const pl of priorLossDates) {
        const plEntry = pl as { date?: string; snippet?: string } | null;
        if (!plEntry?.date) continue;
        const validation = validateExtractedDate(plEntry.date);
        if (!validation.isValid || !validation.correctedDate) continue;

        events.push({
          claim_id: claimId,
          event_type: 'prior_loss_mentioned',
          occurred_at: new Date(validation.correctedDate).toISOString(),
          summary: `Prior loss mentioned: ${fileName}`,
          source_artifact_id: fileId || null,
          source_artifact_type: 'claim_file',
          date_source: 'document_extracted',
          date_confidence: (metadata.date_confidence ?? 0.7) * 0.8,
          date_evidence: plEntry.snippet || `Prior loss date from ${fileName}`,
          doc_type: docType,
          metadata_json: { file_name: fileName, extraction_method: 'ai_labeled_date', label: 'prior_loss_date', evidence_snippet: plEntry.snippet },
        });
      }
    }
  }

  // 2) Fallback: document_date as letter_date anchor (if labeled_dates didn't produce it)
  const documentDate = metadata.document_date || metadata.date_mentioned;
  const hasLetterDate = events.some(e => e.event_type === (DOC_TYPE_TO_ANCHOR_EVENT[docType] || `${docType}_issued`));
  if (documentDate && !hasLetterDate) {
    const validation = validateExtractedDate(documentDate);
    if (validation.isValid && validation.correctedDate) {
      const anchorEventType = DOC_TYPE_TO_ANCHOR_EVENT[docType] || `${docType}_issued`;
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
        metadata_json: { file_name: fileName, extraction_method: 'ai_classification_fallback', evidence_snippet: evidenceSnippet },
      });
    }
  }

  // 3) Legacy dates_found entries (map to anchor types, skip generic)
  const datesFound = metadata.dates_found;
  if (Array.isArray(datesFound)) {
    for (const df of datesFound) {
      if (!df?.date || df.type === 'letter_date') continue;
      const validation = validateExtractedDate(df.date);
      if (!validation.isValid || !validation.correctedDate) continue;

      const eventTypeMap: Record<string, string> = {
        loss_date: 'loss_event',
        claim_date: 'fnol_received',
        inspection_date: 'inspection',
        payment_date: 'payment_issued',
        acknowledgment_date: 'acknowledgement_issued',
        deadline: 'deadline',
      };
      const eventType = eventTypeMap[df.type];
      if (!eventType) continue; // Skip unmapped/generic types

      // Skip if we already have this event type from labeled_dates
      if (events.some(e => e.event_type === eventType)) continue;

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
        metadata_json: { file_name: fileName, date_type: df.type, extraction_method: 'ai_dates_found_legacy' },
      });
    }
  }

  // 4) Deadline date
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

  const PRIOR_LOSS_CONTEXT = /\b(prior|previous|history|past|prior\s+claim|previous\s+claim|prior\s+loss|previous\s+loss)\b/i;

  const labelPatterns: Array<{ regex: RegExp; eventType: string; confidence: number }> = [
    // Loss date - only explicitly labeled (will be further validated below)
    { regex: new RegExp(`(?:date\\s+of\\s+loss|DOL|loss\\s+date|loss\\s+occurred\\s+on)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'loss_event', confidence: 0.9 },
    // Prior loss detection (must come before generic patterns)
    { regex: new RegExp(`(?:prior\\s+loss|previous\\s+loss|past\\s+loss|prior\\s+claim|previous\\s+claim)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'prior_loss_mentioned', confidence: 0.85 },
    // FNOL / Date Reported
    { regex: new RegExp(`(?:date\\s+reported|reported\\s+to\\s+us|notice\\s+of\\s+loss\\s+received|date\\s+of\\s+claim|claim\\s+reported)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'fnol_received', confidence: 0.9 },
    // Acknowledgement
    { regex: new RegExp(`(?:acknowledgement|acknowledgment|acknowledge)\\s*(?:date|letter)?\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'acknowledgement_issued', confidence: 0.85 },
    // Reservation of Rights
    { regex: new RegExp(`(?:reservation\\s+of\\s+rights|ROR)\\s*(?:date|letter)?\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'ror_issued', confidence: 0.9 },
    // Denial date
    { regex: new RegExp(`(?:denial\\s+date|date\\s+(?:of\\s+)?denial|denied\\s+on|decline\\s+date)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'denial_issued', confidence: 0.9 },
    // Inspection date
    { regex: new RegExp(`(?:inspection\\s+date|inspected\\s+on|site\\s+visit\\s+(?:on|date))\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'inspection', confidence: 0.85 },
    // Payment / Check date
    { regex: new RegExp(`(?:check\\s+date|payment\\s+date|EFT\\s+date|draft\\s+date|payment\\s+issued)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'payment_issued', confidence: 0.85 },
    // Received date
    { regex: new RegExp(`(?:received\\s+on|date\\s+received)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'document_received', confidence: 0.8 },
    // Estimate date
    { regex: new RegExp(`(?:estimate\\s+date|prepared\\s+on|scope\\s+date)\\s*[:\\-]?\\s*${DATE_CAPTURE}`, 'gi'), eventType: 'estimate_issued', confidence: 0.85 },
    // Generic issued/dated (lowest priority)
    { regex: new RegExp(`(?:issued|dated)\\s*[:\\-]\\s*${DATE_CAPTURE}`, 'gi'), eventType: `${docType}_issued`, confidence: 0.7 },
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

      let effectiveEventType = lp.eventType;
      const snippet = getSnippet(match.index);

      // For loss_event, check if surrounding 50 chars contain prior/previous/history context
      if (effectiveEventType === 'loss_event') {
        const contextWindow = text.substring(Math.max(0, match.index - 50), Math.min(text.length, match.index + match[0].length + 50));
        if (PRIOR_LOSS_CONTEXT.test(contextWindow)) {
          effectiveEventType = 'prior_loss_mentioned';
          console.log(`[DateExtract][Regex] Reclassified loss_event → prior_loss_mentioned: "${snippet}"`);
        }
      }

      const key = `${effectiveEventType}|${occurredAt}|${fileId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labeledFound++;

      events.push({
        claim_id: claimId,
        event_type: effectiveEventType,
        occurred_at: occurredAt,
        summary: `${effectiveEventType.replace(/_/g, ' ')}: ${rawDate} (regex from ${fileName})`,
        source_artifact_id: fileId || null,
        source_artifact_type: 'claim_file',
        date_source: 'document_text_regex',
        date_confidence: lp.confidence,
        date_evidence: snippet,
        doc_type: docType,
        metadata_json: { file_name: fileName, extraction_method: 'text_regex_labeled', label: effectiveEventType },
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
