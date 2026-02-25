import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 50; // OpenAI supports up to 2048 inputs per request

// Generate embeddings for an array of texts using OpenAI
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not configured');

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('OpenAI embedding error:', response.status, errorText);
    throw new Error(`OpenAI embedding failed: ${response.status}`);
  }

  const data = await response.json();
  return data.data.map((item: any) => item.embedding);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { documentId, texts, chunkIds } = body;

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Mode 1: Generate embeddings for specific texts and chunk IDs
    if (texts && chunkIds && texts.length === chunkIds.length) {
      console.log(`Generating embeddings for ${texts.length} chunks`);
      
      let totalProcessed = 0;
      
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batchTexts = texts.slice(i, i + BATCH_SIZE);
        const batchIds = chunkIds.slice(i, i + BATCH_SIZE);
        
        const embeddings = await generateEmbeddings(batchTexts);
        
        // Update each chunk with its embedding
        for (let j = 0; j < batchIds.length; j++) {
          const { error } = await supabase
            .from('ai_knowledge_chunks')
            .update({ embedding: embeddings[j] })
            .eq('id', batchIds[j]);
          
          if (error) {
            console.error(`Failed to update embedding for chunk ${batchIds[j]}:`, error.message);
          }
        }
        
        totalProcessed += batchTexts.length;
        console.log(`Processed batch: ${totalProcessed}/${texts.length}`);
      }

      return new Response(JSON.stringify({ success: true, processed: totalProcessed }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Mode 2: Generate embeddings for all chunks of a document
    if (documentId) {
      const { data: chunks, error: fetchError } = await supabase
        .from('ai_knowledge_chunks')
        .select('id, content')
        .eq('document_id', documentId)
        .is('embedding', null);

      if (fetchError) throw new Error(`Failed to fetch chunks: ${fetchError.message}`);
      if (!chunks || chunks.length === 0) {
        console.log(`No chunks without embeddings for document ${documentId}`);
        return new Response(JSON.stringify({ success: true, processed: 0 }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      console.log(`Generating embeddings for ${chunks.length} chunks of document ${documentId}`);

      let totalProcessed = 0;
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const batchTexts = batch.map(c => c.content);
        
        const embeddings = await generateEmbeddings(batchTexts);
        
        for (let j = 0; j < batch.length; j++) {
          const { error } = await supabase
            .from('ai_knowledge_chunks')
            .update({ embedding: embeddings[j] })
            .eq('id', batch[j].id);
          
          if (error) {
            console.error(`Failed to update embedding for chunk ${batch[j].id}:`, error.message);
          }
        }
        
        totalProcessed += batch.length;
        console.log(`Embedded batch: ${totalProcessed}/${chunks.length}`);
      }

      return new Response(JSON.stringify({ success: true, processed: totalProcessed }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Mode 3: Generate embedding for a single query (used by retrieval)
    if (body.query) {
      const embeddings = await generateEmbeddings([body.query]);
      return new Response(JSON.stringify({ embedding: embeddings[0] }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Provide documentId, texts+chunkIds, or query' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Embedding generation error:', errorMessage);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
