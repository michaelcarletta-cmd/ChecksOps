import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { generate } from "../_shared/ai/generate.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

function extractTextFromHtml(html: string): string {
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');
  text = text.replace(/<(br|hr)[^>]*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&apos;/g, "'");
  text = text.replace(/\s+/g, ' ');
  text = text.replace(/\n\s+/g, '\n');
  text = text.replace(/\n+/g, '\n\n');
  return text.trim();
}

async function fetchUrlContent(url: string): Promise<{ title: string; content: string }> {
  console.log(`Fetching URL: ${url}`);
  
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
    if (response.status === 403) {
      throw new Error(`This website (${new URL(url).hostname}) blocks automated access. Try a different page or add the content manually.`);
    }
    throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
  }
  
  const html = await response.text();
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;
  const content = extractTextFromHtml(html);
  
  return { title, content };
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

    const { data: document, error: docError } = await supabase
      .from('ai_knowledge_documents')
      .select('*')
      .eq('id', documentId)
      .single();

    if (docError || !document) {
      return new Response(JSON.stringify({ error: 'Document not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    await supabase
      .from('ai_knowledge_documents')
      .update({ status: 'processing' })
      .eq('id', documentId);

    const targetUrl = url || document.file_path;
    console.log(`Processing URL: ${targetUrl}`);

    const { title, content: rawContent } = await fetchUrlContent(targetUrl);
    
    if (!rawContent || rawContent.trim().length < 100) {
      throw new Error('Could not extract meaningful content from the URL');
    }

    console.log(`Fetched ${rawContent.length} characters from ${title}`);

    const maxLength = 50000;
    const truncatedContent = rawContent.length > maxLength 
      ? rawContent.substring(0, maxLength) + '...[truncated]'
      : rawContent;

    const aiResult = await generate({
      task: 'extraction',
      system: 'You are a knowledge base content analyzer for insurance claims processing.',
      user: `Please analyze and extract the key information from this web page content. 

URL: ${targetUrl}
Title: ${title}

Content:
${truncatedContent}

Please provide:
1. A structured summary of the main topics and information
2. Key facts, procedures, or guidelines mentioned
3. Any important definitions or terminology
4. Relevant details that would be useful for insurance claims processing

Format your response in a clear, organized way that can be used as a knowledge reference. Include the source URL for attribution.`,
      searchMode: 'off',
    });
    console.log(`[process-knowledge-url] model=${aiResult.model}, cached=${aiResult.cached}`);

    const analyzedContent = `[Source: ${targetUrl}]\n[Title: ${title}]\n\n${aiResult.text}`;

    if (!analyzedContent || analyzedContent.trim().length === 0) {
      throw new Error('Failed to analyze URL content');
    }

    const chunks = splitIntoChunks(analyzedContent);
    console.log(`Split into ${chunks.length} chunks`);

    await supabase
      .from('ai_knowledge_chunks')
      .delete()
      .eq('document_id', documentId);

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

    await supabase
      .from('ai_knowledge_documents')
      .update({ 
        status: 'completed',
        file_name: title || document.file_name,
      })
      .eq('id', documentId);

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
