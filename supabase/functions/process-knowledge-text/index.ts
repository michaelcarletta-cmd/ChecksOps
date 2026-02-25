import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Split text into chunks for RAG with heading preservation
function splitIntoChunks(text: string, chunkSize = 600, overlap = 100): string[] {
  const sections = text.split(/(?=^#{1,6}\s|^\[Title:|^\[Type:|^---)/m);
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  let documentId: string | null = null;

  try {
    const body = await req.json();
    documentId = body.documentId;
    const content = body.content;
    const title = body.title;
    
    if (!documentId) {
      return new Response(JSON.stringify({ error: 'documentId is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!content) {
      return new Response(JSON.stringify({ error: 'content is required' }), {
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

    console.log(`Processing text content: ${title} (${content.length} characters)`);

    // Prepend title/metadata to content for context
    const fullContent = `[Title: ${title}]\n[Type: Text Content]\n[Category: ${document.category}]\n\n${content}`;

    // Split into chunks
    const chunks = splitIntoChunks(fullContent);
    console.log(`Split into ${chunks.length} chunks`);

    // Delete any existing chunks for this document
    await supabase
      .from('ai_knowledge_chunks')
      .delete()
      .eq('document_id', documentId);

    // Insert new chunks
    const chunkInserts = chunks.map((chunkContent, index) => ({
      document_id: documentId,
      content: chunkContent,
      chunk_index: index,
      metadata: {
        category: document.category,
        file_name: title,
        source_type: 'text',
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

    // Update document status
    await supabase
      .from('ai_knowledge_documents')
      .update({ 
        status: 'completed',
        file_name: title,
      })
      .eq('id', documentId);

    console.log(`Successfully processed text content: ${title}`);

    return new Response(JSON.stringify({ 
      success: true, 
      chunks: chunks.length,
      characters: content.length,
      title,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('Text processing error:', errorMessage);

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
