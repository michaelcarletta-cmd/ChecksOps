import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import JSZip from "https://esm.sh/jszip@3.10.1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Maximum file size: 20MB (matches upload limit)
const MAX_FILE_SIZE = 20 * 1024 * 1024;
// AI extraction limit (base64 uses ~1.33x memory, plus AI processing overhead)
// 5MB file = ~6.7MB base64 = ~50MB+ memory with AI context
const AI_EXTRACTION_LIMIT = 5 * 1024 * 1024; // 5MB
// Image direct URL threshold - larger images use direct URLs to save memory
const IMAGE_DIRECT_URL_THRESHOLD = 4 * 1024 * 1024; // 4MB

// Split text into chunks for RAG with heading preservation
function splitIntoChunks(text: string, chunkSize = 600, overlap = 100): string[] {
  // Split by headings/sections first, then by size
  const sections = text.split(/(?=^#{1,6}\s|^\[Slide |^\[Image:|^\[Title:|^---)/m);
  const chunks: string[] = [];
  let currentChunk = '';
  let currentHeading = '';

  for (const section of sections) {
    // Detect if this section starts with a heading
    const headingMatch = section.match(/^(#{1,6}\s.+|^\[.+?\])/m);
    if (headingMatch) {
      currentHeading = headingMatch[0].trim();
    }

    if (currentChunk.length + section.length <= chunkSize) {
      currentChunk += section;
    } else {
      // Save current chunk if it has content
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
      }
      // For long sections, split with overlap and prepend heading context
      if (section.length > chunkSize) {
        let start = 0;
        while (start < section.length) {
          const end = Math.min(start + chunkSize, section.length);
          let chunkText = section.slice(start, end);
          // Prepend heading context if this isn't the first sub-chunk
          if (start > 0 && currentHeading) {
            chunkText = `[Context: ${currentHeading}]\n${chunkText}`;
          }
          chunks.push(chunkText.trim());
          start = end - overlap;
          if (start < 0) start = 0;
          if (end === section.length) break;
        }
        currentChunk = '';
      } else {
        currentChunk = section;
      }
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  // Filter out empty chunks
  return chunks.filter(c => c.length > 20);
}

// Get mime type from file type
function getMimeType(fileType: string, fileName: string): string {
  if (fileType === 'application/pdf' || fileName.endsWith('.pdf')) {
    return 'application/pdf';
  }
  if (fileType.includes('word') || fileName.match(/\.docx?$/i)) {
    return fileType.includes('docx') 
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' 
      : 'application/msword';
  }
  if (fileType.includes('powerpoint') || fileType.includes('presentation') || fileName.match(/\.pptx?$/i)) {
    return fileName.match(/\.pptx$/i) 
      ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' 
      : 'application/vnd.ms-powerpoint';
  }
  if (fileType.includes('video') || fileName.match(/\.(mp4|mov|avi|mkv|webm)$/i)) {
    return 'video/mp4';
  }
  if (fileType.includes('audio') || fileName.match(/\.(mp3|wav|m4a)$/i)) {
    return 'audio/mpeg';
  }
  // Image types
  if (fileType.includes('image') || fileName.match(/\.(jpg|jpeg|png|gif|webp|bmp|heic)$/i)) {
    if (fileName.match(/\.png$/i)) return 'image/png';
    if (fileName.match(/\.gif$/i)) return 'image/gif';
    if (fileName.match(/\.webp$/i)) return 'image/webp';
    if (fileName.match(/\.bmp$/i)) return 'image/bmp';
    return 'image/jpeg';
  }
  return fileType || 'application/octet-stream';
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/') && 
    ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'].includes(mimeType);
}

// Download and convert to base64 data URL
async function downloadAndEncodeFile(fileUrl: string, mimeType: string, fileSize: number | null): Promise<{ url: string; isDirectUrl: boolean }> {
  // Check file size before processing
  if (fileSize && fileSize > MAX_FILE_SIZE) {
    throw new Error(`File too large (${Math.round(fileSize / 1024 / 1024)}MB). Maximum supported size is 20MB.`);
  }
  
  // Large images can use direct URLs - saves memory
  const canUseDirectUrl = isImageMimeType(mimeType);
  
  if (canUseDirectUrl && fileSize && fileSize > IMAGE_DIRECT_URL_THRESHOLD) {
    console.log(`Large image (${Math.round(fileSize / 1024 / 1024)}MB), using direct URL`);
    return { url: fileUrl, isDirectUrl: true };
  }
  
  console.log(`Downloading file for base64 encoding (${Math.round((fileSize || 0) / 1024 / 1024)}MB)...`);
  
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.status}`);
  }
  
  const arrayBuffer = await response.arrayBuffer();
  const base64 = base64Encode(arrayBuffer);
  
  console.log(`Encoded file: ${arrayBuffer.byteLength} bytes as base64`);
  
  return { url: `data:${mimeType};base64,${base64}`, isDirectUrl: false };
}

// Extract text from document using base64 data
async function extractTextFromDocument(dataUrl: string, fileName: string): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

  console.log(`Extracting text from document: ${fileName}`);

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
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Please extract all the text content from this document. Return only the extracted text, preserving the structure and formatting as much as possible. Include all headings, paragraphs, lists, and tables. Do not add any commentary or analysis.'
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl }
            }
          ]
        }
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Document extraction error:', errorText);
    
    if (response.status === 429) {
      throw new Error('Rate limit exceeded. Please try again in a few minutes.');
    }
    if (response.status === 402) {
      throw new Error('AI credits exhausted. Please add funds to continue processing.');
    }
    
    throw new Error(`Failed to extract document text: ${response.status}`);
  }

  const data = await response.json();
  const extractedText = data.choices?.[0]?.message?.content || '';
  console.log(`Extracted ${extractedText.length} characters`);
  return extractedText;
}

// Analyze image content using AI
async function analyzeImage(dataUrl: string, fileName: string): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

  console.log(`Analyzing image: ${fileName}`);

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
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Please analyze this image thoroughly and provide a detailed description. Include:
1. Any visible text (OCR if present)
2. What type of document or photo this appears to be
3. Key visual elements, objects, or subjects shown
4. Any relevant details that would be useful for insurance claims (damage assessment, property conditions, etc.)
5. If this is a document, extract all readable content

Provide your analysis in a clear, structured format that can be used as a knowledge reference.`
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl }
            }
          ]
        }
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Image analysis error:', errorText);
    
    if (response.status === 429) {
      throw new Error('Rate limit exceeded. Please try again in a few minutes.');
    }
    if (response.status === 402) {
      throw new Error('AI credits exhausted. Please add funds to continue processing.');
    }
    
    throw new Error(`Failed to analyze image: ${response.status}`);
  }

  const data = await response.json();
  const analysisText = data.choices?.[0]?.message?.content || '';
  console.log(`Analyzed image, got ${analysisText.length} characters`);
  return `[Image: ${fileName}]\n\n${analysisText}`;
}

// Extract text from PowerPoint files (PPTX is a ZIP containing XML)
async function extractTextFromPowerPoint(fileUrl: string, fileName: string): Promise<string> {
  console.log(`Extracting text from PowerPoint: ${fileName}`);
  
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`Failed to download PowerPoint file: ${response.status}`);
  }
  
  const arrayBuffer = await response.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);
  
  const textParts: string[] = [];
  
  // Extract text from slide XML files
  const slideFiles = Object.keys(zip.files)
    .filter(name => name.match(/^ppt\/slides\/slide\d+\.xml$/))
    .sort((a, b) => {
      const numA = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
      const numB = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
      return numA - numB;
    });
  
  for (const slidePath of slideFiles) {
    const slideNum = slidePath.match(/slide(\d+)/)?.[1] || '?';
    const content = await zip.files[slidePath].async('string');
    
    // Extract text from XML tags like <a:t>text</a:t>
    const textMatches = content.match(/<a:t>([^<]*)<\/a:t>/g) || [];
    const slideText = textMatches
      .map(match => match.replace(/<\/?a:t>/g, '').trim())
      .filter(text => text.length > 0)
      .join(' ');
    
    if (slideText) {
      textParts.push(`[Slide ${slideNum}]\n${slideText}`);
    }
  }
  
  // Also extract from notes if present
  const notesFiles = Object.keys(zip.files)
    .filter(name => name.match(/^ppt\/notesSlides\/notesSlide\d+\.xml$/));
  
  for (const notePath of notesFiles) {
    const slideNum = notePath.match(/notesSlide(\d+)/)?.[1] || '?';
    const content = await zip.files[notePath].async('string');
    
    const textMatches = content.match(/<a:t>([^<]*)<\/a:t>/g) || [];
    const noteText = textMatches
      .map(match => match.replace(/<\/?a:t>/g, '').trim())
      .filter(text => text.length > 0)
      .join(' ');
    
    if (noteText) {
      textParts.push(`[Slide ${slideNum} Notes]\n${noteText}`);
    }
  }
  
  const extractedText = textParts.join('\n\n');
  console.log(`Extracted ${extractedText.length} characters from PowerPoint`);
  
  if (!extractedText || extractedText.trim().length === 0) {
    throw new Error('No text content found in PowerPoint file');
  }
  
  return extractedText;
}

// Transcribe audio/video using base64 data
async function transcribeMedia(dataUrl: string, fileName: string): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

  console.log(`Transcribing media: ${fileName}`);

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
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Please transcribe all the spoken content from this audio/video file. Return only the transcription text, preserving natural paragraph breaks where appropriate. Do not add any commentary or analysis.'
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl }
            }
          ]
        }
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Transcription error:', errorText);
    
    if (response.status === 429) {
      throw new Error('Rate limit exceeded. Please try again in a few minutes.');
    }
    if (response.status === 402) {
      throw new Error('AI credits exhausted. Please add funds to continue processing.');
    }
    
    throw new Error(`Failed to transcribe media: ${response.status}`);
  }

  const data = await response.json();
  const transcribedText = data.choices?.[0]?.message?.content || '';
  console.log(`Transcribed ${transcribedText.length} characters`);
  return transcribedText;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  let documentId: string | null = null;

  try {
    const body = await req.json();
    documentId = body.documentId;
    
    if (!documentId) {
      return new Response(JSON.stringify({ error: 'documentId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get document info
    const { data: document, error: docError } = await supabase
      .from('ai_knowledge_documents')
      .select('*')
      .eq('id', documentId)
      .single();

    if (docError || !document) {
      console.error('Document not found:', docError);
      return new Response(JSON.stringify({ error: 'Document not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Check file size before processing
    if (document.file_size && document.file_size > MAX_FILE_SIZE) {
      const errorMsg = `File too large (${Math.round(document.file_size / 1024 / 1024)}MB). Maximum supported size is 20MB. Please upload a smaller file.`;
      await supabase
        .from('ai_knowledge_documents')
        .update({ status: 'failed', error_message: errorMsg })
        .eq('id', documentId);
      
      return new Response(JSON.stringify({ error: errorMsg }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Update status to processing
    await supabase
      .from('ai_knowledge_documents')
      .update({ status: 'processing' })
      .eq('id', documentId);

    // Get signed URL for the file (1 hour validity)
    const { data: signedUrlData, error: urlError } = await supabase.storage
      .from('ai-knowledge-base')
      .createSignedUrl(document.file_path, 3600);

    if (urlError || !signedUrlData?.signedUrl) {
      throw new Error('Failed to get signed URL for document');
    }

    const fileUrl = signedUrlData.signedUrl;
    const fileType = document.file_type.toLowerCase();
    const mimeType = getMimeType(fileType, document.file_name);

    console.log(`Processing document: ${document.file_name}, type: ${fileType}, size: ${document.file_size || 'unknown'}`);

    let extractedText = '';
    const isPdf = fileType === 'application/pdf' || document.file_name.toLowerCase().endsWith('.pdf');
    const fileSize = document.file_size || 0;

    // Process based on file type - ORDER MATTERS!
    // PowerPoint must be checked before Word docs since both contain "document" in MIME type
    if (isPdf) {
      // PDF Processing Strategy:
      // - Small PDFs (<5MB): AI extraction with OCR capability
      // - Large PDFs (>5MB): Reject - base64 encoding + AI processing exceeds memory limits
      
      if (fileSize > AI_EXTRACTION_LIMIT) {
        throw new Error(`PDF too large (${Math.round(fileSize / 1024 / 1024)}MB). Maximum size for PDFs is 5MB due to processing limits. Please compress or split the file.`);
      }
      
      // Use AI extraction with OCR support
      console.log(`Processing PDF (${Math.round(fileSize / 1024 / 1024)}MB) with AI extraction`);
      const fileData = await downloadAndEncodeFile(fileUrl, mimeType, fileSize);
      extractedText = await extractTextFromDocument(fileData.url, document.file_name);
    } else if (
      fileType.includes('video') || 
      fileType.includes('audio') ||
      document.file_name.match(/\.(mp4|mov|avi|mkv|mp3|wav|m4a|webm)$/i)
    ) {
      const fileData = await downloadAndEncodeFile(fileUrl, mimeType, fileSize);
      extractedText = await transcribeMedia(fileData.url, document.file_name);
    } else if (
      fileType.includes('powerpoint') || 
      fileType.includes('presentation') ||
      document.file_name.match(/\.(pptx|ppt)$/i)
    ) {
      // PowerPoint files need direct XML extraction, not AI processing
      extractedText = await extractTextFromPowerPoint(fileUrl, document.file_name);
    } else if (
      fileType.includes('word') || 
      fileType.includes('wordprocessingml') ||
      document.file_name.match(/\.(docx|doc)$/i)
    ) {
      const fileData = await downloadAndEncodeFile(fileUrl, mimeType, fileSize);
      extractedText = await extractTextFromDocument(fileData.url, document.file_name);
    } else if (
      fileType.includes('image') ||
      document.file_name.match(/\.(jpg|jpeg|png|gif|webp|bmp|heic)$/i)
    ) {
      const fileData = await downloadAndEncodeFile(fileUrl, mimeType, fileSize);
      extractedText = await analyzeImage(fileData.url, document.file_name);
    } else {
      throw new Error(`Unsupported file type: ${fileType}`);
    }

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error('No text could be extracted from the document');
    }

    console.log(`Extracted ${extractedText.length} characters from ${document.file_name}`);

    // Split into chunks
    const chunks = splitIntoChunks(extractedText);
    console.log(`Split into ${chunks.length} chunks`);

    // Delete any existing chunks for this document
    await supabase
      .from('ai_knowledge_chunks')
      .delete()
      .eq('document_id', documentId);

    // Insert new chunks
    const chunkInserts = chunks.map((content, index) => ({
      document_id: documentId,
      content,
      chunk_index: index,
      metadata: {
        category: document.category,
        file_name: document.file_name,
        total_chunks: chunks.length,
      },
    }));

    const { data: insertedChunks, error: insertError } = await supabase
      .from('ai_knowledge_chunks')
      .insert(chunkInserts)
      .select('id, content');

    if (insertError) {
      throw new Error(`Failed to insert chunks: ${insertError.message}`);
    }

    // Generate embeddings for the chunks
    if (insertedChunks && insertedChunks.length > 0) {
      console.log(`Generating embeddings for ${insertedChunks.length} chunks...`);
      try {
        const embeddingResponse = await fetch(
          `${supabaseUrl}/functions/v1/generate-embeddings`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${supabaseServiceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              texts: insertedChunks.map((c: any) => c.content),
              chunkIds: insertedChunks.map((c: any) => c.id),
            }),
          }
        );
        if (!embeddingResponse.ok) {
          const errText = await embeddingResponse.text();
          console.error('Embedding generation failed:', errText);
        } else {
          const embResult = await embeddingResponse.json();
          console.log(`Embeddings generated: ${embResult.processed} chunks`);
        }
      } catch (embError) {
        console.error('Embedding generation error (non-fatal):', embError);
      }
    }

    // Update document status to completed
    await supabase
      .from('ai_knowledge_documents')
      .update({ status: 'completed' })
      .eq('id', documentId);

    console.log(`Successfully processed document: ${document.file_name}`);

    return new Response(JSON.stringify({ 
      success: true, 
      chunks: chunks.length,
      characters: extractedText.length 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error processing document:', errorMessage);
    
    if (documentId) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        
        await supabase
          .from('ai_knowledge_documents')
          .update({ 
            status: 'failed',
            error_message: errorMessage 
          })
          .eq('id', documentId);
      } catch (e) {
        console.error('Failed to update document status:', e);
      }
    }

    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
