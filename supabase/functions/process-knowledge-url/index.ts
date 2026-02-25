import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Split text into chunks for RAG with heading preservation
function splitIntoChunks(text: string, chunkSize = 600, overlap = 100): string[] {
  const sections = text.split(/(?=^#{1,6}\s|^\[Source:|^\[Title:|^---)/m);
  const chunks: string[] = [];
  let currentChunk = '';
  let currentHeading = '';

  for (const section of sections) {
    const headingMatch = section.match(/^(#{1,6}\s.+|^\[.+?\])/m);
    if (headingMatch) {
      currentHeading = headingMatch[0].trim();
    }

    if (currentChunk.length + section.length <= chunkSize) {
      currentChunk += section;
    } else {
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
      }
      if (section.length > chunkSize) {
        let start = 0;
        while (start < section.length) {
          const end = Math.min(start + chunkSize, section.length);
          let chunkText = section.slice(start, end);
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

  return chunks.filter(c => c.length > 20);
}

// Extract main content from HTML
function extractTextFromHtml(html: string): string {
  // Remove script and style tags with their content
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  
  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  
  // Replace block-level elements with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
  text = text.replace(/<(br|hr)[^>]*\/?>/gi, '\n');
  
  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, ' ');
  
  // Decode HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&apos;/g, "'");
  
  // Clean up whitespace
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\n\s+/g, '\n');
  text = text.replace(/\n+/g, '\n\n');
  
  return text.trim();
}

// Fetch and extract content from URL
async function fetchUrlContent(url: string): Promise<{ title: string; content: string }> {
  console.log(`Fetching URL: ${url}`);
  
  // Use browser-like headers to avoid bot blocking
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  
  if (!response.ok) {
    // If still blocked, provide helpful message
    if (response.status === 403) {
      throw new Error(`This website (${new URL(url).hostname}) blocks automated access. Try a different page or add the content manually.`);
    }
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }
  
  const html = await response.text();
  
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;
  
  // Extract main content
  const content = extractTextFromHtml(html);
  
  return { title, content };
}

// Use AI to summarize and structure the content
async function analyzeUrlContent(url: string, rawContent: string, title: string): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

  console.log(`Analyzing content from: ${title}`);

  // Truncate content if too long
  const maxLength = 50000;
  const truncatedContent = rawContent.length > maxLength 
    ? rawContent.substring(0, maxLength) + '...[truncated]'
    : rawContent;

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
          content: `Please analyze and extract the key information from this web page content. 

URL: ${url}
Title: ${title}

Content:
${truncatedContent}

Please provide:
1. A structured summary of the main topics and information
2. Key facts, procedures, or guidelines mentioned
3. Any important definitions or terminology
4. Relevant details that would be useful for insurance claims processing

Format your response in a clear, organized way that can be used as a knowledge reference. Include the source URL for attribution.`
        }
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Content analysis error:', errorText);
    
    if (response.status === 429) {
      throw new Error('Rate limit exceeded. Please try again in a few minutes.');
    }
    if (response.status === 402) {
      throw new Error('AI credits exhausted. Please add funds to continue processing.');
    }
    
    throw new Error(`Failed to analyze content: ${response.status}`);
  }

  const data = await response.json();
  const analyzedText = data.choices?.[0]?.message?.content || '';
  
  // Prepend source info
  return `[Source: ${url}]\n[Title: ${title}]\n\n${analyzedText}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  let documentId: string | null = null;

  try {
    const body = await req.json();
    documentId = body.documentId;
    const url = body.url;
    
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

    // Update status to processing
    await supabase
      .from('ai_knowledge_documents')
      .update({ status: 'processing' })
      .eq('id', documentId);

    // The URL is stored in file_path for URL-type documents
    const targetUrl = url || document.file_path;
    
    console.log(`Processing URL: ${targetUrl}`);

    // Fetch content from URL
    const { title, content: rawContent } = await fetchUrlContent(targetUrl);
    
    if (!rawContent || rawContent.trim().length < 100) {
      throw new Error('Could not extract meaningful content from the URL');
    }

    console.log(`Fetched ${rawContent.length} characters from ${title}`);

    // Analyze and structure the content using AI
    const analyzedContent = await analyzeUrlContent(targetUrl, rawContent, title);

    if (!analyzedContent || analyzedContent.trim().length === 0) {
      throw new Error('Failed to analyze URL content');
    }

    console.log(`Analyzed content: ${analyzedContent.length} characters`);

    // Split into chunks
    const chunks = splitIntoChunks(analyzedContent);
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
        source_url: targetUrl,
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
          console.error('Embedding generation failed:', await embeddingResponse.text());
        } else {
          const embResult = await embeddingResponse.json();
          console.log(`Embeddings generated: ${embResult.processed} chunks`);
        }
      } catch (embError) {
        console.error('Embedding generation error (non-fatal):', embError);
      }
    }

    // Update document status and title
    await supabase
      .from('ai_knowledge_documents')
      .update({ 
        status: 'completed',
        file_name: title || document.file_name,
      })
      .eq('id', documentId);

    console.log(`Successfully processed URL: ${targetUrl}`);

    return new Response(JSON.stringify({ 
      success: true, 
      chunks: chunks.length,
      characters: analyzedContent.length,
      title,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('URL processing error:', errorMessage);

    // Update document status to failed
    if (documentId) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
      const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      const supabase = createClient(supabaseUrl, supabaseServiceKey);
      
      await supabase
        .from('ai_knowledge_documents')
        .update({ 
          status: 'failed', 
          error_message: errorMessage.substring(0, 500),
        })
        .eq('id', documentId);
    }

    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
