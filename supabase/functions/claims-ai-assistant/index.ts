import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

// Use dynamic import for pdf.js to avoid bundling issues
let pdfjsLib: any = null;
async function getPdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.mjs");
  }
  return pdfjsLib;
}

// Extract text from PDF using pdf.js (proper extraction)
async function extractTextFromPDFNative(fileData: Blob): Promise<string> {
  const pdfjs = await getPdfJs();
  const arrayBuffer = await fileData.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  
  const loadingTask = pdfjs.getDocument({ data: bytes.buffer });
  const pdf = await loadingTask.promise;
  
  const textParts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ');
    if (pageText.trim()) {
      textParts.push(pageText);
    }
  }
  
  const extractedText = textParts.join('\n\n');
  console.log(`PDF.js extraction: ${extractedText.length} chars from ${pdf.numPages} pages`);
  return extractedText;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_GATEWAY_REQUEST_TIMEOUT_MS = 45_000;
const AI_GATEWAY_FOLLOW_UP_TIMEOUT_MS = 30_000;
const MAX_TOOL_CALLS_PER_TURN = 18;

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Helper function to search web using Perplexity
async function searchWeb(query: string): Promise<string> {
  // Try both possible API key names from connector
  const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY") || Deno.env.get("PERPLEXITY_API_KEY_1");
  if (!PERPLEXITY_API_KEY) {
    return "Web search unavailable: API key not configured";
  }

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'You are a research assistant for insurance claims and property restoration. Provide factual, citable information from ANY relevant source including: state statutes and insurance regulations, manufacturer bulletins and specs, building codes (IRC/IBC/ASTM), industry technical articles, contractor and engineering guidance, construction repair standards, insurance claim practice resources, case law, and general industry best practices. Do not restrict results to regulatory or manufacturer domains only. Always cite sources. Be concise and authoritative.'
          },
          {
            role: 'user',
            content: query
          }
        ],
        temperature: 0.2,
        max_tokens: 1000,
      }),
    });

    if (!response.ok) {
      console.error("Perplexity API error:", response.status);
      return "Web search temporarily unavailable";
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Error in web search:", error);
    return "Web search failed";
  }
}

// Helper function to find leads based on recent storm activity and property records
async function findLeads(location: string, damageType?: string): Promise<string> {
  const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY") || Deno.env.get("PERPLEXITY_API_KEY_1");
  if (!PERPLEXITY_API_KEY) {
    return "Lead search unavailable: Perplexity API key not configured";
  }

  try {
    // First search for recent storm events in the area
    const stormSearchQuery = `Recent severe weather events storms hail tornado hurricane wind damage in ${location} in the last 30 days. Include specific dates, areas affected, and severity of damage. Include news reports and weather service data.`;
    
    const stormResponse = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'You are a research assistant helping find recent storm damage events for insurance claim lead generation. Focus on factual weather reports, news articles about property damage, and affected neighborhoods. Be specific about dates, locations, and damage types.'
          },
          {
            role: 'user',
            content: stormSearchQuery
          }
        ],
        temperature: 0.2,
        max_tokens: 2000,
      }),
    });

    if (!stormResponse.ok) {
      console.error("Perplexity storm search error:", stormResponse.status);
      return "Storm search temporarily unavailable";
    }

    const stormData = await stormResponse.json();
    const stormInfo = stormData.choices[0].message.content;
    const citations = stormData.citations || [];

    // Second search for property owner information resources
    const propertySearchQuery = `How to find property owner contact information in ${location}. Include county assessor websites, public property records databases, and resources for finding homeowner information in this area.`;
    
    const propertyResponse = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'You are a research assistant helping find public property records and homeowner contact information. Focus on legitimate public records, county assessor websites, and legal methods of finding property owner information.'
          },
          {
            role: 'user',
            content: propertySearchQuery
          }
        ],
        temperature: 0.2,
        max_tokens: 1500,
      }),
    });

    let propertyInfo = "";
    if (propertyResponse.ok) {
      const propertyData = await propertyResponse.json();
      propertyInfo = propertyData.choices[0].message.content;
    }

    let result = `
LEAD RESEARCH RESULTS FOR: ${location}
${damageType ? `Damage Type Focus: ${damageType}` : ''}

=== RECENT STORM ACTIVITY ===
${stormInfo}

=== SOURCES ===
${citations.length > 0 ? citations.map((c: string, i: number) => `${i + 1}. ${c}`).join('\n') : 'See embedded links in report above'}

=== PUBLIC PROPERTY RECORDS RESOURCES ===
${propertyInfo || 'Property record search resources not available for this area.'}

=== RECOMMENDED NEXT STEPS ===
1. Review the storm events above to identify affected neighborhoods
2. Use the property records resources to find homeowner contact information
3. Target your marketing/outreach to areas with confirmed damage
4. Consider door-to-door canvassing in heavily affected areas
5. Check local news for additional damage reports and affected communities
`;

    return result;
  } catch (error) {
    console.error("Error in lead search:", error);
    return "Lead search failed. Please try again.";
  }
}

// Helper function to get weather for a specific date and location
async function getWeatherReport(location: string, date: string): Promise<string> {
  const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY") || Deno.env.get("PERPLEXITY_API_KEY_1");
  if (!PERPLEXITY_API_KEY) {
    return "Weather search unavailable: API key not configured";
  }

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-large-128k-online',
        messages: [
          {
            role: 'system',
            content: 'You are a weather research assistant. Provide detailed historical weather information including temperature, precipitation, wind speeds, and any severe weather events. Focus on facts from official weather records.'
          },
          {
            role: 'user',
            content: `What was the weather like in ${location} on ${date}? Include temperature, precipitation, wind conditions, and any severe weather events or storms that occurred. Search for historical weather data and news reports.`
          }
        ],
        temperature: 0.2,
        max_tokens: 1500,
      }),
    });

    if (!response.ok) {
      console.error("Weather search error:", response.status);
      return "Weather data temporarily unavailable";
    }

    const data = await response.json();
    return data.choices[0].message.content;
  } catch (error) {
    console.error("Error in weather search:", error);
    return "Weather search failed";
  }
}

// Helper function to analyze document content
async function analyzeDocument(fileUrl: string, fileName: string): Promise<string> {
  try {
    return `Document: ${fileName} (${fileUrl})`;
  } catch (error) {
    console.error("Error analyzing document:", error);
    return `Document: ${fileName} (unable to analyze content)`;
  }
}

// Generate query embedding via the generate-embeddings edge function
async function getQueryEmbedding(question: string): Promise<number[] | null> {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const response = await fetch(`${supabaseUrl}/functions/v1/generate-embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: question }),
    });
    
    if (!response.ok) {
      console.error('[KB Retrieval] Failed to generate query embedding:', response.status);
      return null;
    }
    
    const data = await response.json();
    return data.embedding || null;
  } catch (error) {
    console.error('[KB Retrieval] Embedding generation error:', error);
    return null;
  }
}

interface KnowledgeSearchResult {
  context: string;
  retrievalMode: "none" | "keyword_only" | "hybrid";
  chunkCount: number;
  sourceCount: number;
  topSources: string[];
}

interface EvidencePlanDecision {
  strategy: "internal_only" | "internal_preferred" | "hybrid_balanced" | "web_priority";
  reason: string;
  shouldSearchWeb: boolean;
  searchQuery: string | null;
}

// Search knowledge base using hybrid search (embedding + keyword)
async function searchKnowledgeBase(
  supabase: any,
  question: string,
  category?: string
): Promise<KnowledgeSearchResult> {
  try {
    const MAX_CHUNKS_PER_DOC = 3;
    const TOP_K = 10;
    
    // === STEP 1: Semantic search via embeddings ===
    const queryEmbedding = await getQueryEmbedding(question);
    
    let semanticResults: any[] = [];
    if (queryEmbedding) {
      const { data: embeddingResults, error: embError } = await supabase.rpc(
        'match_knowledge_chunks',
        {
          query_embedding: queryEmbedding,
          match_count: 30,
          filter_category: category || null,
        }
      );
      
      if (embError) {
        console.error('[KB Retrieval] Semantic search error:', embError.message);
      } else {
        semanticResults = (embeddingResults || []).map((r: any) => ({
          id: r.id,
          content: r.content,
          metadata: r.metadata,
          document_id: r.document_id,
          chunk_index: r.chunk_index,
          semantic_score: r.similarity,
          doc_file_name: r.doc_file_name,
          doc_category: r.doc_category,
        }));
        console.log(`[KB Retrieval] Semantic search returned ${semanticResults.length} results`);
      }
    } else {
      console.log('[KB Retrieval] No embedding available, falling back to keyword-only search');
    }
    
    // === STEP 2: Keyword scoring (lightweight fallback / hybrid boost) ===
    // Fetch chunks for keyword scoring
    let keywordPool: any[] = [];
    if (semanticResults.length < TOP_K) {
      let query = supabase
        .from("ai_knowledge_chunks")
        .select(`content, metadata, document_id, ai_knowledge_documents!inner(category, file_name, status)`)
        .eq("ai_knowledge_documents.status", "completed");
      if (category) {
        query = query.eq("ai_knowledge_documents.category", category);
      }
      const { data: chunks } = await query.limit(500);
      keywordPool = chunks || [];
    }
    
    const questionLower = question.toLowerCase();
    const questionWords = questionLower
      .split(/\s+/)
      .filter((w: string) => w.length >= 2)
      .map((w: string) => w.replace(/[^a-z0-9&]/g, ''))
      .filter((w: string) => w.length >= 2);
    
    const importantTerms = [
      'depreciation', 'acv', 'rcv', 'actual cash value', 'replacement cost',
      'ordinance', 'law', 'code', 'compliance', 'deductible', 'coverage',
      'policy', 'supplement', 'denial', 'settlement', 'recoverable',
      'non-recoverable', 'dwelling', 'roofing', 'damage', 'wind', 'hail',
      'storm', 'inspection', 'estimate', 'xactimate'
    ];
    
    const matchedTerms = importantTerms.filter(term => questionLower.includes(term));
    
    // Score keyword pool
    const keywordScored = keywordPool.map((chunk: any) => {
      const contentLower = chunk.content.toLowerCase();
      let score = 0;
      questionWords.forEach((word: string) => {
        if (contentLower.includes(word)) {
          score += 1;
          if (importantTerms.includes(word)) score += 2;
        }
      });
      matchedTerms.forEach(term => {
        if (contentLower.includes(term)) score += 3;
      });
      return {
        ...chunk,
        keyword_score: score,
        doc_file_name: chunk.ai_knowledge_documents?.file_name || 'Unknown',
        doc_category: chunk.ai_knowledge_documents?.category || 'General',
      };
    }).filter((c: any) => c.keyword_score > 0);
    
    // === STEP 3: Merge and deduplicate ===
    const chunkMap = new Map<string, any>();
    
    // Add semantic results (normalized score 0-1)
    for (const r of semanticResults) {
      chunkMap.set(r.id, {
        ...r,
        hybrid_score: (r.semantic_score || 0) * 0.7, // 70% weight for semantic
        keyword_score: 0,
        semantic_score: r.semantic_score || 0,
      });
    }
    
    // Merge keyword results
    const maxKeyword = Math.max(...keywordScored.map((c: any) => c.keyword_score), 1);
    for (const r of keywordScored) {
      const normalizedKw = r.keyword_score / maxKeyword;
      const existing = chunkMap.get(r.id);
      if (existing) {
        existing.keyword_score = normalizedKw;
        existing.hybrid_score = (existing.semantic_score * 0.7) + (normalizedKw * 0.3);
      } else {
        chunkMap.set(r.id || `kw-${r.document_id}-${r.chunk_index}`, {
          ...r,
          hybrid_score: normalizedKw * 0.3, // keyword-only gets 30% weight
          keyword_score: normalizedKw,
          semantic_score: 0,
        });
      }
    }
    
    // Sort by hybrid score
    const allResults = Array.from(chunkMap.values());
    allResults.sort((a, b) => b.hybrid_score - a.hybrid_score);
    
    // === STEP 4: Per-document diversity cap ===
    const docChunkCounts: Record<string, number> = {};
    const diverseChunks: any[] = [];
    
    for (const chunk of allResults) {
      const docId = chunk.document_id;
      const currentCount = docChunkCounts[docId] || 0;
      if (currentCount < MAX_CHUNKS_PER_DOC) {
        diverseChunks.push(chunk);
        docChunkCounts[docId] = currentCount + 1;
        if (diverseChunks.length >= TOP_K) break;
      }
    }

    // === RETRIEVAL LOGGING ===
    const docScoreSummary: Record<string, { name: string; chunks: number; topHybrid: number; topSemantic: number; topKeyword: number }> = {};
    for (const chunk of diverseChunks) {
      const name = chunk.doc_file_name || 'Unknown';
      if (!docScoreSummary[chunk.document_id]) {
        docScoreSummary[chunk.document_id] = { name, chunks: 0, topHybrid: 0, topSemantic: 0, topKeyword: 0 };
      }
      docScoreSummary[chunk.document_id].chunks++;
      docScoreSummary[chunk.document_id].topHybrid = Math.max(docScoreSummary[chunk.document_id].topHybrid, chunk.hybrid_score);
      docScoreSummary[chunk.document_id].topSemantic = Math.max(docScoreSummary[chunk.document_id].topSemantic, chunk.semantic_score);
      docScoreSummary[chunk.document_id].topKeyword = Math.max(docScoreSummary[chunk.document_id].topKeyword, chunk.keyword_score);
    }
    
    console.log(`[KB Retrieval] Query: "${question.substring(0, 80)}..."`);
    console.log(`[KB Retrieval] Mode: ${queryEmbedding ? 'HYBRID (semantic+keyword)' : 'KEYWORD-ONLY (no embedding)'}`);
    console.log(`[KB Retrieval] Total candidates: ${allResults.length} → selected ${diverseChunks.length} diverse chunks`);
    console.log(`[KB Retrieval] Document distribution:`);
    for (const [, info] of Object.entries(docScoreSummary)) {
      console.log(`  - ${info.name}: ${info.chunks} chunks, hybrid=${info.topHybrid.toFixed(3)}, semantic=${info.topSemantic.toFixed(3)}, keyword=${info.topKeyword.toFixed(3)}`);
    }
    // === END RETRIEVAL LOGGING ===

    if (diverseChunks.length === 0) {
      console.log("[KB Retrieval] No matching chunks found for question:", question);
      return {
        context: "",
        retrievalMode: queryEmbedding ? "hybrid" : "keyword_only",
        chunkCount: 0,
        sourceCount: 0,
        topSources: [],
      };
    }

    let knowledgeContext = "\n\n=== KNOWLEDGE BASE REFERENCE MATERIAL ===\n";
    knowledgeContext += "Use this information ONLY if it is directly relevant to the user's question. Do NOT cite or reference training materials for simple operational requests (creating tasks, updating statuses, bulk operations, etc.). Only reference this content when the user is asking analytical, strategic, or policy-related questions.\n\n";
    
    diverseChunks.forEach((chunk: any, i: number) => {
      const source = chunk.doc_file_name || "Unknown source";
      const docCategory = chunk.doc_category || "General";
      knowledgeContext += `--- Source ${i + 1}: ${source} (${docCategory}, hybrid=${chunk.hybrid_score.toFixed(3)}) ---\n${chunk.content}\n\n`;
    });
    
    knowledgeContext += "=== END KNOWLEDGE BASE CONTENT ===\n";

    const topSources = Array.from(
      new Set(
        diverseChunks
          .map((chunk: any) => String(chunk.doc_file_name || "").trim())
          .filter((name: string) => name.length > 0)
      )
    ).slice(0, 5);

    return {
      context: knowledgeContext,
      retrievalMode: queryEmbedding ? "hybrid" : "keyword_only",
      chunkCount: diverseChunks.length,
      sourceCount: topSources.length,
      topSources,
    };
  } catch (error) {
    console.error("Error searching knowledge base:", error);
    return {
      context: "",
      retrievalMode: "none",
      chunkCount: 0,
      sourceCount: 0,
      topSources: [],
    };
  }
}

function decideEvidencePlan(params: {
  question: string;
  sourceMode: "internal_only" | "hybrid";
  isOperationalRequest: boolean;
  reportType?: string;
  kbSourceCount: number;
  claimLossType?: string | null;
}): EvidencePlanDecision {
  const rawQuestion = params.question || "";
  const lossType = params.claimLossType || "property damage";
  const defaultQuery = `${lossType} insurance claim ${rawQuestion}`.trim();

  // Internal-only mode: no web search
  if (params.sourceMode === "internal_only") {
    return {
      strategy: "internal_only",
      reason: "Internal-only mode is enabled, so external web search is disabled.",
      shouldSearchWeb: false,
      searchQuery: null,
    };
  }

  // For ALL other modes: always search both internal and external in parallel
  const explicitlyRequestsWeb = /\b(web|internet|online|google|external source|search the web)\b/i.test(rawQuestion);
  const asksCurrentInfo = /\b(latest|current|recent|today|new law|updated|as of|202[4-9])\b/i.test(rawQuestion);
  const legalOrCodeHeavy = /\b(regulation|statute|law|legal|code|building code|irc|ibc|astm|manufacturer|department of insurance|doi)\b/i.test(rawQuestion);

  let strategy: string = "hybrid_always";
  let reason = "Dual retrieval: internal claim intelligence + external authoritative sources searched in parallel.";

  if (explicitlyRequestsWeb || asksCurrentInfo) {
    strategy = "web_priority";
    reason = explicitlyRequestsWeb
      ? "User explicitly requested web/external sources. Both internal and external searched."
      : "Question asks for current/recent information. Both internal and external searched.";
  } else if (legalOrCodeHeavy) {
    strategy = "hybrid_balanced";
    reason = "Legal/code question detected. Both internal KB and external authoritative sources searched.";
  } else if (params.isOperationalRequest) {
    strategy = "hybrid_always";
    reason = "Operational request with parallel external search for corroborating authority.";
  } else if (params.reportType) {
    strategy = "hybrid_always";
    reason = "Report generation with parallel external search for supporting standards and regulations.";
  }

  return {
    strategy,
    reason,
    shouldSearchWeb: true,
    searchQuery: defaultQuery,
  };
}

// Report generation prompts
const reportPrompts: Record<string, string> = {
  weather: `Generate a comprehensive Weather Report for this insurance claim. Include:
1. Historical weather conditions on the date of loss
2. Any severe weather events (storms, hail, wind, flooding)
3. Official weather records and measurements
4. Comparison to typical weather patterns for the area
5. How the weather conditions relate to the reported damage
6. Citations or sources for the weather data

Format this as a professional report that can be included in claim documentation.`,

  damage: `Generate a detailed Damage Explanation Report for this insurance claim. Include:
1. Summary of all reported damages
2. Explanation of how each type of damage likely occurred based on the loss type
3. Connection between the cause of loss and the resulting damage
4. Industry standards for this type of damage assessment
5. Potential hidden or secondary damages to look for
6. Recommendations for proper documentation of damages

Format this as a professional report suitable for presenting to the insurance carrier.`,

  estimate: `Generate an Estimate Discussion Report for this insurance claim. Include:
1. Overview of the claim valuation approach
2. Explanation of replacement cost value vs actual cash value
3. Discussion of depreciation factors
4. Line items that may need additional justification
5. Common carrier objections and how to address them
6. Recommendations for maximizing the settlement
7. Items that may be supplementable

Format this as a professional analysis that helps understand and negotiate the estimate.`,

  photos: `Generate a Photo Documentation Report for this insurance claim. Include:
1. Recommended photos to capture for this type of loss
2. Photo checklist organized by area/damage type
3. Tips for capturing effective claim photos
4. Metadata and documentation requirements
5. Best practices for photo organization
6. How to document before/after conditions

Format this as a professional guide for photo documentation.`,
};

// Helper function to create a Word document (simplified DOCX format)
function createWordDocument(title: string, content: string, claim: any): Uint8Array {
  const claimInfo = claim ? `
Claim Number: ${claim.claim_number || 'N/A'}
Policyholder: ${claim.policyholder_name || 'N/A'}
Property Address: ${claim.policyholder_address || 'N/A'}
Loss Date: ${claim.loss_date || 'N/A'}
Loss Type: ${claim.loss_type || 'N/A'}
` : '';

  // Convert markdown to simple text for Word
  const plainContent = content
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/`/g, '');

  // Create document.xml content
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Title"/></w:pPr>
      <w:r><w:t>${escapeXml(title)}</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Generated: ${new Date().toLocaleDateString()}</w:t></w:r>
    </w:p>
    <w:p><w:r><w:t></w:t></w:r></w:p>
    ${claimInfo ? `<w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Claim Information</w:t></w:r>
    </w:p>
    ${claimInfo.split('\n').filter(l => l.trim()).map(line => `<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>`).join('\n')}
    <w:p><w:r><w:t></w:t></w:r></w:p>` : ''}
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Report</w:t></w:r>
    </w:p>
    ${plainContent.split('\n').map(line => `<w:p><w:r><w:t>${escapeXml(line)}</w:t></w:r></w:p>`).join('\n')}
  </w:body>
</w:document>`;

  // Create content types
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  // Create relationships
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  // Build a minimal ZIP file manually (simplified approach)
  const encoder = new TextEncoder();
  const files: { name: string; content: Uint8Array }[] = [
    { name: '[Content_Types].xml', content: encoder.encode(contentTypesXml) },
    { name: '_rels/.rels', content: encoder.encode(relsXml) },
    { name: 'word/document.xml', content: encoder.encode(documentXml) },
  ];

  return createZip(files);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Simple ZIP file creator
function createZip(files: { name: string; content: Uint8Array }[]): Uint8Array {
  const chunks: number[] = [];
  const centralDirectory: number[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    
    // Local file header
    const localHeader = [
      0x50, 0x4b, 0x03, 0x04, // signature
      0x14, 0x00, // version needed
      0x00, 0x00, // flags
      0x00, 0x00, // compression (store)
      0x00, 0x00, // mod time
      0x00, 0x00, // mod date
      0x00, 0x00, 0x00, 0x00, // crc32 (will be calculated)
      ...numberToBytes(file.content.length, 4), // compressed size
      ...numberToBytes(file.content.length, 4), // uncompressed size
      ...numberToBytes(nameBytes.length, 2), // name length
      0x00, 0x00, // extra field length
    ];

    // Calculate CRC32
    const crc = crc32(file.content);
    localHeader[14] = crc & 0xff;
    localHeader[15] = (crc >> 8) & 0xff;
    localHeader[16] = (crc >> 16) & 0xff;
    localHeader[17] = (crc >> 24) & 0xff;

    chunks.push(...localHeader, ...nameBytes, ...file.content);

    // Central directory entry
    const cdEntry = [
      0x50, 0x4b, 0x01, 0x02, // signature
      0x14, 0x00, // version made by
      0x14, 0x00, // version needed
      0x00, 0x00, // flags
      0x00, 0x00, // compression
      0x00, 0x00, // mod time
      0x00, 0x00, // mod date
      ...numberToBytes(crc, 4), // crc32
      ...numberToBytes(file.content.length, 4), // compressed size
      ...numberToBytes(file.content.length, 4), // uncompressed size
      ...numberToBytes(nameBytes.length, 2), // name length
      0x00, 0x00, // extra field length
      0x00, 0x00, // comment length
      0x00, 0x00, // disk start
      0x00, 0x00, // internal attrs
      0x00, 0x00, 0x00, 0x00, // external attrs
      ...numberToBytes(offset, 4), // local header offset
      ...nameBytes,
    ];

    centralDirectory.push(...cdEntry);
    offset += localHeader.length + nameBytes.length + file.content.length;
  }

  const cdOffset = offset;
  const cdSize = centralDirectory.length;

  // End of central directory
  const eocd = [
    0x50, 0x4b, 0x05, 0x06, // signature
    0x00, 0x00, // disk number
    0x00, 0x00, // disk with cd
    ...numberToBytes(files.length, 2), // entries on disk
    ...numberToBytes(files.length, 2), // total entries
    ...numberToBytes(cdSize, 4), // cd size
    ...numberToBytes(cdOffset, 4), // cd offset
    0x00, 0x00, // comment length
  ];

  return new Uint8Array([...chunks, ...centralDirectory, ...eocd]);
}

function numberToBytes(n: number, bytes: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < bytes; i++) {
    result.push((n >> (8 * i)) & 0xff);
  }
  return result;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  const table = getCrc32Table();
  for (const byte of data) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function getCrc32Table(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table.push(c >>> 0);
  }
  return table;
}

// Helper function to find claim by client/policyholder name or claim number
async function findClaimByClientName(supabase: any, searchTerm: string): Promise<{ id: string; claim_number: string; policyholder_name: string } | null> {
  try {
    console.log("Searching for claim with term:", searchTerm);
    
    // First try exact match on policyholder_name
    let { data: claims, error } = await supabase
      .from("claims")
      .select("id, claim_number, policyholder_name")
      .ilike("policyholder_name", `%${searchTerm}%`)
      .eq("is_closed", false)
      .limit(1);

    if (!error && claims && claims.length > 0) {
      console.log("Found claim by policyholder name:", claims[0]);
      return claims[0];
    }

    // If not found, try searching by claim number
    const { data: claimsByNumber, error: numError } = await supabase
      .from("claims")
      .select("id, claim_number, policyholder_name")
      .ilike("claim_number", `%${searchTerm}%`)
      .eq("is_closed", false)
      .limit(1);

    if (!numError && claimsByNumber && claimsByNumber.length > 0) {
      console.log("Found claim by claim number:", claimsByNumber[0]);
      return claimsByNumber[0];
    }

    // Try a more flexible search - split search term and try first/last name
    const nameParts = searchTerm.trim().split(/\s+/);
    if (nameParts.length > 0) {
      for (const part of nameParts) {
        if (part.length < 2) continue;
        const { data: partialMatch, error: partialError } = await supabase
          .from("claims")
          .select("id, claim_number, policyholder_name")
          .ilike("policyholder_name", `%${part}%`)
          .eq("is_closed", false)
          .limit(1);

        if (!partialError && partialMatch && partialMatch.length > 0) {
          console.log("Found claim by partial name match:", partialMatch[0]);
          return partialMatch[0];
        }
      }
    }

    console.log("No claim found for search term:", searchTerm);
    return null;
  } catch (err) {
    console.error("Error finding claim by client name:", err);
    return null;
  }
}

// Tool definitions for AI assistant
const tools = [
  {
    type: "function",
    function: {
      name: "create_task",
      description: "Create a new task for a claim. When the user mentions a client/policyholder name (like 'James Hanlon' or 'Smith'), use the client_name parameter - DO NOT put names in claim_id.",
      parameters: {
        type: "object",
        properties: {
          client_name: {
            type: "string",
            description: "REQUIRED when user refers to a claim by person's name. Put the client/policyholder name here (e.g., 'James Hanlon', 'Smith'). The system will look up the claim."
          },
          claim_id: {
            type: "string",
            description: "Only use this if you have an actual UUID from the context. Never put names or placeholders here."
          },
          title: {
            type: "string",
            description: "The title/name of the task"
          },
          description: {
            type: "string",
            description: "Optional detailed description of the task"
          },
          due_date: {
            type: "string",
            description: "Due date in YYYY-MM-DD format"
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Priority level of the task"
          },
          assigned_to: {
            type: "string",
            description: "UUID of the staff member to assign the task to"
          }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "find_leads",
      description: "Search for potential insurance claim leads in a specific location by finding recent storm activity, property damage events, and public property records. Use this when the user asks about finding leads, prospecting, or identifying potential clients in a specific city, county, or state.",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "The city, county, and/or state to search for leads (e.g., 'Dallas, Texas', 'Atlantic County, New Jersey', 'Philadelphia, PA')"
          },
          damage_type: {
            type: "string",
            description: "Optional: specific type of damage to focus on (e.g., 'hail', 'wind', 'hurricane', 'tornado', 'roof')"
          }
        },
        required: ["location"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bulk_update_status",
      description: "Update the status of multiple claims at once. Can filter by current status (e.g., 'change all claims with status X to status Y') or specify claims by name/ID.",
      parameters: {
        type: "object",
        properties: {
          claim_ids: {
            type: "array",
            items: { type: "string" },
            description: "Array of claim IDs (UUIDs) to update"
          },
          client_names: {
            type: "array",
            items: { type: "string" },
            description: "Array of client/policyholder names to look up claims"
          },
          filter_by_status: {
            type: "string",
            description: "Filter claims by their current status (e.g., 'Claim Settled', 'Open', 'In Review'). All claims with this status will be updated."
          },
          new_status: {
            type: "string",
            description: "The new status to set for all selected claims"
          }
        },
        required: ["new_status"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bulk_close_claims",
      description: "Close multiple claims at once. Can filter by current status (e.g., 'close all claims with status Claim Settled') or specify claims by name/ID.",
      parameters: {
        type: "object",
        properties: {
          claim_ids: {
            type: "array",
            items: { type: "string" },
            description: "Array of claim IDs (UUIDs) to close"
          },
          client_names: {
            type: "array",
            items: { type: "string" },
            description: "Array of client/policyholder names to look up claims"
          },
          filter_by_status: {
            type: "string",
            description: "Filter claims by their current status. All claims with this status will be closed."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bulk_reopen_claims",
      description: "Reopen multiple closed claims at once. Can filter by current status or specify claims by name/ID.",
      parameters: {
        type: "object",
        properties: {
          claim_ids: {
            type: "array",
            items: { type: "string" },
            description: "Array of claim IDs (UUIDs) to reopen"
          },
          client_names: {
            type: "array",
            items: { type: "string" },
            description: "Array of client/policyholder names to look up claims"
          },
          filter_by_status: {
            type: "string",
            description: "Filter claims by their current status. All claims with this status will be reopened."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bulk_assign_staff",
      description: "Assign a staff member to multiple claims at once. Can filter by current status or specify claims by name/ID.",
      parameters: {
        type: "object",
        properties: {
          claim_ids: {
            type: "array",
            items: { type: "string" },
            description: "Array of claim IDs (UUIDs)"
          },
          client_names: {
            type: "array",
            items: { type: "string" },
            description: "Array of client/policyholder names to look up claims"
          },
          filter_by_status: {
            type: "string",
            description: "Filter claims by their current status. All claims with this status will be assigned."
          },
          staff_id: {
            type: "string",
            description: "UUID of the staff member to assign"
          },
          staff_name: {
            type: "string",
            description: "Name of the staff member to assign (will look up ID)"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bulk_share_to_workspace",
      description: "Share multiple claims to a workspace for collaboration with partner organizations. Can filter by contractor name, status, or specify claims directly.",
      parameters: {
        type: "object",
        properties: {
          claim_ids: {
            type: "array",
            items: { type: "string" },
            description: "Array of claim IDs (UUIDs) to share"
          },
          client_names: {
            type: "array",
            items: { type: "string" },
            description: "Array of client/policyholder names to look up claims"
          },
          filter_by_contractor: {
            type: "string",
            description: "Filter claims by assigned contractor name (e.g., 'Condition One')"
          },
          filter_by_status: {
            type: "string",
            description: "Filter claims by their current status"
          },
          workspace_name: {
            type: "string",
            description: "Name of the workspace to share claims to"
          },
          workspace_id: {
            type: "string",
            description: "UUID of the workspace to share claims to"
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_claim_note",
      description: "Add a note to a specific claim's Notes & Activity section. Use this when the user says 'add a note to the [name] claim', 'note on the claim', 'make a note', etc. This is the PRIMARY tool for adding notes to claims. Do NOT use add_notepad_item for this.",
      parameters: {
        type: "object",
        properties: {
          client_name: {
            type: "string",
            description: "The client/policyholder last name or full name to find the claim (e.g., 'Shelly', 'Vincent Shelly')"
          },
          claim_id: {
            type: "string",
            description: "Only use this if you have an actual UUID. Otherwise use client_name."
          },
          note: {
            type: "string",
            description: "The note content to add to the claim's Notes & Activity section"
          }
        },
        required: ["note"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "add_notepad_item",
      description: "Add an item to the user's personal DASHBOARD notepad/quick notes ONLY. Use this ONLY when the user explicitly says 'add to my notepad', 'add to my quick notes', or 'jot down for me'. Do NOT use this when the user says 'add a note to the claim' — that should go to claim_updates via other tools.",
      parameters: {
        type: "object",
        properties: {
          item: {
            type: "string",
            description: "The note/item to add to the notepad"
          }
        },
        required: ["item"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_full_claim_context",
      description: "ALWAYS call this function FIRST when the user asks about a specific claim by name, claim number, or reference. This retrieves the complete claim context including loss type, settlement data, emails, inspections, tasks, files, adjuster info, and Darwin notes. Use the returned context to give accurate, detailed responses about the claim.",
      parameters: {
        type: "object",
        properties: {
          client_name: {
            type: "string",
            description: "The client/policyholder name or claim number to look up"
          }
        },
        required: ["client_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for information about insurance companies, building codes, manufacturer specifications, regulations, or any other publicly available information. Use this when the user asks you to find, look up, or research information from the internet.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to look up on the web"
          },
          context: {
            type: "string",
            description: "Additional context about what the user is looking for"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_insurance_company",
      description: "Update an insurance company's contact information in the database. Use this after performing a web search to get updated contact info for an insurance company.",
      parameters: {
        type: "object",
        properties: {
          company_name: {
            type: "string",
            description: "The name of the insurance company to update"
          },
          phone: {
            type: "string",
            description: "The new phone number"
          },
          email: {
            type: "string",
            description: "The new email address"
          },
          claims_phone: {
            type: "string",
            description: "Claims department phone number"
          },
          claims_email: {
            type: "string",
            description: "Claims department email"
          }
        },
        required: ["company_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "lookup_building_code",
      description: "Search for building codes, manufacturer specifications, installation requirements, or industry standards. Use this when the user asks about code requirements, proper installation methods, or manufacturer guidelines.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The building code, product, or specification to look up (e.g., 'IRC roofing requirements', 'GAF shingle installation specs', 'Florida Building Code wind resistance')"
          },
          state: {
            type: "string",
            description: "Optional state for state-specific codes"
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bulk_update_insurance_companies",
      description: "Search the web and update contact information (phone numbers, email addresses) for ALL insurance companies in the Networking tab. Use this when the user asks to update contact info for all or multiple insurance companies.",
      parameters: {
        type: "object",
        properties: {
          company_names: {
            type: "array",
            items: { type: "string" },
            description: "Optional: specific company names to update. If empty, updates ALL companies."
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_my_activity",
      description: "Search for claims that the current user updated, created, or modified within a specific time period. Use this when the user asks 'what claims did I update today/yesterday/this week' or 'what have I worked on recently' or 'show me my activity'.",
      parameters: {
        type: "object",
        properties: {
          time_period: {
            type: "string",
            enum: ["today", "yesterday", "this_week", "last_week", "this_month", "last_30_days"],
            description: "The time period to search for activity"
          },
          action_type: {
            type: "string",
            enum: ["all", "create", "update", "status_change", "email_sent", "sms_sent", "file_upload", "payment_recorded"],
            description: "Optional filter for specific action types. Default is 'all'."
          }
        },
        required: ["time_period"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_communications",
      description: "Search all communications (emails, SMS, notes, communications diary) across all claims for specific topics, people, or keywords. Use this when the user asks about previous discussions with an adjuster, what was said about a specific topic, or to find communications mentioning something specific.",
      parameters: {
        type: "object",
        properties: {
          search_query: {
            type: "string",
            description: "Keywords or topic to search for in communications (e.g., 'depreciation', 'denial', 'settlement offer', adjuster name)"
          },
          communication_type: {
            type: "string",
            enum: ["all", "emails", "sms", "notes", "communications_diary"],
            description: "Type of communications to search. Default is 'all'."
          },
          time_period: {
            type: "string",
            enum: ["all_time", "today", "this_week", "this_month", "last_30_days", "last_90_days"],
            description: "Time period to limit the search. Default is 'all_time'."
          },
          claim_name: {
            type: "string",
            description: "Optional: Filter to a specific claim by policyholder name or claim number"
          }
        },
        required: ["search_query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_claim_history",
      description: "Search the complete history and timeline of activities across all claims. Use this for questions like 'when did we last contact the adjuster on Smith claim', 'what happened last week on my claims', 'show me all status changes this month'.",
      parameters: {
        type: "object",
        properties: {
          search_query: {
            type: "string",
            description: "Keywords to search for in claim history and activity"
          },
          event_type: {
            type: "string",
            enum: ["all", "status_changes", "notes_added", "files_uploaded", "emails", "tasks_created", "inspections", "payments"],
            description: "Type of events to search. Default is 'all'."
          },
          time_period: {
            type: "string",
            enum: ["all_time", "today", "yesterday", "this_week", "last_week", "this_month", "last_30_days"],
            description: "Time period to search"
          },
          claim_name: {
            type: "string",
            description: "Optional: Filter to a specific claim by policyholder name or claim number"
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_adjuster_interactions",
      description: "Get all interactions and communications with a specific adjuster across all claims. Use this when the user asks about previous dealings with an adjuster, what was discussed, or to find all claims involving a specific adjuster.",
      parameters: {
        type: "object",
        properties: {
          adjuster_name: {
            type: "string",
            description: "Name of the adjuster to search for"
          },
          include_emails: {
            type: "boolean",
            description: "Include email communications. Default is true."
          },
          include_notes: {
            type: "boolean",
            description: "Include notes mentioning the adjuster. Default is true."
          },
          include_diary: {
            type: "boolean",
            description: "Include communications diary entries. Default is true."
          }
        },
        required: ["adjuster_name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_tasks",
      description: "Search for tasks across all claims by keywords in the title or description. Use fuzzy matching to find tasks even when the exact wording differs. For example, searching for 'photos needed' will also find 'upload photos', 'get completion photos', 'COC', 'certificate of completion', etc. Use this when the user asks about finding tasks with certain keywords, or wants to know which claims have specific types of tasks.",
      parameters: {
        type: "object",
        properties: {
          keywords: {
            type: "array",
            items: { type: "string" },
            description: "Array of keywords or phrases to search for in task titles and descriptions. The search uses fuzzy matching - similar words and abbreviations will be matched (e.g., 'COC' matches 'certificate of completion', 'photos' matches 'pictures', 'photo of completion')."
          },
          status: {
            type: "string",
            enum: ["pending", "completed", "all"],
            description: "Filter by task status. Default is 'pending' to find incomplete tasks."
          },
          include_closed_claims: {
            type: "boolean",
            description: "Whether to include tasks from closed claims. Default is false."
          }
        },
        required: ["keywords"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "update_task",
      description: "Update an existing task's details like title, description, due date, priority, or assigned staff. Use this when the user asks to change, edit, or modify a task.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The UUID of the task to update"
          },
          task_title_search: {
            type: "string",
            description: "Search for the task by title keywords if task_id is not known"
          },
          title: {
            type: "string",
            description: "New title for the task"
          },
          description: {
            type: "string",
            description: "New description for the task"
          },
          due_date: {
            type: "string",
            description: "New due date in YYYY-MM-DD format"
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "New priority level"
          },
          assigned_to: {
            type: "string",
            description: "UUID of the staff member to assign the task to"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "complete_task",
      description: "Mark a task as completed. Use this when the user says a task is done, finished, or completed.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The UUID of the task to complete"
          },
          task_title_search: {
            type: "string",
            description: "Search for the task by title keywords if task_id is not known"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "reopen_task",
      description: "Reopen a completed task back to pending. Use this when the user wants to undo a task completion or reopen a task.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The UUID of the task to reopen"
          },
          task_title_search: {
            type: "string",
            description: "Search for the task by title keywords if task_id is not known"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_task",
      description: "Delete a task permanently. Use this when the user asks to remove or delete a task.",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The UUID of the task to delete"
          },
          task_title_search: {
            type: "string",
            description: "Search for the task by title keywords if task_id is not known"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_claim_tasks",
      description: "List all tasks for the current claim or a specific claim. Use this when the user asks to see tasks, show tasks, or wants a task overview.",
      parameters: {
        type: "object",
        properties: {
          status_filter: {
            type: "string",
            enum: ["pending", "completed", "all"],
            description: "Filter by task status. Default is 'all'."
          },
          client_name: {
            type: "string",
            description: "Client/policyholder name to look up a different claim's tasks"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email immediately from chat. Use this when the user explicitly asks to send an email now. For carrier emails (recipient_type=insurance_company), auto-send to both insurance company and assigned adjuster when available, with fallback to whichever exists. Outbound subject is claim number only.",
      parameters: {
        type: "object",
        properties: {
          claim_id: {
            type: "string",
            description: "Claim UUID. Omit to use current claim context."
          },
          client_name: {
            type: "string",
            description: "Client/policyholder name to resolve a claim if claim_id is not provided."
          },
          subject: {
            type: "string",
            description: "Draft subject/context. Outbound email subject is normalized to the claim number only."
          },
          body: {
            type: "string",
            description: "Professional, ready-to-send email body. Include greeting, claim context, clear ask, and courteous closing."
          },
          recipients: {
            type: "array",
            description: "Optional recipient list. If omitted, defaults to policyholder in claim context.",
            items: {
              type: "object",
              properties: {
                recipient_type: {
                  type: "string",
                  enum: ["policyholder", "adjuster", "insurance_company", "referrer", "contractor", "manual"],
                  description: "Recipient source type."
                },
                recipient_name: {
                  type: "string",
                  description: "Optional recipient name filter (useful for selecting a specific adjuster/contractor)."
                },
                recipient_email: {
                  type: "string",
                  description: "Direct email address (required when recipient_type is manual)."
                }
              }
            }
          },
          recipient_type: {
            type: "string",
            enum: ["policyholder", "adjuster", "insurance_company", "referrer", "contractor", "manual"],
            description: "Single-recipient shortcut instead of recipients[]. For insurance_company, system auto-targets company + assigned adjuster when available."
          },
          recipient_name: {
            type: "string",
            description: "Single-recipient name filter/label."
          },
          recipient_email: {
            type: "string",
            description: "Single-recipient direct email address."
          },
          cc_claim_mailbox: {
            type: "boolean",
            description: "Whether to CC the claim mailbox address. Default true."
          }
        },
        required: ["subject", "body"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "draft_email",
      description: "Draft a professional email without sending it. Use this when the user asks to draft, prepare, or review an email before approval. The UI can then let the user edit and approve send.",
      parameters: {
        type: "object",
        properties: {
          claim_id: {
            type: "string",
            description: "Claim UUID. Omit to use current claim context."
          },
          client_name: {
            type: "string",
            description: "Client/policyholder name to resolve a claim if claim_id is not provided."
          },
          subject: {
            type: "string",
            description: "Draft subject/context. Outbound subject is normalized to the claim number only."
          },
          body: {
            type: "string",
            description: "Professional, ready-to-send email body. Include greeting, claim context, clear ask, and courteous closing."
          },
          recipients: {
            type: "array",
            description: "Optional recipient list. If omitted, defaults to policyholder in claim context.",
            items: {
              type: "object",
              properties: {
                recipient_type: {
                  type: "string",
                  enum: ["policyholder", "adjuster", "insurance_company", "referrer", "contractor", "manual"],
                  description: "Recipient source type."
                },
                recipient_name: {
                  type: "string",
                  description: "Optional recipient name filter (useful for selecting a specific adjuster/contractor)."
                },
                recipient_email: {
                  type: "string",
                  description: "Direct email address (required when recipient_type is manual)."
                }
              }
            }
          },
          recipient_type: {
            type: "string",
            enum: ["policyholder", "adjuster", "insurance_company", "referrer", "contractor", "manual"],
            description: "Single-recipient shortcut instead of recipients[]. For insurance_company, system auto-targets company + assigned adjuster when available."
          },
          recipient_name: {
            type: "string",
            description: "Single-recipient name filter/label."
          },
          recipient_email: {
            type: "string",
            description: "Single-recipient direct email address."
          },
          cc_claim_mailbox: {
            type: "boolean",
            description: "Whether to CC the claim mailbox address when the draft is approved and sent. Default true."
          }
        },
        required: ["body"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "draft_sms",
      description: "Draft an SMS/text message without sending it. Use this when the user asks to draft, prepare, or review a text before approval.",
      parameters: {
        type: "object",
        properties: {
          claim_id: {
            type: "string",
            description: "Claim UUID. Omit to use current claim context."
          },
          client_name: {
            type: "string",
            description: "Client/policyholder name to resolve a claim if claim_id is not provided."
          },
          message_body: {
            type: "string",
            description: "SMS draft content."
          },
          recipients: {
            type: "array",
            description: "Optional recipient list. If omitted, defaults to policyholder in claim context.",
            items: {
              type: "object",
              properties: {
                recipient_type: {
                  type: "string",
                  enum: ["policyholder", "adjuster", "insurance_company", "referrer", "contractor", "manual"],
                  description: "Recipient source type."
                },
                recipient_name: {
                  type: "string",
                  description: "Optional recipient name filter/label."
                },
                recipient_phone: {
                  type: "string",
                  description: "Direct phone number (required when recipient_type is manual)."
                }
              }
            }
          },
          recipient_type: {
            type: "string",
            enum: ["policyholder", "adjuster", "insurance_company", "referrer", "contractor", "manual"],
            description: "Single-recipient shortcut instead of recipients[]."
          },
          recipient_name: {
            type: "string",
            description: "Single-recipient name filter/label."
          },
          recipient_phone: {
            type: "string",
            description: "Single-recipient direct phone number."
          },
          to_number: {
            type: "string",
            description: "Legacy alias for recipient_phone."
          }
        },
        required: ["message_body"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_sms",
      description: "Send an SMS/text message immediately from chat. Use this when the user explicitly asks to text/send SMS now. If recipient is not provided, default to the policyholder for the active claim.",
      parameters: {
        type: "object",
        properties: {
          claim_id: {
            type: "string",
            description: "Claim UUID. Omit to use current claim context."
          },
          client_name: {
            type: "string",
            description: "Client/policyholder name to resolve a claim if claim_id is not provided."
          },
          message_body: {
            type: "string",
            description: "SMS message content to send."
          },
          recipients: {
            type: "array",
            description: "Optional recipient list. If omitted, defaults to policyholder in claim context.",
            items: {
              type: "object",
              properties: {
                recipient_type: {
                  type: "string",
                  enum: ["policyholder", "adjuster", "insurance_company", "referrer", "contractor", "manual"],
                  description: "Recipient source type."
                },
                recipient_name: {
                  type: "string",
                  description: "Optional recipient name filter (useful for selecting a specific adjuster/contractor)."
                },
                recipient_phone: {
                  type: "string",
                  description: "Direct phone number (required when recipient_type is manual)."
                }
              }
            }
          },
          recipient_type: {
            type: "string",
            enum: ["policyholder", "adjuster", "insurance_company", "referrer", "contractor", "manual"],
            description: "Single-recipient shortcut instead of recipients[]"
          },
          recipient_name: {
            type: "string",
            description: "Single-recipient name filter/label."
          },
          recipient_phone: {
            type: "string",
            description: "Single-recipient direct phone number."
          },
          to_number: {
            type: "string",
            description: "Legacy alias for recipient_phone."
          }
        },
        required: ["message_body"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "send_portal_notification",
      description: "Send a portal notification message on a claim to client and/or contractors. Use this when the user asks to notify portal users, send a portal message, or post an update to claim portal recipients.",
      parameters: {
        type: "object",
        properties: {
          claim_id: {
            type: "string",
            description: "Claim UUID. Omit to use current claim context."
          },
          client_name: {
            type: "string",
            description: "Client/policyholder name to resolve a claim if claim_id is not provided."
          },
          message: {
            type: "string",
            description: "Portal notification message body."
          },
          notify_client: {
            type: "boolean",
            description: "Send to the client/policyholder portal user. Default true."
          },
          notify_contractors: {
            type: "boolean",
            description: "Send to all assigned contractor portal users. Default false."
          },
          recipient_user_ids: {
            type: "array",
            items: { type: "string" },
            description: "Optional explicit portal recipient user IDs to include."
          },
          send_email_copy: {
            type: "boolean",
            description: "Also trigger client email notification via notify-client-claim-update when client is included. Default true."
          }
        },
        required: ["message"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_claim_letter",
      description: "Create a claim letter and optionally send it by email immediately. Use this when the user asks to draft/create/write a letter and wants it saved or sent.",
      parameters: {
        type: "object",
        properties: {
          claim_id: {
            type: "string",
            description: "Claim UUID. Omit to use current claim context."
          },
          client_name: {
            type: "string",
            description: "Client/policyholder name to resolve a claim if claim_id is not provided."
          },
          subject: {
            type: "string",
            description: "Letter subject/title for the saved letter artifact."
          },
          body: {
            type: "string",
            description: "Letter body content."
          },
          recipient_type: {
            type: "string",
            enum: ["policyholder", "adjuster", "insurance_company", "referrer", "contractor", "manual"],
            description: "Intended recipient type for letter metadata and optional email delivery."
          },
          recipient_name: {
            type: "string",
            description: "Recipient name filter/label."
          },
          recipient_email: {
            type: "string",
            description: "Direct recipient email address for manual recipient or override."
          },
          save_to_claim_files: {
            type: "boolean",
            description: "Save the generated letter to claim files. Default true."
          },
          send_email: {
            type: "boolean",
            description: "Send the letter immediately by email. Default false."
          },
          record_communication: {
            type: "boolean",
            description: "Log the outbound letter in communications diary. Default true."
          }
        },
        required: ["subject", "body"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "schedule_claim_call",
      description: "Schedule and log a follow-up call for a claim, and optionally create a task. Use this when the user asks to schedule a call/callback/follow-up call.",
      parameters: {
        type: "object",
        properties: {
          claim_id: {
            type: "string",
            description: "Claim UUID. Omit to use current claim context."
          },
          client_name: {
            type: "string",
            description: "Client/policyholder name to resolve a claim if claim_id is not provided."
          },
          summary: {
            type: "string",
            description: "Purpose/agenda for the scheduled call."
          },
          scheduled_date: {
            type: "string",
            description: "Date for the call in YYYY-MM-DD format. Defaults to today."
          },
          scheduled_time: {
            type: "string",
            description: "Optional call time in HH:mm format."
          },
          call_with_type: {
            type: "string",
            enum: ["policyholder", "adjuster", "insurance_company", "referrer", "contractor", "manual"],
            description: "Who the call is with."
          },
          call_with_name: {
            type: "string",
            description: "Name filter/label for call contact."
          },
          call_with_phone: {
            type: "string",
            description: "Direct phone for manual contact or override."
          },
          call_with_email: {
            type: "string",
            description: "Optional contact email for metadata."
          },
          create_task: {
            type: "boolean",
            description: "Create a follow-up task for the scheduled call. Default true."
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Task priority when create_task is true."
          },
          assigned_to: {
            type: "string",
            description: "Optional assignee user UUID for the call task."
          }
        },
        required: ["summary"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "bulk_process_tasks",
      description: "Process tasks across multiple claims at once. Can add a CLAIM NOTE (to the claim's Notes & Activity section), mark tasks as completed, and/or create follow-up tasks. Use this when the user asks to update, clear, complete, or process tasks across multiple claims. IMPORTANT: When the user says 'add a note' in the context of claims/tasks, they mean a claim note in Notes & Activity — NOT the dashboard quick notepad.",
      parameters: {
        type: "object",
        properties: {
          client_names: {
            type: "array",
            items: { type: "string" },
            description: "List of client/policyholder names to find claims for"
          },
          claim_ids: {
            type: "array",
            items: { type: "string" },
            description: "List of claim UUIDs (if known)"
          },
          task_title_search: {
            type: "string",
            description: "Optional keyword to filter which tasks to process (e.g. 'follow-up', 'inspection'). If not provided, processes ALL pending tasks on the matched claims."
          },
          note: {
            type: "string",
            description: "Note to add to the CLAIM's Notes & Activity section (claim_updates table). This is NOT the dashboard quick notepad."
          },
          complete_tasks: {
            type: "boolean",
            description: "Whether to mark the matched tasks as completed. Default true."
          },
          create_follow_up: {
            type: "boolean",
            description: "Whether to create a new follow-up task on each claim after processing"
          },
          follow_up_title: {
            type: "string",
            description: "Title for the follow-up task"
          },
          follow_up_due_date: {
            type: "string",
            description: "Due date for follow-up task in YYYY-MM-DD format"
          },
          follow_up_priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Priority for follow-up task"
          },
          follow_up_description: {
            type: "string",
            description: "Description for the follow-up task"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_darwin_analysis",
      description: "Run a Darwin analysis or content generation on the current claim. Use when the user asks to 'run an analysis', 'analyze this claim', 'write a case study', 'create an operating manual', or 'generate marketing assets'. Requires claim context (claim_id or use from within a claim).",
      parameters: {
        type: "object",
        properties: {
          analysis_type: {
            type: "string",
            enum: ["claim_analysis", "case_study", "operating_manual", "marketing_assets"],
            description: "claim_analysis = full claim analysis; case_study = redacted case study; operating_manual = scenarios and training; marketing_assets = blog and social posts"
          },
          claim_id: {
            type: "string",
            description: "Claim UUID. Use when available from context; otherwise omit and the system uses the current claim."
          },
          client_name: {
            type: "string",
            description: "Client/policyholder name to look up claim if claim_id not provided"
          }
        },
        required: ["analysis_type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_claim_financial_summary",
      description: "Get paid vs outstanding, depreciation, deductible, and coverage breakdown for a claim. Use when the user asks 'what has been paid', 'what is outstanding', 'depreciation', 'what is tied up in depreciation', 'contents vs ALE vs dwelling', 'how much paid per line item', or any financial/payment question about the claim.",
      parameters: {
        type: "object",
        properties: {
          claim_id: {
            type: "string",
            description: "Claim UUID. Omit to use current claim context."
          },
          client_name: {
            type: "string",
            description: "Client/policyholder name to look up claim if claim_id not provided"
          }
        }
      }
    }
  }
];
// Helper function to get full Darwin-level claim context
async function getFullClaimContext(supabase: any, searchTerm: string): Promise<{ success: boolean; context?: string; claim?: any; error?: string }> {
  try {
    // First find the claim
    const foundClaim = await findClaimByClientName(supabase, searchTerm);
    if (!foundClaim) {
      return { success: false, error: `Could not find claim for "${searchTerm}"` };
    }

    const claimId = foundClaim.id;

    // Fetch claim with all related data
    const { data: claim, error: claimError } = await supabase
      .from("claims")
      .select("*")
      .eq("id", claimId)
      .single();

    if (claimError || !claim) {
      return { success: false, error: "Failed to fetch claim details" };
    }

    // Fetch related data in parallel
    const [
      { data: settlements },
      { data: checks },
      { data: tasks },
      { data: inspections },
      { data: emails },
      { data: files },
      { data: adjusters },
      { data: updates },
      { data: photos },
      { data: darwinNotes }
    ] = await Promise.all([
      supabase.from("claim_settlements").select("*").eq("claim_id", claimId),
      supabase.from("claim_checks").select("*").eq("claim_id", claimId),
      supabase.from("tasks").select("*").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(10),
      supabase.from("inspections").select("*").eq("claim_id", claimId),
      supabase.from("emails").select("*").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(10),
      supabase.from("claim_files").select("*").eq("claim_id", claimId),
      supabase.from("claim_adjusters").select("*").eq("claim_id", claimId),
      supabase.from("claim_updates").select("*").eq("claim_id", claimId).order("created_at", { ascending: false }).limit(10),
      supabase.from("claim_photos").select("*").eq("claim_id", claimId).limit(20),
      supabase.from("darwin_analysis_results").select("result").eq("claim_id", claimId).eq("analysis_type", "context_notes").order("created_at", { ascending: false }).limit(1)
    ]);

    // Build comprehensive context
    let context = `
=== FULL CLAIM CONTEXT (Darwin-Level Intelligence) ===

CLAIM DETAILS:
- Claim ID: ${claim.id}
- Claim Number: ${claim.claim_number || 'N/A'}
- Policy Number: ${claim.policy_number || 'N/A'}
- Policyholder: ${claim.policyholder_name || 'N/A'}
- Phone: ${claim.policyholder_phone || 'N/A'}
- Email: ${claim.policyholder_email || 'N/A'}
- Address: ${claim.policyholder_address || 'N/A'}
- Insurance Company: ${claim.insurance_company || 'N/A'}
- LOSS TYPE: ${claim.loss_type || 'Not specified'} *** PAY ATTENTION TO THIS ***
- Loss Date: ${claim.loss_date || 'N/A'}
- Loss Description: ${claim.loss_description || 'N/A'}
- Current Status: ${claim.status || 'N/A'}
- Construction Status: ${claim.construction_status || 'N/A'}
- Claim Amount: $${claim.claim_amount?.toLocaleString() || 'N/A'}
- Is Closed: ${claim.is_closed ? 'Yes' : 'No'}

ADJUSTER INFORMATION:
${adjusters && adjusters.length > 0 
  ? adjusters.map((a: any) => `- ${a.adjuster_name} (${a.company || 'N/A'}) | Phone: ${a.adjuster_phone || 'N/A'} | Email: ${a.adjuster_email || 'N/A'} ${a.is_primary ? '(PRIMARY)' : ''}`).join('\n')
  : `- Primary: ${claim.adjuster_name || 'Not assigned'} | Phone: ${claim.adjuster_phone || 'N/A'} | Email: ${claim.adjuster_email || 'N/A'}`}

SETTLEMENT DATA:
${settlements && settlements.length > 0 
  ? settlements.map((s: any) => `
  - RCV: $${s.replacement_cost_value?.toLocaleString() || 0}
  - Recoverable Depreciation: $${s.recoverable_depreciation?.toLocaleString() || 0}
  - Non-Recoverable Depreciation: $${s.non_recoverable_depreciation?.toLocaleString() || 0}
  - Deductible: $${s.deductible?.toLocaleString() || 0}
  - Total Settlement: $${s.total_settlement?.toLocaleString() || 'N/A'}
  - Notes: ${s.notes || 'None'}`).join('\n')
  : '- No settlement data recorded'}

CHECKS RECEIVED:
${checks && checks.length > 0 
  ? checks.map((c: any) => `- ${c.check_type}: $${c.amount?.toLocaleString()} | Date: ${c.check_date} | Check #: ${c.check_number || 'N/A'}`).join('\n')
  : '- No checks received yet'}

INSPECTIONS:
${inspections && inspections.length > 0 
  ? inspections.map((i: any) => `- ${i.inspection_type}: ${i.inspection_date} | Status: ${i.status} | Notes: ${i.notes || 'None'}`).join('\n')
  : '- No inspections scheduled'}

TASKS (Recent 10):
${tasks && tasks.length > 0 
  ? tasks.map((t: any) => `- [${t.status?.toUpperCase()}] ${t.title} | Due: ${t.due_date || 'No date'} | Priority: ${t.priority || 'Normal'}`).join('\n')
  : '- No tasks'}

RECENT COMMUNICATIONS (Emails):
${emails && emails.length > 0 
  ? emails.map((e: any) => `- ${e.sent_by ? 'TO' : 'FROM'}: ${e.recipient_email || e.recipient_name || 'Unknown'} | Subject: ${e.subject} | Date: ${new Date(e.created_at || e.sent_at).toLocaleDateString()}`).join('\n')
  : '- No emails on file'}

RECENT ACTIVITY:
${updates && updates.length > 0 
  ? updates.slice(0, 5).map((u: any) => `- ${new Date(u.created_at).toLocaleDateString()}: ${u.content?.substring(0, 100)}...`).join('\n')
  : '- No recent activity'}

FILES ON CLAIM:
${files && files.length > 0 
  ? files.map((f: any) => `- ${f.file_name} (${f.file_type || 'unknown'})`).join('\n')
  : '- No files uploaded'}

PHOTOS:
- ${photos?.length || 0} photos on file
${photos && photos.length > 0 
  ? photos.slice(0, 5).map((p: any) => `  - ${p.file_name}: ${p.description || p.category || 'No description'}`).join('\n')
  : ''}

${darwinNotes?.[0]?.result ? `
DARWIN CONTEXT NOTES (User-Provided Insights):
${darwinNotes[0].result}
` : ''}

=== END FULL CLAIM CONTEXT ===

IMPORTANT: The loss type is "${claim.loss_type || 'not specified'}". Make sure your response is relevant to this specific type of damage. Do not confuse hail damage with wind damage, fire damage with water damage, etc.
`;

    return { success: true, context, claim };
  } catch (err) {
    console.error("Error getting full claim context:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

async function createTask(supabase: any, params: {
  claim_id: string;
  title: string;
  description?: string;
  due_date?: string;
  priority?: string;
  assigned_to?: string;
}): Promise<{ success: boolean; task?: any; error?: string }> {
  try {
    const { data, error } = await supabase
      .from("tasks")
      .insert({
        claim_id: params.claim_id,
        title: params.title,
        description: params.description || null,
        due_date: params.due_date || null,
        priority: params.priority || "medium",
        assigned_to: params.assigned_to || null,
        status: "pending"
      })
      .select()
      .single();

    if (error) {
      console.error("Error creating task:", error);
      return { success: false, error: error.message };
    }

    return { success: true, task: data };
  } catch (err) {
    console.error("Exception creating task:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

type CommunicationRecipientType =
  | "policyholder"
  | "adjuster"
  | "insurance_company"
  | "referrer"
  | "contractor"
  | "manual";

type CommunicationRecipientInput = {
  recipient_type?: string;
  recipient_name?: string;
  recipient_email?: string;
  recipient_phone?: string;
  to_number?: string;
};

type ResolvedEmailRecipient = {
  email: string;
  name: string;
  type: string;
};

type ResolvedSmsRecipient = {
  phone: string;
  name: string;
  type: string;
};

type CommunicationDraft = {
  draftId: string;
  channel: "email" | "sms";
  claimId: string;
  claimReference: string;
  subject?: string;
  body: string;
  claimEmailCc?: string;
  photoEstimateEvidenceApplied?: boolean;
  recipients: Array<{
    name: string;
    type: string;
    email?: string;
    phone?: string;
  }>;
};

function normalizeRecipientType(raw?: string): CommunicationRecipientType | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["policyholder", "client", "insured", "homeowner"].includes(normalized)) return "policyholder";
  if (["adjuster", "carrier_adjuster", "insurance_adjuster", "primary_adjuster"].includes(normalized)) return "adjuster";
  if (["insurance_company", "insurance", "carrier"].includes(normalized)) return "insurance_company";
  if (["referrer", "referral"].includes(normalized)) return "referrer";
  if (["contractor", "roofer", "vendor"].includes(normalized)) return "contractor";
  if (["manual", "direct"].includes(normalized)) return "manual";
  return null;
}

function collectRecipientInputs(params: any, _channel: "email" | "sms"): CommunicationRecipientInput[] {
  if (Array.isArray(params?.recipients) && params.recipients.length > 0) {
    return params.recipients;
  }

  const single: CommunicationRecipientInput = {
    recipient_type: params?.recipient_type,
    recipient_name: params?.recipient_name,
    recipient_email: params?.recipient_email,
    recipient_phone: params?.recipient_phone || params?.to_number,
  };

  // Default behavior for claim-context comms: send to policyholder when recipient not specified.
  if (!single.recipient_type && !single.recipient_email && !single.recipient_phone) {
    return [{ recipient_type: "policyholder" }];
  }

  return [single];
}

function dedupeEmailRecipients(recipients: ResolvedEmailRecipient[]): ResolvedEmailRecipient[] {
  const seen = new Set<string>();
  const deduped: ResolvedEmailRecipient[] = [];
  for (const recipient of recipients) {
    const key = recipient.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(recipient);
  }
  return deduped;
}

function dedupeSmsRecipients(recipients: ResolvedSmsRecipient[]): ResolvedSmsRecipient[] {
  const seen = new Set<string>();
  const deduped: ResolvedSmsRecipient[] = [];
  for (const recipient of recipients) {
    const digits = recipient.phone.replace(/\D/g, "");
    const key = digits.length > 0 ? digits : recipient.phone.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(recipient);
  }
  return deduped;
}

function isCarrierFacingEmailRecipients(recipients: ResolvedEmailRecipient[]): boolean {
  return recipients.some((recipient) => {
    const recipientType = String(recipient.type || "").toLowerCase();
    return recipientType === "adjuster" || recipientType === "insurance_company" || recipientType.includes("carrier");
  });
}

function shouldInjectPhotoEvidenceForEmail(
  question: string,
  bodyText: string,
  carrierFacing: boolean,
): boolean {
  if (shouldUsePhotoDamageEvidenceForCommunication(question, bodyText)) return true;
  if (!carrierFacing) return false;

  const combined = `${question || ""}\n${bodyText || ""}`.toLowerCase();
  return /\b(estimate|scope|damage|damages|repair|replace|supplement|underpaid|payment|loss|property)\b/i.test(combined);
}

function buildClaimMailboxEmail(claimData: any, claimId: string): string {
  const sanitizedPolicyNumber = claimData?.policy_number
    ? String(claimData.policy_number).replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
    : "";
  const token = sanitizedPolicyNumber || claimId.slice(0, 8);
  return `claim-${token}@freedomclaims.work`;
}

function buildClaimNumberSubject(claimData: any, claimId: string): string {
  const claimNumber = String(claimData?.claim_number || "").trim();
  if (claimNumber) return claimNumber;
  return claimId;
}

function buildProfessionalEmailBody(
  rawBody: string,
  claimData: any,
  recipientName?: string,
): string {
  const trimmed = String(rawBody || "").trim();
  if (!trimmed) return "";

  const lines = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const greetingLine = lines[0] || "";
  const hasGreeting = /^(hi|hello|dear)\b/i.test(greetingLine);
  const hasClosing = /(thank you|thanks|sincerely|regards|best)/i.test(trimmed);
  const hasClaimReference = /claim\s*#?\s*[a-z0-9-]+/i.test(trimmed);
  const looksDetailed = trimmed.length >= 180 || lines.length >= 5;

  if (hasGreeting && hasClosing && (hasClaimReference || looksDetailed)) {
    return trimmed;
  }

  const claimNumber = String(claimData?.claim_number || "").trim();
  const claimReference = claimNumber ? `claim ${claimNumber}` : "this claim";
  const policyholderName = String(claimData?.policyholder_name || "the insured").trim();

  const normalizedRecipient = String(recipientName || "").trim();
  const safeRecipient =
    normalizedRecipient && !normalizedRecipient.includes("@")
      ? normalizedRecipient
      : "there";

  const normalizedRequest = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;

  return [
    `Hello ${safeRecipient},`,
    "",
    `I hope you're doing well. I'm writing regarding ${claimReference} for ${policyholderName}.`,
    "",
    normalizedRequest,
    "",
    "Please confirm receipt and provide your response at your earliest convenience.",
    "",
    "Thank you,",
  ].join("\n");
}

function buildProfessionalSmsBody(
  rawBody: string,
  claimData: any,
  recipientName?: string,
): string {
  const trimmed = String(rawBody || "").trim();
  if (!trimmed) return "";

  const hasClaimReference = /\bclaim\b/i.test(trimmed);
  const hasGreeting = /^(hi|hello|good (morning|afternoon|evening))\b/i.test(trimmed);
  if (hasGreeting && hasClaimReference && trimmed.length >= 40) {
    return trimmed;
  }

  const claimNumber = String(claimData?.claim_number || "").trim();
  const claimReference = claimNumber ? `claim ${claimNumber}` : "this claim";
  const safeRecipient = String(recipientName || "").trim() || "there";
  const normalizedRequest = /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;

  return `Hi ${safeRecipient}, regarding ${claimReference}: ${normalizedRequest}`;
}

function shouldUsePhotoDamageEvidenceForCommunication(question: string, bodyText: string): boolean {
  const combined = `${question || ""}\n${bodyText || ""}`.toLowerCase();
  const explicitPattern = /based on (the )?damage (in|from) (the )?(photos|images)/i;
  if (explicitPattern.test(combined)) return true;

  const mentionsPhotos = /\b(photo|photos|picture|pictures|image|images)\b/i.test(combined);
  const mentionsDamage = /\b(damage|damages|impact|leak|water|storm|wind|hail|fire|loss)\b/i.test(combined);
  const mentionsEstimate = /\b(estimate|scope|line item|xactimate|aligned|align|coincide)\b/i.test(combined);

  return mentionsPhotos && (mentionsDamage || mentionsEstimate);
}

type ParsedDamage = { type: string; severity?: string; location?: string; notes?: string };

function parseDamagesArray(rawDamages: any): ParsedDamage[] {
  if (!rawDamages) return [];

  let parsed: any = rawDamages;
  if (typeof rawDamages === "string") {
    try {
      parsed = JSON.parse(rawDamages);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const normalizedEntries = parsed
    .map((entry: any) => {
      if (typeof entry === "string") {
        return { type: entry };
      }
      if (!entry || typeof entry !== "object") return null;
      const type = String(
        entry.type ||
        entry.damage_type ||
        entry.damage ||
        entry.item ||
        entry.name ||
        "",
      ).trim();
      if (!type) return null;
      return {
        type,
        severity: entry.severity ? String(entry.severity) : undefined,
        location: entry.location ? String(entry.location) : (entry.area ? String(entry.area) : undefined),
        notes: entry.notes ? String(entry.notes) : (entry.why ? String(entry.why) : undefined),
      };
    });

  return normalizedEntries.filter((entry): entry is ParsedDamage => Boolean(entry?.type));
}

function normalizeDamageKey(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateSentence(text: string, max = 180): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function severityScore(raw?: string): number {
  const normalized = String(raw || "").toLowerCase().trim();
  if (!normalized) return 0;
  if (/(critical|catastrophic|extreme)/.test(normalized)) return 5;
  if (/(severe|major|high)/.test(normalized)) return 4;
  if (/(moderate|medium)/.test(normalized)) return 3;
  if (/(minor|low|light)/.test(normalized)) return 2;
  return 1;
}

function conditionRatingScore(raw?: string): number {
  const normalized = String(raw || "").toLowerCase().trim();
  if (!normalized) return 0;
  if (/(critical|severe|poor|failed|failing|unsafe|unserviceable)/.test(normalized)) return 4;
  if (/(moderate|fair|compromised|weathered)/.test(normalized)) return 2;
  if (/(good|minor|serviceable)/.test(normalized)) return 1;
  return 1;
}

async function buildPhotoEstimateEvidenceContext(
  supabase: any,
  claimId: string,
): Promise<{ summaryText: string; analyzedPhotoCount: number; estimateLineCount: number; conditionNarratives: string[] }> {
  try {
    const { data: photos } = await supabase
      .from("claim_photos")
      .select("id, file_name, category, ai_detected_damages, ai_analysis_summary, ai_analyzed_at, ai_condition_rating, ai_condition_notes")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false })
      .limit(120);

    const analyzedPhotos = (photos || []).filter((photo: any) => {
      const parsedDamages = parseDamagesArray(photo.ai_detected_damages);
      return Boolean(
        photo.ai_analyzed_at ||
        parsedDamages.length > 0 ||
        photo.ai_analysis_summary ||
        photo.ai_condition_notes ||
        photo.ai_condition_rating
      );
    });

    const damageMap = new Map<
      string,
      {
        label: string;
        count: number;
        maxSeverityScore: number;
        severities: Set<string>;
        sampleLocations: Set<string>;
        sampleNotes: Set<string>;
      }
    >();

    for (const photo of analyzedPhotos) {
      const damages = parseDamagesArray(photo.ai_detected_damages);
      for (const damage of damages) {
        const key = normalizeDamageKey(damage.type);
        if (!key) continue;

        const existing = damageMap.get(key) || {
          label: truncateSentence(damage.type, 80),
          count: 0,
          maxSeverityScore: 0,
          severities: new Set<string>(),
          sampleLocations: new Set<string>(),
          sampleNotes: new Set<string>(),
        };
        existing.count += 1;
        if (damage.severity) {
          existing.severities.add(truncateSentence(damage.severity, 24));
          existing.maxSeverityScore = Math.max(existing.maxSeverityScore, severityScore(damage.severity));
        }
        if (damage.location) existing.sampleLocations.add(truncateSentence(damage.location, 36));
        if (damage.notes) existing.sampleNotes.add(truncateSentence(damage.notes, 80));
        damageMap.set(key, existing);
      }
    }

    const topDamages = Array.from(damageMap.values())
      .sort((a, b) => (b.maxSeverityScore - a.maxSeverityScore) || (b.count - a.count))
      .slice(0, 7);

    const { data: latestEstimate } = await supabase
      .from("claim_estimates")
      .select("id, vendor, version, total_rcv, total_acv, updated_at, created_at")
      .eq("claim_id", claimId)
      .order("updated_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let estimateLineItems: any[] = [];
    if (latestEstimate?.id) {
      const { data: estimateLines } = await supabase
        .from("estimate_line_items")
        .select("description, category, room, code, rcv, quantity, unit")
        .eq("estimate_id", latestEstimate.id)
        .order("rcv", { ascending: false })
        .limit(120);
      estimateLineItems = estimateLines || [];
    }

    const damageKeywords = topDamages.flatMap((damage) =>
      normalizeDamageKey(damage.label)
        .split(" ")
        .filter((token) => token.length >= 4),
    );

    const matchedEstimateLines = estimateLineItems.filter((line) => {
      const text = `${line.description || ""} ${line.category || ""} ${line.room || ""}`.toLowerCase();
      return damageKeywords.some((keyword) => text.includes(keyword));
    }).slice(0, 8);

    const estimateHighlights = (matchedEstimateLines.length > 0 ? matchedEstimateLines : estimateLineItems.slice(0, 8))
      .map((line) => {
        const lineDesc = truncateSentence(String(line.description || "Estimate line item"), 90);
        const rcv = Number(line.rcv || 0);
        const amount = rcv > 0 ? ` ($${rcv.toLocaleString(undefined, { maximumFractionDigits: 0 })} RCV)` : "";
        return `- ${lineDesc}${amount}`;
      });

    const photoHighlights = topDamages.map((damage) => {
      const severity =
        damage.severities.size > 0
          ? ` [${Array.from(damage.severities).slice(0, 2).join(", ")}]`
          : "";
      const location =
        damage.sampleLocations.size > 0
          ? ` near ${Array.from(damage.sampleLocations)[0]}`
          : "";
      return `- ${damage.label}${severity} documented in ${damage.count} photo(s)${location}`;
    });

    type ScoredPhotoDamage = { photo: any; damages: ParsedDamage[]; score: number };
    const severePhotoHighlights = analyzedPhotos
      .map((photo: any): ScoredPhotoDamage => {
        const damages = parseDamagesArray(photo.ai_detected_damages);
        const maxDamageSeverity = damages.reduce((max, damage) => Math.max(max, severityScore(damage.severity)), 0);
        const score =
          (maxDamageSeverity * 2) +
          conditionRatingScore(photo.ai_condition_rating) +
          (photo.ai_condition_notes ? 0.75 : 0) +
          Math.min(damages.length, 4) * 0.25;

        return { photo, damages, score };
      })
      .filter((entry: ScoredPhotoDamage) => entry.score > 0)
      .sort((a: ScoredPhotoDamage, b: ScoredPhotoDamage) => b.score - a.score)
      .slice(0, 4)
      .map(({ photo, damages }: ScoredPhotoDamage) => {
        const leadDamage = damages
          .slice(0, 2)
          .map((damage: ParsedDamage) => truncateSentence(damage.type, 50))
          .join("; ");
        const conditionPart = photo.ai_condition_rating
          ? `Condition rating: ${photo.ai_condition_rating}.`
          : "";
        const notesPart = photo.ai_condition_notes
          ? ` ${truncateSentence(photo.ai_condition_notes, 170)}`
          : (photo.ai_analysis_summary ? ` ${truncateSentence(photo.ai_analysis_summary, 150)}` : "");
        const damagePart = leadDamage
          ? ` Key damages include ${leadDamage}.`
          : "";
        const categoryPart = photo.category ? ` (${photo.category})` : "";
        return `- ${truncateSentence(photo.file_name || "Photo", 60)}${categoryPart}: ${conditionPart}${notesPart}${damagePart}`;
      });

    const conditionNarratives = analyzedPhotos
      .map((photo: any) => {
        const damages = parseDamagesArray(photo.ai_detected_damages);
        const leadDamage = damages
          .slice(0, 2)
          .map((damage) => truncateSentence(damage.type, 50))
          .join("; ");
        const notes = photo.ai_condition_notes
          ? truncateSentence(photo.ai_condition_notes, 220)
          : (photo.ai_analysis_summary ? truncateSentence(photo.ai_analysis_summary, 180) : "");

        const narrativeParts = [
          leadDamage ? `Damage observed: ${leadDamage}.` : "",
          notes,
        ].filter(Boolean);
        if (narrativeParts.length === 0) return "";

        const severityWeight =
          damages.reduce((max, damage) => Math.max(max, severityScore(damage.severity)), 0) +
          conditionRatingScore(photo.ai_condition_rating);

        return {
          text: truncateSentence(narrativeParts.join(" "), 240),
          severityWeight,
        };
      })
      .filter((entry: any) => Boolean(entry?.text))
      .sort((a: any, b: any) => b.severityWeight - a.severityWeight)
      .slice(0, 4)
      .map((entry: any) => entry.text);

    const estimateHeader = latestEstimate
      ? `Latest estimate on file: ${latestEstimate.vendor || "Estimate"} v${latestEstimate.version || 1}` +
        `${latestEstimate.total_rcv ? `, total RCV $${Number(latestEstimate.total_rcv).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : ""}.`
      : "No structured estimate line items were found on file.";

    const fallbackPhotoNote =
      analyzedPhotos.length === 0
        ? "No photo damage documentation was found on this claim yet."
        : "";

    const summaryText = [
      `Photo documentation reviewed: ${analyzedPhotos.length} image(s).`,
      fallbackPhotoNote,
      photoHighlights.length > 0 ? "Key photo-documented damages:" : "",
      ...photoHighlights,
      severePhotoHighlights.length > 0 ? "Most severe photo condition findings (use this language in the draft):" : "",
      ...severePhotoHighlights,
      estimateHeader,
      estimateHighlights.length > 0 ? "Estimate scope alignment points:" : "",
      ...estimateHighlights,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      summaryText: truncateSentence(summaryText, 2600),
      analyzedPhotoCount: analyzedPhotos.length,
      estimateLineCount: estimateLineItems.length,
      conditionNarratives,
    };
  } catch (error) {
    console.error("Error building photo/estimate evidence context:", error);
    return { summaryText: "", analyzedPhotoCount: 0, estimateLineCount: 0, conditionNarratives: [] };
  }
}

function ensureConditionNarrativesInBody(
  body: string,
  conditionNarratives: string[] = [],
  carrierFacing: boolean,
): string {
  const cleanBody = String(body || "").trim();
  if (!cleanBody) return cleanBody;
  const narratives = (conditionNarratives || []).map((n) => String(n || "").trim()).filter(Boolean);
  if (narratives.length === 0) return cleanBody;

  const bodyNormalized = normalizeDamageKey(cleanBody);
  const matchedNarratives = narratives.filter((narrative) => {
    const tokens = normalizeDamageKey(narrative)
      .split(" ")
      .filter((token) => token.length >= 6)
      .slice(0, 8);
    return tokens.some((token) => bodyNormalized.includes(token));
  });

  if (matchedNarratives.length >= Math.min(2, narratives.length)) {
    return cleanBody;
  }

  const leadLine = carrierFacing
    ? "The observed property conditions include the following documented impacts:"
    : "The observed property conditions include the following documented findings:";
  const repairLine = carrierFacing
    ? "These conditions require the repair and replacement scope reflected in our estimate to restore the property to pre-loss condition."
    : "These conditions support the repair and replacement scope reflected in our estimate.";

  const additions = narratives.slice(0, 3).map((narrative) => `- ${truncateSentence(narrative, 220)}`);
  return `${cleanBody}\n\n${leadLine}\n${additions.join("\n")}\n${repairLine}`;
}

async function rewriteEmailBodyWithPhotoEstimateEvidence(
  rawBody: string,
  claimData: any,
  recipientName: string | undefined,
  evidenceSummary: string,
  options?: { carrierFacing?: boolean; conditionNarratives?: string[] },
): Promise<string> {
  const trimmedBody = String(rawBody || "").trim();
  if (!trimmedBody || !evidenceSummary.trim()) {
    return trimmedBody;
  }
  const carrierFacing = options?.carrierFacing === true;

  // Use shared AI layer
  const { generate } = await import("../_shared/ai/generate.ts");
  }

  const claimNumber = String(claimData?.claim_number || "").trim();
  const carrier = String(claimData?.insurance_company || "the insurance carrier").trim();
  const policyholder = String(claimData?.policyholder_name || "the insured").trim();
  const recipient = recipientName && !recipientName.includes("@") ? recipientName : "Adjuster";
  const estimateLeadIn = "Attached is our estimate for the damages sustained to the property.";
  const fallbackPrefix = carrierFacing
    ? `${estimateLeadIn}\n\nThis estimate is in line with the documented damages found, including:\n${evidenceSummary}\n\nBased on these documented impacts and resulting condition findings, the full repair scope reflected in our estimate is required to restore the property to pre-loss condition. Please provide your revised scope and payment position in writing.`
    : `${estimateLeadIn}\n\nThis estimate is in line with the damages found and the corresponding repair scope, including:\n${evidenceSummary}`;

  try {
    const userContent = [
      `Rewrite this email so it is professional and evidence-driven for ${carrier}.`,
      `Claim #: ${claimNumber || "N/A"} | Policyholder: ${policyholder} | Recipient: ${recipient}`,
      "",
      "Original draft:",
      trimmedBody,
      "",
      "Photo/estimate evidence context (use this to strengthen the draft):",
      evidenceSummary,
      "",
      "Requirements:",
      `- Include this sentence naturally near the beginning: "${estimateLeadIn}"`,
      "- Include a sentence like: \"This estimate is in line with the damages found, such as ...\" and then list key damages.",
      "- Keep greeting and courteous close.",
      "- Include important property damages from the photo documentation (not every single point).",
      "- Tie damages to estimate scope items already on file.",
      "- Use specific, direct damage statements (example style): \"Stone wall is displaced due to vehicle impact. Wood siding and underlying plywood sustained impact damage. The impact displaced the chimney from its original position, creating gaps and exposing underlying structures.\"",
      "- Pull details from the most severe photo condition findings and weave them naturally into the draft.",
      "- Explain what repairs are required for those damages and why those items are included in the estimate.",
      carrierFacing
        ? "- This is carrier-facing: use assertive but professional claim-advocacy language. Use decisive phrasing (e.g., \"documented damage confirms,\" \"requires replacement/repair\"). Avoid hedging terms like \"might\" or \"possibly.\""
        : "- Use collaborative but professional tone suitable for client-facing communications.",
      carrierFacing
        ? "- Include a direct ask for revised scope and payment alignment, with a request for written confirmation."
        : "- Include a clear request for next steps or confirmation.",
      "- Ask for scope/payment update based on this evidence.",
      "- Do NOT mention AI, analysis tools, or automated photo review.",
      "- Return only the final email body text.",
    ].join("\n");

    const aiResult = await generate({
      task: 'copilot_drafting',
      system: "You are a senior public-adjuster communication specialist. Rewrite emails in plain text only (no markdown). Keep professional tone, concise but specific. Include only the strongest documented damages and clearly tie them to estimate scope. NEVER mention AI, automated analysis, models, or computer vision.",
      user: userContent,
      searchMode: 'off',
      maxTokens: 900,
    });

    console.log(`[EmailRewrite] Complete, model=${aiResult.model}, cached=${aiResult.cached}`);
    const rewritten = String(aiResult.text || "").trim();
    if (!rewritten) {
      return ensureConditionNarrativesInBody(
        `${fallbackPrefix}\n\n${trimmedBody}`,
        options?.conditionNarratives || [],
        carrierFacing,
      );
    }
    return ensureConditionNarrativesInBody(
      rewritten,
      options?.conditionNarratives || [],
      carrierFacing,
    );
  } catch (error) {
    console.error("Error rewriting email with photo/estimate evidence:", error);
    return ensureConditionNarrativesInBody(
      `${fallbackPrefix}\n\n${trimmedBody}`,
      options?.conditionNarratives || [],
      carrierFacing,
    );
  }
}
async function resolveCommunicationClaim(
  supabase: any,
  params: any,
  fallbackClaimId: string | null,
  currentClaim: any,
): Promise<{ claimId: string | null; claim: any | null; claimName: string; error?: string }> {
  try {
    let targetClaimId = params?.claim_id || fallbackClaimId || null;

    if (!targetClaimId && params?.client_name) {
      const found = await findClaimByClientName(supabase, params.client_name);
      if (found) targetClaimId = found.id;
    }

    if (!targetClaimId) {
      return {
        claimId: null,
        claim: null,
        claimName: "claim",
        error: "No claim specified. Open a claim or provide a client name.",
      };
    }

    if (currentClaim && currentClaim.id === targetClaimId) {
      return {
        claimId: targetClaimId,
        claim: currentClaim,
        claimName: currentClaim.policyholder_name || currentClaim.claim_number || "claim",
      };
    }

    const { data: loadedClaim, error } = await supabase
      .from("claims")
      .select(`
        id,
        client_id,
        claim_number,
        policyholder_name,
        policyholder_email,
        policyholder_phone,
        adjuster_name,
        adjuster_email,
        adjuster_phone,
        insurance_company,
        insurance_email,
        insurance_phone,
        referrer_id,
        policy_number
      `)
      .eq("id", targetClaimId)
      .maybeSingle();

    if (error || !loadedClaim) {
      return {
        claimId: targetClaimId,
        claim: null,
        claimName: "claim",
        error: "Could not load claim details for communication.",
      };
    }

    return {
      claimId: targetClaimId,
      claim: loadedClaim,
      claimName: loadedClaim.policyholder_name || loadedClaim.claim_number || "claim",
    };
  } catch (err) {
    console.error("Error resolving communication claim:", err);
    return {
      claimId: null,
      claim: null,
      claimName: "claim",
      error: err instanceof Error ? err.message : "Failed to resolve claim",
    };
  }
}

async function resolveEmailRecipientForClaim(
  supabase: any,
  claimData: any,
  claimId: string,
  input: CommunicationRecipientInput,
): Promise<{ recipient?: ResolvedEmailRecipient; error?: string }> {
  const directEmail = input.recipient_email?.trim();
  if (directEmail) {
    return {
      recipient: {
        email: directEmail,
        name: input.recipient_name?.trim() || directEmail,
        type: "manual",
      },
    };
  }

  const recipientType = normalizeRecipientType(input.recipient_type) || "policyholder";

  if (recipientType === "manual") {
    return { error: "Manual email recipient requires recipient_email." };
  }

  if (recipientType === "policyholder") {
    if (!claimData?.policyholder_email) return { error: "Policyholder email is missing on this claim." };
    return {
      recipient: {
        email: claimData.policyholder_email,
        name: claimData.policyholder_name || "Policyholder",
        type: "policyholder",
      },
    };
  }

  if (recipientType === "insurance_company") {
    const carrierRecipientSet = await resolveCarrierEmailRecipientsForClaim(supabase, claimData, claimId, input.recipient_name);
    if (carrierRecipientSet.recipients.length > 0) {
      return { recipient: carrierRecipientSet.recipients[0] };
    }
    return { error: carrierRecipientSet.errors[0] || "Insurance company email is missing on this claim." };
  }

  if (recipientType === "adjuster") {
    let query = supabase
      .from("claim_adjusters")
      .select("adjuster_name, adjuster_email, is_primary")
      .eq("claim_id", claimId);

    if (input.recipient_name) {
      query = query.ilike("adjuster_name", `%${input.recipient_name}%`);
    }

    const { data: adjusters } = await query;
    const withEmail = (adjusters || []).filter((a: any) => a.adjuster_email);
    const chosen = withEmail.find((a: any) => a.is_primary) || withEmail[0];

    if (chosen?.adjuster_email) {
      return {
        recipient: {
          email: chosen.adjuster_email,
          name: chosen.adjuster_name || "Adjuster",
          type: "adjuster",
        },
      };
    }

    if (claimData?.adjuster_email) {
      return {
        recipient: {
          email: claimData.adjuster_email,
          name: claimData.adjuster_name || "Adjuster",
          type: "adjuster",
        },
      };
    }

    if (claimData?.insurance_email) {
      return {
        recipient: {
          email: claimData.insurance_email,
          name: claimData.insurance_company || "Insurance Company",
          type: "insurance_company",
        },
      };
    }

    return { error: "Adjuster email is missing on this claim." };
  }

  if (recipientType === "referrer") {
    if (!claimData?.referrer_id) return { error: "No referrer is assigned to this claim." };
    const { data: referrer } = await supabase
      .from("referrers")
      .select("name, email")
      .eq("id", claimData.referrer_id)
      .maybeSingle();

    if (!referrer?.email) return { error: "Referrer email is missing on this claim." };
    return {
      recipient: {
        email: referrer.email,
        name: referrer.name || "Referrer",
        type: "referrer",
      },
    };
  }

  if (recipientType === "contractor") {
    const { data: assignments } = await supabase
      .from("claim_contractors")
      .select("contractor_id")
      .eq("claim_id", claimId);
    const contractorIds = (assignments || []).map((a: any) => a.contractor_id).filter(Boolean);

    if (contractorIds.length === 0) {
      return { error: "No contractors are assigned to this claim." };
    }

    let profileQuery = supabase
      .from("profiles")
      .select("full_name, email")
      .in("id", contractorIds);

    if (input.recipient_name) {
      profileQuery = profileQuery.ilike("full_name", `%${input.recipient_name}%`);
    }

    const { data: profiles } = await profileQuery;
    const chosen = (profiles || []).find((p: any) => p.email);
    if (!chosen?.email) return { error: "Contractor email is missing on this claim." };

    return {
      recipient: {
        email: chosen.email,
        name: chosen.full_name || "Contractor",
        type: "contractor",
      },
    };
  }

  return { error: "Unsupported email recipient type." };
}

async function resolveCarrierEmailRecipientsForClaim(
  supabase: any,
  claimData: any,
  claimId: string,
  adjusterNameFilter?: string,
): Promise<{ recipients: ResolvedEmailRecipient[]; errors: string[] }> {
  const recipients: ResolvedEmailRecipient[] = [];
  const errors: string[] = [];

  if (claimData?.insurance_email) {
    recipients.push({
      email: claimData.insurance_email,
      name: claimData.insurance_company || "Insurance Company",
      type: "insurance_company",
    });
  }

  let adjusterRecipient: ResolvedEmailRecipient | null = null;
  let query = supabase
    .from("claim_adjusters")
    .select("adjuster_name, adjuster_email, is_primary")
    .eq("claim_id", claimId);

  if (adjusterNameFilter) {
    query = query.ilike("adjuster_name", `%${adjusterNameFilter}%`);
  }

  const { data: adjusters } = await query;
  const withEmail = (adjusters || []).filter((a: any) => a.adjuster_email);
  const chosenAdjuster = withEmail.find((a: any) => a.is_primary) || withEmail[0];

  if (chosenAdjuster?.adjuster_email) {
    adjusterRecipient = {
      email: chosenAdjuster.adjuster_email,
      name: chosenAdjuster.adjuster_name || "Adjuster",
      type: "adjuster",
    };
  } else if (claimData?.adjuster_email) {
    adjusterRecipient = {
      email: claimData.adjuster_email,
      name: claimData.adjuster_name || "Adjuster",
      type: "adjuster",
    };
  }

  if (adjusterRecipient) {
    recipients.push(adjusterRecipient);
  }

  const dedupedRecipients = dedupeEmailRecipients(recipients);
  if (dedupedRecipients.length === 0) {
    errors.push("No insurance company or assigned adjuster email is available on this claim.");
  }

  return {
    recipients: dedupedRecipients,
    errors,
  };
}

async function resolveSmsRecipientForClaim(
  supabase: any,
  claimData: any,
  claimId: string,
  input: CommunicationRecipientInput,
): Promise<{ recipient?: ResolvedSmsRecipient; error?: string }> {
  const directPhone = (input.recipient_phone || input.to_number)?.trim();
  if (directPhone) {
    return {
      recipient: {
        phone: directPhone,
        name: input.recipient_name?.trim() || directPhone,
        type: "manual",
      },
    };
  }

  const recipientType = normalizeRecipientType(input.recipient_type) || "policyholder";

  if (recipientType === "manual") {
    return { error: "Manual SMS recipient requires recipient_phone." };
  }

  if (recipientType === "policyholder") {
    if (!claimData?.policyholder_phone) return { error: "Policyholder phone is missing on this claim." };
    return {
      recipient: {
        phone: claimData.policyholder_phone,
        name: claimData.policyholder_name || "Policyholder",
        type: "policyholder",
      },
    };
  }

  if (recipientType === "insurance_company") {
    if (!claimData?.insurance_phone) return { error: "Insurance company phone is missing on this claim." };
    return {
      recipient: {
        phone: claimData.insurance_phone,
        name: claimData.insurance_company || "Insurance Company",
        type: "insurance_company",
      },
    };
  }

  if (recipientType === "adjuster") {
    let query = supabase
      .from("claim_adjusters")
      .select("adjuster_name, adjuster_phone, is_primary")
      .eq("claim_id", claimId);

    if (input.recipient_name) {
      query = query.ilike("adjuster_name", `%${input.recipient_name}%`);
    }

    const { data: adjusters } = await query;
    const withPhone = (adjusters || []).filter((a: any) => a.adjuster_phone);
    const chosen = withPhone.find((a: any) => a.is_primary) || withPhone[0];

    if (chosen?.adjuster_phone) {
      return {
        recipient: {
          phone: chosen.adjuster_phone,
          name: chosen.adjuster_name || "Adjuster",
          type: "adjuster",
        },
      };
    }

    if (claimData?.adjuster_phone) {
      return {
        recipient: {
          phone: claimData.adjuster_phone,
          name: claimData.adjuster_name || "Adjuster",
          type: "adjuster",
        },
      };
    }

    return { error: "Adjuster phone is missing on this claim." };
  }

  if (recipientType === "referrer") {
    if (!claimData?.referrer_id) return { error: "No referrer is assigned to this claim." };
    const { data: referrer } = await supabase
      .from("referrers")
      .select("name, phone")
      .eq("id", claimData.referrer_id)
      .maybeSingle();

    if (!referrer?.phone) return { error: "Referrer phone is missing on this claim." };
    return {
      recipient: {
        phone: referrer.phone,
        name: referrer.name || "Referrer",
        type: "referrer",
      },
    };
  }

  if (recipientType === "contractor") {
    const { data: assignments } = await supabase
      .from("claim_contractors")
      .select("contractor_id")
      .eq("claim_id", claimId);
    const contractorIds = (assignments || []).map((a: any) => a.contractor_id).filter(Boolean);

    if (contractorIds.length === 0) {
      return { error: "No contractors are assigned to this claim." };
    }

    let profileQuery = supabase
      .from("profiles")
      .select("full_name, phone")
      .in("id", contractorIds);

    if (input.recipient_name) {
      profileQuery = profileQuery.ilike("full_name", `%${input.recipient_name}%`);
    }

    const { data: profiles } = await profileQuery;
    const chosen = (profiles || []).find((p: any) => p.phone);
    if (!chosen?.phone) return { error: "Contractor phone is missing on this claim." };

    return {
      recipient: {
        phone: chosen.phone,
        name: chosen.full_name || "Contractor",
        type: "contractor",
      },
    };
  }

  return { error: "Unsupported SMS recipient type." };
}

async function invokeEdgeFunction(
  supabaseUrl: string,
  functionName: string,
  payload: Record<string, any>,
  authHeader?: string | null,
  fallbackServiceKey?: string,
): Promise<{ success: boolean; data?: any; error?: string; status?: number }> {
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceAuthHeader = fallbackServiceKey ? `Bearer ${fallbackServiceKey}` : undefined;

  const parseJwtRole = (header?: string | null): string | null => {
    if (!header || !header.startsWith("Bearer ")) return null;
    const token = header.replace("Bearer ", "").trim();
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
      const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
      const decoded = atob(normalized + padding);
      const payloadObj = JSON.parse(decoded);
      return payloadObj?.role || payloadObj?.app_metadata?.role || null;
    } catch {
      return null;
    }
  };

  const requestedRole = parseJwtRole(authHeader);
  const shouldUseUserAuth = requestedRole === "authenticated";
  const initialAuthorization = shouldUseUserAuth
    ? (authHeader || undefined)
    : (serviceAuthHeader || authHeader || undefined);

  const invokeWithAuth = async (
    authorization?: string,
  ): Promise<{ success: boolean; data?: any; error?: string; status?: number }> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (authorization) {
      headers.Authorization = authorization;
    }
    if (supabaseAnonKey) {
      headers.apikey = supabaseAnonKey;
    } else if (fallbackServiceKey) {
      headers.apikey = fallbackServiceKey;
    }

    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      const rawText = await response.text();
      let data: any = {};
      if (rawText) {
        try {
          data = JSON.parse(rawText);
        } catch {
          data = { raw: rawText };
        }
      }

      if (!response.ok) {
        const responseError =
          data?.error ||
          data?.message ||
          (rawText ? rawText.slice(0, 400) : "") ||
          `Edge function ${functionName} failed with ${response.status}`;

        return {
          success: false,
          data,
          status: response.status,
          error: String(responseError),
        };
      }

      return { success: true, data, status: response.status };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : `Failed to call ${functionName}`,
      };
    }
  };

  const firstAttempt = await invokeWithAuth(initialAuthorization);
  if (firstAttempt.success) {
    return firstAttempt;
  }

  const shouldRetryWithServiceAuth = Boolean(
    serviceAuthHeader &&
    initialAuthorization !== serviceAuthHeader &&
    (firstAttempt.status === 401 || firstAttempt.status === 403),
  );

  if (shouldRetryWithServiceAuth) {
    const fallbackAttempt = await invokeWithAuth(serviceAuthHeader);
    if (fallbackAttempt.success) {
      return fallbackAttempt;
    }

    return {
      success: false,
      data: fallbackAttempt.data || firstAttempt.data,
      status: fallbackAttempt.status || firstAttempt.status,
      error: fallbackAttempt.error || firstAttempt.error,
    };
  }

  return firstAttempt;
}

async function getAuthenticatedUserId(supabase: any, authHeader?: string | null): Promise<string | null> {
  const token = authHeader?.replace("Bearer ", "").trim();
  if (!token) return null;
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return null;
    return user.id;
  } catch {
    return null;
  }
}

function getTodayDateString(): string {
  return new Date().toISOString().split("T")[0];
}

function buildCommunicationTimestamp(scheduledDate?: string, scheduledTime?: string): string {
  const today = getTodayDateString();
  const datePart = scheduledDate && /^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)
    ? scheduledDate
    : today;

  if (!scheduledTime) {
    return `${datePart}T09:00:00.000Z`;
  }

  const normalizedTime = /^\d{2}:\d{2}(:\d{2})?$/.test(scheduledTime)
    ? (scheduledTime.length === 5 ? `${scheduledTime}:00` : scheduledTime)
    : "09:00:00";

  return `${datePart}T${normalizedTime}.000Z`;
}

function sanitizeFileNamePart(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "letter";
}

async function saveLetterToClaimFiles(
  supabase: any,
  claimId: string,
  subject: string,
  content: string,
  uploadedBy?: string | null,
): Promise<{ fileId?: string; fileName?: string; filePath?: string; error?: string }> {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeSubject = sanitizeFileNamePart(subject);
    const fileName = `${timestamp}-${safeSubject}.txt`;
    const filePath = `${claimId}/assistant-letters/${fileName}`;
    const fileBytes = new TextEncoder().encode(content);

    const { error: uploadError } = await supabase.storage
      .from("claim-files")
      .upload(filePath, fileBytes, {
        contentType: "text/plain",
        upsert: false,
      });

    if (uploadError) {
      return { error: `Failed to upload letter file: ${uploadError.message}` };
    }

    const { data: fileRecord, error: fileError } = await supabase
      .from("claim_files")
      .insert({
        claim_id: claimId,
        file_name: fileName,
        file_path: filePath,
        file_type: "text/plain",
        uploaded_by: uploadedBy || null,
      })
      .select("id")
      .single();

    if (fileError) {
      return { error: `Failed to create claim file record: ${fileError.message}` };
    }

    return {
      fileId: fileRecord?.id,
      fileName,
      filePath,
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Failed to save letter file",
    };
  }
}

async function resolvePreferredLetterRecipient(
  supabase: any,
  claimData: any,
  claimId: string,
  params: any,
): Promise<{ recipient?: ResolvedEmailRecipient; error?: string }> {
  const directEmail = params?.recipient_email?.trim();
  if (directEmail) {
    return {
      recipient: {
        email: directEmail,
        name: params?.recipient_name?.trim() || directEmail,
        type: "manual",
      },
    };
  }

  const explicitType = normalizeRecipientType(params?.recipient_type);
  if (explicitType) {
    return resolveEmailRecipientForClaim(supabase, claimData, claimId, {
      recipient_type: explicitType,
      recipient_name: params?.recipient_name,
    });
  }

  const fallbackTypes: CommunicationRecipientType[] = ["adjuster", "insurance_company", "policyholder"];
  for (const fallbackType of fallbackTypes) {
    const resolved = await resolveEmailRecipientForClaim(supabase, claimData, claimId, {
      recipient_type: fallbackType,
      recipient_name: params?.recipient_name,
    });
    if (resolved.recipient) {
      return resolved;
    }
  }

  return { error: "No email recipient could be resolved for this letter." };
}

async function resolvePortalRecipientsForClaim(
  supabase: any,
  claimData: any,
  claimId: string,
  options: {
    notifyClient: boolean;
    notifyContractors: boolean;
    explicitRecipientUserIds?: string[];
  },
): Promise<{ recipientIds: string[]; recipientLabels: string[]; errors: string[] }> {
  const recipientMap = new Map<string, string>();
  const errors: string[] = [];

  if (options.notifyClient) {
    if (!claimData?.client_id) {
      errors.push("No client is assigned to this claim.");
    } else {
      const { data: client } = await supabase
        .from("clients")
        .select("name, user_id")
        .eq("id", claimData.client_id)
        .maybeSingle();

      if (!client?.user_id) {
        errors.push("Client does not have portal access.");
      } else {
        recipientMap.set(client.user_id, `Client (${client.name || claimData.policyholder_name || "policyholder"})`);
      }
    }
  }

  if (options.notifyContractors) {
    const { data: assignments } = await supabase
      .from("claim_contractors")
      .select("contractor_id")
      .eq("claim_id", claimId);

    const contractorIds = (assignments || [])
      .map((assignment: any) => assignment.contractor_id)
      .filter(Boolean);

    if (contractorIds.length === 0) {
      errors.push("No contractors are assigned to this claim.");
    } else {
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", contractorIds);
      const profileMap = new Map<string, { full_name?: string; email?: string }>(
        (profiles || []).map((profile: any) => [profile.id, profile]),
      );

      for (const contractorId of contractorIds) {
        const profile = profileMap.get(contractorId);
        const label = profile?.full_name || profile?.email || `Contractor (${contractorId.slice(0, 8)})`;
        recipientMap.set(contractorId, label);
      }
    }
  }

  for (const explicitId of options.explicitRecipientUserIds || []) {
    const userId = String(explicitId || "").trim();
    if (!userId) continue;
    if (!recipientMap.has(userId)) {
      recipientMap.set(userId, `User (${userId.slice(0, 8)})`);
    }
  }

  const recipientIds = Array.from(recipientMap.keys());
  const recipientLabels = Array.from(recipientMap.values());
  return { recipientIds, recipientLabels, errors };
}

// Helper function to resolve multiple claims from names or status filter
async function resolveClaimIds(supabase: any, claimIds?: string[], clientNames?: string[], filterByStatus?: string): Promise<{ id: string; name: string }[]> {
  const resolved: { id: string; name: string }[] = [];
  
  // If filtering by status, fetch all matching claims
  if (filterByStatus) {
    const { data: claims, error } = await supabase
      .from("claims")
      .select("id, policyholder_name")
      .ilike("status", filterByStatus);
    
    if (!error && claims) {
      for (const claim of claims) {
        resolved.push({ id: claim.id, name: claim.policyholder_name || "Unknown" });
      }
    }
    return resolved;
  }
  
  if (claimIds && claimIds.length > 0) {
    for (const id of claimIds) {
      const { data } = await supabase
        .from("claims")
        .select("id, policyholder_name")
        .eq("id", id)
        .single();
      if (data) resolved.push({ id: data.id, name: data.policyholder_name });
    }
  }
  
  if (clientNames && clientNames.length > 0) {
    for (const name of clientNames) {
      const claim = await findClaimByClientName(supabase, name);
      if (claim) resolved.push({ id: claim.id, name: claim.policyholder_name });
    }
  }
  
  return resolved;
}

// Helper function for bulk status update
async function bulkUpdateStatus(supabase: any, claimIds: string[], newStatus: string): Promise<{ success: number; failed: number }> {
  const { error } = await supabase
    .from("claims")
    .update({ status: newStatus })
    .in("id", claimIds);
  
  if (error) {
    console.error("Error bulk updating status:", error);
    return { success: 0, failed: claimIds.length };
  }
  return { success: claimIds.length, failed: 0 };
}

// Helper function for bulk close claims
async function bulkCloseClaims(supabase: any, claimIds: string[]): Promise<{ success: number; failed: number }> {
  const { error } = await supabase
    .from("claims")
    .update({ is_closed: true })
    .in("id", claimIds);
  
  if (error) {
    console.error("Error bulk closing claims:", error);
    return { success: 0, failed: claimIds.length };
  }
  return { success: claimIds.length, failed: 0 };
}

// Helper function for bulk reopen claims
async function bulkReopenClaims(supabase: any, claimIds: string[]): Promise<{ success: number; failed: number }> {
  const { error } = await supabase
    .from("claims")
    .update({ is_closed: false })
    .in("id", claimIds);
  
  if (error) {
    console.error("Error bulk reopening claims:", error);
    return { success: 0, failed: claimIds.length };
  }
  return { success: claimIds.length, failed: 0 };
}

// Helper function for bulk staff assignment
async function bulkAssignStaff(supabase: any, claimIds: string[], staffId: string): Promise<{ success: number; failed: number; skipped: number }> {
  // Get existing assignments
  const { data: existing } = await supabase
    .from("claim_staff")
    .select("claim_id")
    .eq("staff_id", staffId)
    .in("claim_id", claimIds);
  
  const existingIds = new Set(existing?.map((e: any) => e.claim_id) || []);
  const newClaimIds = claimIds.filter(id => !existingIds.has(id));
  
  if (newClaimIds.length === 0) {
    return { success: 0, failed: 0, skipped: claimIds.length };
  }
  
  const { error } = await supabase
    .from("claim_staff")
    .insert(newClaimIds.map(claimId => ({ claim_id: claimId, staff_id: staffId })));
  
  if (error) {
    console.error("Error bulk assigning staff:", error);
    return { success: 0, failed: newClaimIds.length, skipped: existingIds.size };
  }
  return { success: newClaimIds.length, failed: 0, skipped: existingIds.size };
}

// Helper function to find staff by name
async function findStaffByName(supabase: any, staffName: string): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .or(`full_name.ilike.%${staffName}%,email.ilike.%${staffName}%`)
    .limit(1);
  
  if (data && data.length > 0) {
    return { id: data[0].id, name: data[0].full_name || data[0].email };
  }
  return null;
}

// Helper function to search tasks with fuzzy keyword matching
async function searchTasksByKeywords(
  supabase: any, 
  keywords: string[], 
  status: string = "pending",
  includeClosedClaims: boolean = false
): Promise<string> {
  try {
    // Build expanded keyword list with synonyms and common variations
    const expandedKeywords: string[] = [];
    const keywordSynonyms: Record<string, string[]> = {
      'coc': ['certificate of completion', 'completion certificate', 'coc', 'c.o.c'],
      'certificate of completion': ['coc', 'completion certificate', 'certificate'],
      'photos': ['photo', 'pictures', 'picture', 'image', 'images', 'pics'],
      'photo': ['photos', 'pictures', 'picture', 'image', 'images', 'pics'],
      'completion': ['complete', 'completed', 'finishing', 'final'],
      'needed': ['need', 'required', 'missing', 'outstanding', 'get', 'obtain', 'upload'],
      'upload': ['get', 'obtain', 'send', 'submit', 'needed'],
      'estimate': ['estimates', 'xactimate', 'scope', 'bid'],
      'supplement': ['supplements', 'supp', 'supplemental'],
      'inspection': ['inspections', 'inspect', 're-inspect', 'reinspect'],
      'follow up': ['follow-up', 'followup', 'follow'],
      'call': ['phone', 'contact', 'reach out'],
      'email': ['send email', 'draft email', 'write email'],
      'denial': ['denied', 'deny', 'rejection', 'rejected'],
      'rebuttal': ['rebut', 'respond', 'response', 'counter'],
    };
    
    // Expand each keyword with its synonyms
    for (const keyword of keywords) {
      const lowerKeyword = keyword.toLowerCase().trim();
      expandedKeywords.push(lowerKeyword);
      
      // Add synonyms if they exist
      if (keywordSynonyms[lowerKeyword]) {
        expandedKeywords.push(...keywordSynonyms[lowerKeyword]);
      }
      
      // Also check if any synonym maps TO this keyword
      for (const [syn, targets] of Object.entries(keywordSynonyms)) {
        if (targets.includes(lowerKeyword) && !expandedKeywords.includes(syn)) {
          expandedKeywords.push(syn);
        }
      }
    }
    
    // Remove duplicates
    const uniqueKeywords = [...new Set(expandedKeywords)];
    console.log("Searching tasks with expanded keywords:", uniqueKeywords);
    
    // Build the base query
    let query = supabase
      .from("tasks")
      .select(`
        id,
        title,
        description,
        status,
        priority,
        due_date,
        created_at,
        claims!inner(id, claim_number, policyholder_name, status, is_closed)
      `)
      .order("created_at", { ascending: false });
    
    // Filter by task status
    if (status !== "all") {
      query = query.eq("status", status);
    }
    
    // Filter out closed claims unless requested
    if (!includeClosedClaims) {
      query = query.eq("claims.is_closed", false);
    }
    
    // Fetch all matching tasks (we'll filter client-side for fuzzy matching)
    const { data: allTasks, error } = await query.limit(500);
    
    if (error) {
      console.error("Error fetching tasks:", error);
      return `❌ Error searching tasks: ${error.message}`;
    }
    
    if (!allTasks || allTasks.length === 0) {
      return `No ${status === "all" ? "" : status + " "}tasks found.`;
    }
    
    // Filter tasks by keywords (fuzzy match on title and description)
    const matchingTasks = allTasks.filter((task: any) => {
      const titleLower = (task.title || "").toLowerCase();
      const descLower = (task.description || "").toLowerCase();
      const combined = titleLower + " " + descLower;
      
      // Check if any expanded keyword matches
      return uniqueKeywords.some(keyword => combined.includes(keyword));
    });
    
    if (matchingTasks.length === 0) {
      return `No ${status === "all" ? "" : status + " "}tasks found matching: ${keywords.join(", ")}.\n\nI searched for these terms and variations: ${uniqueKeywords.slice(0, 10).join(", ")}${uniqueKeywords.length > 10 ? "..." : ""}`;
    }
    
    // Build the result
    let result = `Found ${matchingTasks.length} ${status === "all" ? "" : status + " "}task(s) matching "${keywords.join(", ")}":\n\n`;
    
    // Group by claim for better organization
    const tasksByClaim: Record<string, any[]> = {};
    for (const task of matchingTasks) {
      const claimKey = task.claims?.claim_number || task.claims?.policyholder_name || "Unknown Claim";
      if (!tasksByClaim[claimKey]) {
        tasksByClaim[claimKey] = [];
      }
      tasksByClaim[claimKey].push(task);
    }
    
    for (const [claimKey, tasks] of Object.entries(tasksByClaim)) {
      const claim = (tasks as any[])[0].claims;
      result += `📋 ${claim?.policyholder_name || claimKey} (${claim?.claim_number || "No #"}) - ${claim?.status || "Unknown status"}\n`;
      
      for (const task of tasks as any[]) {
        const statusIcon = task.status === "completed" ? "✅" : "⏳";
        const dueDate = task.due_date ? new Date(task.due_date).toLocaleDateString() : "No due date";
        const priority = task.priority ? ` [${task.priority}]` : "";
        result += `  ${statusIcon} ${task.title}${priority} - Due: ${dueDate}\n`;
        if (task.description) {
          result += `     ${task.description.substring(0, 80)}${task.description.length > 80 ? "..." : ""}\n`;
        }
      }
      result += "\n";
    }
    
    return result;
  } catch (err) {
    console.error("Exception in searchTasksByKeywords:", err);
    return `❌ Error searching tasks: ${err instanceof Error ? err.message : "Unknown error"}`;
  }
}

// Helper function to find a task by title search within a claim
async function findTaskByTitle(supabase: any, titleSearch: string, claimId?: string): Promise<any | null> {
  try {
    let query = supabase
      .from("tasks")
      .select("id, title, description, status, priority, due_date, claim_id, assigned_to")
      .ilike("title", `%${titleSearch}%`)
      .order("created_at", { ascending: false })
      .limit(1);
    
    if (claimId) {
      query = query.eq("claim_id", claimId);
    }
    
    const { data, error } = await query;
    if (error || !data || data.length === 0) return null;
    return data[0];
  } catch (err) {
    console.error("Error finding task by title:", err);
    return null;
  }
}

// Helper function to resolve a task from either task_id or title search
async function resolveTask(supabase: any, taskId?: string, titleSearch?: string, claimId?: string): Promise<{ task: any | null; error?: string }> {
  if (taskId) {
    const { data, error } = await supabase
      .from("tasks")
      .select("id, title, description, status, priority, due_date, claim_id, assigned_to")
      .eq("id", taskId)
      .single();
    if (error || !data) return { task: null, error: "Task not found with that ID" };
    return { task: data };
  }
  if (titleSearch) {
    const task = await findTaskByTitle(supabase, titleSearch, claimId);
    if (!task) return { task: null, error: `No task found matching "${titleSearch}"` };
    return { task };
  }
  return { task: null, error: "No task ID or search term provided" };
}


function getDateRange(timePeriod: string): { start: Date; end: Date } {
  const now = new Date();
  const end = new Date(now);
  let start = new Date(now);

  switch (timePeriod) {
    case "today":
      start.setHours(0, 0, 0, 0);
      break;
    case "yesterday":
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() - 1);
      end.setHours(23, 59, 59, 999);
      break;
    case "this_week":
      const dayOfWeek = start.getDay();
      start.setDate(start.getDate() - dayOfWeek);
      start.setHours(0, 0, 0, 0);
      break;
    case "last_week":
      const currentDay = start.getDay();
      start.setDate(start.getDate() - currentDay - 7);
      start.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() - currentDay - 1);
      end.setHours(23, 59, 59, 999);
      break;
    case "this_month":
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      break;
    case "last_30_days":
      start.setDate(start.getDate() - 30);
      break;
    case "last_90_days":
      start.setDate(start.getDate() - 90);
      break;
    case "all_time":
    default:
      start = new Date(0); // Beginning of time
      break;
  }

  return { start, end };
}

// Helper function to search user activity via audit logs
async function searchUserActivity(supabase: any, userId: string, timePeriod: string, actionType?: string): Promise<string> {
  try {
    const { start, end } = getDateRange(timePeriod);
    
    let query = supabase
      .from("audit_logs")
      .select("*")
      .eq("user_id", userId)
      .gte("created_at", start.toISOString())
      .lte("created_at", end.toISOString())
      .order("created_at", { ascending: false })
      .limit(50);

    if (actionType && actionType !== "all") {
      query = query.eq("action", actionType);
    }

    const { data: logs, error } = await query;

    if (error || !logs || logs.length === 0) {
      return `No activity found for ${timePeriod.replace("_", " ")}.`;
    }

    // Group by record type (claims, tasks, etc.)
    const groupedActivity: Record<string, any[]> = {};
    for (const log of logs) {
      const key = log.record_type || "other";
      if (!groupedActivity[key]) groupedActivity[key] = [];
      groupedActivity[key].push(log);
    }

    // Get claim details for claim-related activities
    const claimIds = [...new Set(logs.filter((l: any) => l.record_type === "claim" && l.record_id).map((l: any) => l.record_id))];
    let claimNames: Record<string, string> = {};
    
    if (claimIds.length > 0) {
      const { data: claims } = await supabase
        .from("claims")
        .select("id, claim_number, policyholder_name")
        .in("id", claimIds);
      
      if (claims) {
        for (const claim of claims) {
          claimNames[claim.id] = `${claim.claim_number || 'N/A'} - ${claim.policyholder_name}`;
        }
      }
    }

    let result = `=== YOUR ACTIVITY (${timePeriod.replace("_", " ").toUpperCase()}) ===\n\n`;
    result += `Total activities: ${logs.length}\n\n`;

    for (const [recordType, activities] of Object.entries(groupedActivity)) {
      result += `--- ${recordType.toUpperCase()} (${activities.length} actions) ---\n`;
      
      for (const activity of activities.slice(0, 15)) {
        const date = new Date(activity.created_at).toLocaleString();
        const claimInfo = activity.record_id && claimNames[activity.record_id] 
          ? ` | Claim: ${claimNames[activity.record_id]}`
          : "";
        const details = activity.metadata ? ` | ${JSON.stringify(activity.metadata).substring(0, 100)}` : "";
        result += `• ${date} - ${activity.action}${claimInfo}${details}\n`;
      }
      result += "\n";
    }

    return result;
  } catch (err) {
    console.error("Error searching user activity:", err);
    return "Error searching activity logs.";
  }
}

// Generate claim number variations by stripping/adding dashes at common positions
function generateClaimNumberVariations(claimNumber: string): string[] {
  if (!claimNumber) return [];
  const variations = new Set<string>();
  // Original
  variations.add(claimNumber);
  // Fully stripped of dashes/hyphens
  const stripped = claimNumber.replace(/[-\s]/g, '');
  variations.add(stripped);
  // Common carrier formats: XX-XXXX-XXX, XX-XXXXXXX, etc.
  if (stripped.length >= 4) {
    // Try dash after first 2 chars
    variations.add(stripped.slice(0, 2) + '-' + stripped.slice(2));
    // Try dashes after 2 and 6 chars  
    if (stripped.length >= 7) {
      variations.add(stripped.slice(0, 2) + '-' + stripped.slice(2, 6) + '-' + stripped.slice(6));
    }
    // Try dash after first 4 chars
    variations.add(stripped.slice(0, 4) + '-' + stripped.slice(4));
  }
  return Array.from(variations);
}

// Helper function to search communications across all claims
async function searchCommunications(supabase: any, searchQuery: string, communicationType: string, timePeriod: string, claimName?: string, forceClaimId?: string): Promise<string> {
  try {
    const { start, end } = getDateRange(timePeriod);
    const results: any[] = [];

    // Use forced claim ID (from claim mode) or resolve from name
    let claimId: string | null = forceClaimId || null;
    let claimInfo = "";
    let claimNumber: string | null = null;
    if (!claimId && claimName) {
      const foundClaim = await findClaimByClientName(supabase, claimName);
      if (foundClaim) {
        claimId = foundClaim.id;
        claimNumber = foundClaim.claim_number;
        claimInfo = ` for claim ${foundClaim.claim_number} - ${foundClaim.policyholder_name}`;
      }
    } else if (claimId) {
      claimInfo = claimName ? ` for claim ${claimName}` : '';
      // Fetch claim number for variation matching
      const { data: claimData } = await supabase.from("claims").select("claim_number").eq("id", claimId).single();
      if (claimData) claimNumber = claimData.claim_number;
    }

    // Build search terms including claim number variations
    const searchTerms = [searchQuery];
    if (claimNumber) {
      const variations = generateClaimNumberVariations(claimNumber);
      // Only add variations that aren't already the search query
      for (const v of variations) {
        if (v.toLowerCase() !== searchQuery.toLowerCase()) {
          searchTerms.push(v);
        }
      }
    }

    // Search emails
    if (communicationType === "all" || communicationType === "emails") {
      let allEmails: any[] = [];

      // When scoped to a specific claim, ALWAYS fetch all emails for that claim first
      if (claimId) {
        const { data: claimEmails, error: claimEmailErr } = await supabase
          .from("emails")
          .select("*, claims!inner(claim_number, policyholder_name)")
          .eq("claim_id", claimId)
          .gte("created_at", start.toISOString())
          .lte("created_at", end.toISOString())
          .order("created_at", { ascending: false })
          .limit(50);
        
        if (claimEmailErr) console.error("Claim email fetch error:", claimEmailErr.message);
        if (claimEmails) allEmails = claimEmails;
      }

      // Also do text-based search (for cross-claim searches or additional filtering)
      if (!claimId || searchQuery) {
        const orParts: string[] = [];
        for (const term of searchTerms) {
          orParts.push(`subject.ilike.%${term}%`, `body.ilike.%${term}%`);
        }
        orParts.push(`recipient_email.ilike.%${searchQuery}%`, `recipient_name.ilike.%${searchQuery}%`);

        let emailQuery = supabase
          .from("emails")
          .select("*, claims!inner(claim_number, policyholder_name)")
          .or(orParts.join(','))
          .gte("created_at", start.toISOString())
          .lte("created_at", end.toISOString())
          .order("created_at", { ascending: false })
          .limit(20);

        if (claimId) emailQuery = emailQuery.eq("claim_id", claimId);

        const { data: searchEmails, error: searchErr } = await emailQuery;
        if (searchErr) console.error("Email search error:", searchErr.message);
        if (searchEmails) {
          // Merge without duplicates
          const existingIds = new Set(allEmails.map((e: any) => e.id));
          for (const e of searchEmails) {
            if (!existingIds.has(e.id)) allEmails.push(e);
          }
        }
      }

      // Deduplicate and format
      for (const email of allEmails) {
        const isInbound = email.recipient_type === 'inbound';
        
        // Extract sender info from body for inbound emails
        let senderInfo = '';
        if (isInbound && email.body) {
          // Try to extract sender from common email patterns in the body
          const fromMatch = email.body.match(/(?:^|\n)(?:From|from):\s*(.+?)(?:\n|<)/m);
          if (fromMatch) senderInfo = fromMatch[1].trim();
        }

        results.push({
          type: "Email",
          date: email.sent_at || email.created_at,
          claim: `${email.claims?.claim_number || 'N/A'} - ${email.claims?.policyholder_name || 'Unknown'}`,
          direction: isInbound ? "📥 Received" : "📤 Sent",
          summary: isInbound 
            ? `From: ${senderInfo || 'External'} → ${email.recipient_email || 'Unknown'} | Subject: ${email.subject}`
            : `To: ${email.recipient_email || email.recipient_name || 'Unknown'} (${email.recipient_type || 'unknown'}) | Subject: ${email.subject}`,
          content: email.body?.substring(0, 800)
        });
      }
    }

    // Search SMS
    if (communicationType === "all" || communicationType === "sms") {
      let smsQuery = supabase
        .from("sms_messages")
        .select("*, claims!inner(claim_number, policyholder_name)")
        .ilike("message", `%${searchQuery}%`)
        .gte("created_at", start.toISOString())
        .lte("created_at", end.toISOString())
        .order("created_at", { ascending: false })
        .limit(20);

      if (claimId) {
        smsQuery = smsQuery.eq("claim_id", claimId);
      }

      const { data: sms } = await smsQuery;
      if (sms) {
        for (const msg of sms) {
          results.push({
            type: "SMS",
            date: msg.created_at,
            claim: `${msg.claims?.claim_number || 'N/A'} - ${msg.claims?.policyholder_name || 'Unknown'}`,
            direction: msg.direction === "inbound" ? "Received" : "Sent",
            summary: `${msg.direction === "inbound" ? "From" : "To"}: ${msg.phone_number}`,
            content: msg.message?.substring(0, 300)
          });
        }
      }
    }

    // Search claim notes/updates
    if (communicationType === "all" || communicationType === "notes") {
      let notesQuery = supabase
        .from("claim_updates")
        .select("*, claims!inner(claim_number, policyholder_name)")
        .ilike("content", `%${searchQuery}%`)
        .gte("created_at", start.toISOString())
        .lte("created_at", end.toISOString())
        .order("created_at", { ascending: false })
        .limit(20);

      if (claimId) {
        notesQuery = notesQuery.eq("claim_id", claimId);
      }

      const { data: notes } = await notesQuery;
      if (notes) {
        for (const note of notes) {
          results.push({
            type: "Note",
            date: note.created_at,
            claim: `${note.claims?.claim_number || 'N/A'} - ${note.claims?.policyholder_name || 'Unknown'}`,
            direction: "Internal",
            summary: `Note added`,
            content: note.content?.substring(0, 300)
          });
        }
      }
    }

    // Search communications diary
    if (communicationType === "all" || communicationType === "communications_diary") {
      let diaryQuery = supabase
        .from("claim_communications_diary")
        .select("*, claims!inner(claim_number, policyholder_name)")
        .or(`summary.ilike.%${searchQuery}%,contact_name.ilike.%${searchQuery}%,promises_made.ilike.%${searchQuery}%,deadlines_mentioned.ilike.%${searchQuery}%`)
        .gte("created_at", start.toISOString())
        .lte("created_at", end.toISOString())
        .order("communication_date", { ascending: false })
        .limit(20);

      if (claimId) {
        diaryQuery = diaryQuery.eq("claim_id", claimId);
      }

      const { data: diary } = await diaryQuery;
      if (diary) {
        for (const entry of diary) {
          results.push({
            type: `Diary (${entry.communication_type})`,
            date: entry.communication_date,
            claim: `${entry.claims?.claim_number || 'N/A'} - ${entry.claims?.policyholder_name || 'Unknown'}`,
            direction: entry.direction === "inbound" ? "Received" : "Outbound",
            summary: `Contact: ${entry.contact_name || 'Unknown'} (${entry.contact_company || 'N/A'})`,
            content: entry.summary?.substring(0, 300),
            promises: entry.promises_made,
            deadlines: entry.deadlines_mentioned
          });
        }
      }
    }

    if (results.length === 0) {
      return `No communications found matching "${searchQuery}"${claimInfo} in ${timePeriod.replace("_", " ")}.`;
    }

    // Sort by date
    results.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    let output = `=== COMMUNICATIONS SEARCH: "${searchQuery}"${claimInfo} ===\n`;
    output += `Time period: ${timePeriod.replace("_", " ")} | Found: ${results.length} results\n\n`;

    for (const result of results.slice(0, 25)) {
      const date = new Date(result.date).toLocaleString();
      output += `📨 ${result.type} | ${date}\n`;
      output += `   Claim: ${result.claim}\n`;
      output += `   ${result.direction}: ${result.summary}\n`;
      if (result.content) {
        output += `   Content: ${result.content}...\n`;
      }
      if (result.promises) {
        output += `   ⚠️ Promises Made: ${result.promises}\n`;
      }
      if (result.deadlines) {
        output += `   📅 Deadlines: ${result.deadlines}\n`;
      }
      output += "\n";
    }

    // Auto-add found communications to the claim timeline if in claim mode
    if (claimId && results.length > 0) {
      let addedCount = 0;
      for (const result of results) {
        if (result.type === "Email") {
          // Check if this email is already logged in claim_updates
          const contentPreview = `[Darwin Found] ${result.direction} Email — ${result.summary}`;
          const { data: existing } = await supabase
            .from("claim_updates")
            .select("id")
            .eq("claim_id", claimId)
            .eq("update_type", "communication_log")
            .ilike("content", `%${result.summary.substring(0, 60)}%`)
            .limit(1);

          if (!existing || existing.length === 0) {
            const timelineContent = `${contentPreview}\nDate: ${new Date(result.date).toLocaleString()}\n${result.content ? 'Preview: ' + result.content.substring(0, 400) : ''}`;
            await supabase.from("claim_updates").insert({
              claim_id: claimId,
              update_type: "communication_log",
              content: timelineContent,
              created_at: result.date
            });
            addedCount++;
          }
        }
      }
      if (addedCount > 0) {
        output += `\n✅ Added ${addedCount} communication(s) to the claim timeline.\n`;
      }
    }

    return output;
  } catch (err) {
    console.error("Error searching communications:", err);
    return "Error searching communications.";
  }
}

// Helper function to search claim history and timeline
async function searchClaimHistory(supabase: any, searchQuery: string, eventType: string, timePeriod: string, claimName?: string, forceClaimId?: string): Promise<string> {
  try {
    const { start, end } = getDateRange(timePeriod);
    const events: any[] = [];

    // Use forced claim ID (from claim mode) or resolve from name
    let claimId: string | null = forceClaimId || null;
    let claimInfo = "";
    if (!claimId && claimName) {
      const foundClaim = await findClaimByClientName(supabase, claimName);
      if (foundClaim) {
        claimId = foundClaim.id;
        claimInfo = ` for ${foundClaim.claim_number} - ${foundClaim.policyholder_name}`;
      }
    } else if (claimId && claimName) {
      claimInfo = ` for ${claimName}`;
    }

    // Search claim updates/notes
    if (eventType === "all" || eventType === "notes_added") {
      let query = supabase
        .from("claim_updates")
        .select("*, claims!inner(claim_number, policyholder_name)")
        .gte("created_at", start.toISOString())
        .lte("created_at", end.toISOString())
        .order("created_at", { ascending: false })
        .limit(30);

      if (claimId) query = query.eq("claim_id", claimId);
      if (searchQuery) query = query.ilike("content", `%${searchQuery}%`);

      const { data } = await query;
      if (data) {
        for (const item of data) {
          events.push({
            type: "Note Added",
            date: item.created_at,
            claim: `${item.claims?.claim_number} - ${item.claims?.policyholder_name}`,
            description: item.content?.substring(0, 200)
          });
        }
      }
    }

    // Search file uploads
    if (eventType === "all" || eventType === "files_uploaded") {
      let query = supabase
        .from("claim_files")
        .select("*, claims!inner(claim_number, policyholder_name)")
        .gte("uploaded_at", start.toISOString())
        .lte("uploaded_at", end.toISOString())
        .order("uploaded_at", { ascending: false })
        .limit(30);

      if (claimId) query = query.eq("claim_id", claimId);
      if (searchQuery) query = query.ilike("file_name", `%${searchQuery}%`);

      const { data } = await query;
      if (data) {
        for (const item of data) {
          events.push({
            type: "File Uploaded",
            date: item.uploaded_at,
            claim: `${item.claims?.claim_number} - ${item.claims?.policyholder_name}`,
            description: `${item.file_name} (${item.document_classification || item.file_type || 'unknown type'})`
          });
        }
      }
    }

    // Search tasks created
    if (eventType === "all" || eventType === "tasks_created") {
      let query = supabase
        .from("tasks")
        .select("*, claims!inner(claim_number, policyholder_name)")
        .gte("created_at", start.toISOString())
        .lte("created_at", end.toISOString())
        .order("created_at", { ascending: false })
        .limit(30);

      if (claimId) query = query.eq("claim_id", claimId);
      if (searchQuery) query = query.or(`title.ilike.%${searchQuery}%,description.ilike.%${searchQuery}%`);

      const { data } = await query;
      if (data) {
        for (const item of data) {
          events.push({
            type: "Task Created",
            date: item.created_at,
            claim: `${item.claims?.claim_number} - ${item.claims?.policyholder_name}`,
            description: `${item.title} | Status: ${item.status} | Priority: ${item.priority || 'normal'}`
          });
        }
      }
    }

    // Search inspections
    if (eventType === "all" || eventType === "inspections") {
      let query = supabase
        .from("inspections")
        .select("*, claims!inner(claim_number, policyholder_name)")
        .gte("created_at", start.toISOString())
        .lte("created_at", end.toISOString())
        .order("created_at", { ascending: false })
        .limit(30);

      if (claimId) query = query.eq("claim_id", claimId);

      const { data } = await query;
      if (data) {
        for (const item of data) {
          events.push({
            type: "Inspection",
            date: item.inspection_date || item.created_at,
            claim: `${item.claims?.claim_number} - ${item.claims?.policyholder_name}`,
            description: `${item.inspection_type} | Status: ${item.status}`
          });
        }
      }
    }

    // Search payments/checks
    if (eventType === "all" || eventType === "payments") {
      let query = supabase
        .from("claim_checks")
        .select("*, claims!inner(claim_number, policyholder_name)")
        .gte("created_at", start.toISOString())
        .lte("created_at", end.toISOString())
        .order("created_at", { ascending: false })
        .limit(30);

      if (claimId) query = query.eq("claim_id", claimId);

      const { data } = await query;
      if (data) {
        for (const item of data) {
          events.push({
            type: "Payment Received",
            date: item.check_date || item.created_at,
            claim: `${item.claims?.claim_number} - ${item.claims?.policyholder_name}`,
            description: `$${item.amount?.toLocaleString()} | ${item.check_type} | Check #${item.check_number || 'N/A'}`
          });
        }
      }
    }

    // Search emails
    if (eventType === "all" || eventType === "emails") {
      let query = supabase
        .from("emails")
        .select("*, claims!inner(claim_number, policyholder_name)")
        .gte("created_at", start.toISOString())
        .lte("created_at", end.toISOString())
        .order("created_at", { ascending: false })
        .limit(30);

      if (claimId) query = query.eq("claim_id", claimId);
      if (searchQuery) query = query.or(`subject.ilike.%${searchQuery}%,body.ilike.%${searchQuery}%`);

      const { data } = await query;
      if (data) {
        for (const item of data) {
          events.push({
            type: item.sent_by ? "Email Sent" : "Email Received",
            date: item.created_at || item.sent_at,
            claim: `${item.claims?.claim_number} - ${item.claims?.policyholder_name}`,
            description: `Subject: ${item.subject} | To: ${item.recipient_email || item.recipient_name || 'Unknown'}`
          });
        }
      }
    }

    if (events.length === 0) {
      return `No events found${claimInfo} in ${timePeriod.replace("_", " ")}${searchQuery ? ` matching "${searchQuery}"` : ""}.`;
    }

    // Sort by date
    events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    let output = `=== CLAIM HISTORY${claimInfo} ===\n`;
    output += `Time period: ${timePeriod.replace("_", " ")} | Found: ${events.length} events\n\n`;

    for (const event of events.slice(0, 40)) {
      const date = new Date(event.date).toLocaleString();
      output += `📌 ${event.type} | ${date}\n`;
      output += `   Claim: ${event.claim}\n`;
      output += `   ${event.description}\n\n`;
    }

    return output;
  } catch (err) {
    console.error("Error searching claim history:", err);
    return "Error searching claim history.";
  }
}

// Helper function to get adjuster interactions across all claims
async function getAdjusterInteractions(supabase: any, adjusterName: string, includeEmails: boolean, includeNotes: boolean, includeDiary: boolean): Promise<string> {
  try {
    const interactions: any[] = [];

    // Find claims with this adjuster
    const { data: claims } = await supabase
      .from("claims")
      .select("id, claim_number, policyholder_name, adjuster_name, adjuster_phone, adjuster_email")
      .ilike("adjuster_name", `%${adjusterName}%`);

    // Also check claim_adjusters table
    const { data: claimAdjusters } = await supabase
      .from("claim_adjusters")
      .select("*, claims!inner(id, claim_number, policyholder_name)")
      .ilike("adjuster_name", `%${adjusterName}%`);

    const allClaimIds: string[] = [];
    const claimDetails: Record<string, string> = {};

    if (claims) {
      for (const claim of claims) {
        allClaimIds.push(claim.id);
        claimDetails[claim.id] = `${claim.claim_number} - ${claim.policyholder_name}`;
      }
    }

    if (claimAdjusters) {
      for (const ca of claimAdjusters) {
        if (!allClaimIds.includes(ca.claims.id)) {
          allClaimIds.push(ca.claims.id);
          claimDetails[ca.claims.id] = `${ca.claims.claim_number} - ${ca.claims.policyholder_name}`;
        }
      }
    }

    if (allClaimIds.length === 0) {
      return `No claims found with adjuster "${adjusterName}".`;
    }

    // Get emails mentioning the adjuster
    if (includeEmails) {
      const { data: emails } = await supabase
        .from("emails")
        .select("*")
        .in("claim_id", allClaimIds)
        .order("created_at", { ascending: false })
        .limit(30);

      if (emails) {
        for (const email of emails) {
          interactions.push({
            type: email.direction === "inbound" ? "Email Received" : "Email Sent",
            date: email.created_at,
            claim: claimDetails[email.claim_id] || "Unknown",
            content: `Subject: ${email.subject}\n${email.body?.substring(0, 200)}...`
          });
        }
      }
    }

    // Get notes mentioning the adjuster
    if (includeNotes) {
      const { data: notes } = await supabase
        .from("claim_updates")
        .select("*")
        .in("claim_id", allClaimIds)
        .or(`content.ilike.%${adjusterName}%,content.ilike.%adjuster%`)
        .order("created_at", { ascending: false })
        .limit(30);

      if (notes) {
        for (const note of notes) {
          interactions.push({
            type: "Note",
            date: note.created_at,
            claim: claimDetails[note.claim_id] || "Unknown",
            content: note.content?.substring(0, 200)
          });
        }
      }
    }

    // Get communications diary entries
    if (includeDiary) {
      const { data: diary } = await supabase
        .from("claim_communications_diary")
        .select("*")
        .in("claim_id", allClaimIds)
        .order("communication_date", { ascending: false })
        .limit(30);

      if (diary) {
        for (const entry of diary) {
          interactions.push({
            type: `Diary (${entry.communication_type})`,
            date: entry.communication_date,
            claim: claimDetails[entry.claim_id] || "Unknown",
            content: `Contact: ${entry.contact_name} | ${entry.summary}${entry.promises_made ? `\nPromises: ${entry.promises_made}` : ""}${entry.deadlines_mentioned ? `\nDeadlines: ${entry.deadlines_mentioned}` : ""}`
          });
        }
      }
    }

    // Sort by date
    interactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    let output = `=== INTERACTIONS WITH ADJUSTER: ${adjusterName.toUpperCase()} ===\n\n`;
    output += `Claims involving this adjuster: ${allClaimIds.length}\n`;
    output += `Total interactions found: ${interactions.length}\n\n`;

    output += `--- CLAIMS ---\n`;
    for (const claimId of allClaimIds) {
      output += `• ${claimDetails[claimId]}\n`;
    }
    output += "\n";

    output += `--- INTERACTION TIMELINE ---\n\n`;
    for (const interaction of interactions.slice(0, 30)) {
      const date = new Date(interaction.date).toLocaleString();
      output += `📋 ${interaction.type} | ${date}\n`;
      output += `   Claim: ${interaction.claim}\n`;
      output += `   ${interaction.content}\n\n`;
    }

    return output;
  } catch (err) {
    console.error("Error getting adjuster interactions:", err);
    return "Error searching adjuster interactions.";
  }
}

// Helper function to find workspace by name
async function findWorkspaceByName(supabase: any, workspaceName: string): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase
    .from("workspaces")
    .select("id, name")
    .ilike("name", `%${workspaceName}%`)
    .limit(1);
  
  if (data && data.length > 0) {
    return { id: data[0].id, name: data[0].name };
  }
  return null;
}

// Helper function to resolve claims by contractor name
async function resolveClaimsByContractor(supabase: any, contractorName: string): Promise<{ id: string; name: string }[]> {
  // Find the contractor by name
  const { data: contractors } = await supabase
    .from("profiles")
    .select("id, full_name")
    .ilike("full_name", `%${contractorName}%`);
  
  if (!contractors || contractors.length === 0) return [];
  
  const contractorIds = contractors.map((c: any) => c.id);
  
  // Get claims assigned to this contractor
  const { data: assignments } = await supabase
    .from("claim_contractors")
    .select("claim_id")
    .in("contractor_id", contractorIds);
  
  if (!assignments || assignments.length === 0) return [];
  
  const claimIds = assignments.map((a: any) => a.claim_id);
  
  const { data: claims } = await supabase
    .from("claims")
    .select("id, policyholder_name")
    .in("id", claimIds);
  
  return (claims || []).map((c: any) => ({ id: c.id, name: c.policyholder_name || "Unknown" }));
}

// Helper function for bulk share to workspace
async function bulkShareToWorkspace(supabase: any, claimIds: string[], workspaceId: string): Promise<{ success: number; failed: number }> {
  const { error } = await supabase
    .from("claims")
    .update({ workspace_id: workspaceId })
    .in("id", claimIds);
  
  if (error) {
    console.error("Error bulk sharing to workspace:", error);
    return { success: 0, failed: claimIds.length };
  }
  return { success: claimIds.length, failed: 0 };
}

// Helper function to add item to user's notepad
async function addNotepadItem(supabase: any, userId: string, item: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if user already has a note
    const { data: existingNote } = await supabase
      .from("user_notes")
      .select("id, content")
      .eq("user_id", userId)
      .single();

    if (existingNote) {
      // Parse existing content and add new item
      let items: string[] = [];
      try {
        items = JSON.parse(existingNote.content);
        if (!Array.isArray(items)) items = [];
      } catch {
        // If it's plain text, convert to array
        items = existingNote.content ? existingNote.content.split('\n').filter((l: string) => l.trim()) : [];
      }
      
      items.push(item);
      
      const { error } = await supabase
        .from("user_notes")
        .update({ content: JSON.stringify(items), updated_at: new Date().toISOString() })
        .eq("id", existingNote.id);
      
      if (error) {
        console.error("Error updating notepad:", error);
        return { success: false, error: error.message };
      }
    } else {
      // Create new note with the item
      const { error } = await supabase
        .from("user_notes")
        .insert({ user_id: userId, content: JSON.stringify([item]) });
      
      if (error) {
        console.error("Error creating notepad:", error);
        return { success: false, error: error.message };
      }
    }
    
    return { success: true };
  } catch (err) {
    console.error("Exception adding notepad item:", err);
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// Helper function to get staff members for assignment
async function getStaffMembers(supabase: any): Promise<{ id: string; name: string; email: string }[]> {
  try {
    const { data: staffRoles } = await supabase
      .from("user_roles")
      .select("user_id")
      .in("role", ["staff", "admin"]);

    if (!staffRoles || staffRoles.length === 0) return [];

    const staffIds = staffRoles.map((r: any) => r.user_id);

    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("id", staffIds)
      .eq("approval_status", "approved");

    return (profiles || []).map((p: any) => ({
      id: p.id,
      name: p.full_name || p.email,
      email: p.email
    }));
  } catch (err) {
    console.error("Error fetching staff:", err);
    return [];
  }
}

// Helper: get claim financial summary (paid, outstanding, depreciation, by coverage) from DB
async function getClaimFinancialSummary(supabase: any, claimId: string): Promise<string> {
  try {
    const { data: settlement } = await supabase
      .from("claim_settlements")
      .select("*")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: payments } = await supabase
      .from("claim_payments")
      .select("amount, payment_date, payment_method")
      .eq("claim_id", claimId);

    const { data: checks } = await supabase
      .from("claim_checks")
      .select("amount, check_type, check_date")
      .eq("claim_id", claimId);

    let totalPaid = 0;
    if (payments?.length) {
      totalPaid += payments.reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
    }
    if (checks?.length) {
      totalPaid += checks.reduce((s: number, c: any) => s + Number(c.amount || 0), 0);
    }

    const rcv = settlement?.replacement_cost_value != null ? Number(settlement.replacement_cost_value) : 0;
    const recDep = settlement?.recoverable_depreciation != null ? Number(settlement.recoverable_depreciation) : 0;
    const nonRecDep = settlement?.non_recoverable_depreciation != null ? Number(settlement.non_recoverable_depreciation) : 0;
    const deductible = settlement?.deductible != null ? Number(settlement.deductible) : 0;
    const totalOutstanding = Math.max(0, rcv - totalPaid);

    const lines: string[] = [];
    lines.push("Total paid: $" + totalPaid.toLocaleString("en-US", { minimumFractionDigits: 2 }));
    lines.push("Total outstanding: $" + totalOutstanding.toLocaleString("en-US", { minimumFractionDigits: 2 }));
    if (recDep > 0 || nonRecDep > 0) {
      lines.push("Recoverable depreciation: $" + recDep.toLocaleString("en-US", { minimumFractionDigits: 2 }));
      lines.push("Non-recoverable depreciation: $" + nonRecDep.toLocaleString("en-US", { minimumFractionDigits: 2 }));
    }
    if (deductible > 0) {
      lines.push("Deductible: $" + deductible.toLocaleString("en-US", { minimumFractionDigits: 2 }));
    }
    if (settlement?.other_structures_rcv > 0 || settlement?.personal_property_rcv > 0 || settlement?.pwi_rcv > 0) {
      lines.push("");
      lines.push("By coverage (RCV):");
      if (rcv > 0) lines.push("  Dwelling: $" + rcv.toLocaleString("en-US", { minimumFractionDigits: 2 }));
      if (settlement?.other_structures_rcv > 0) lines.push("  Other structures: $" + Number(settlement.other_structures_rcv).toLocaleString("en-US", { minimumFractionDigits: 2 }));
      if (settlement?.personal_property_rcv > 0) lines.push("  Contents: $" + Number(settlement.personal_property_rcv).toLocaleString("en-US", { minimumFractionDigits: 2 }));
      if (settlement?.pwi_rcv > 0) lines.push("  PWI / Ordinance: $" + Number(settlement.pwi_rcv).toLocaleString("en-US", { minimumFractionDigits: 2 }));
    }
    return lines.join("\n");
  } catch (e) {
    console.error("getClaimFinancialSummary error:", e);
    return "Unable to load financial summary for this claim.";
  }
}

// === CROSS-CLAIM PRECEDENT SEARCH (2-STEP PIPELINE) ===

// Deny-list: suppress procedural/low-value chunks even if similarity is high
const PROCEDURAL_PATTERNS = [
  /please send (photos|documents|info)/i,
  /attached (please find|are the|is the)/i,
  /thank you for (your|sending|providing)/i,
  /we (received|acknowledge|have received) your/i,
  /per our (conversation|phone call|discussion)/i,
  /^(dear|to whom|hi |hello )/i,
  /please (contact|call|reach out|let us know)/i,
  /^(sincerely|regards|best|thank)/i,
  /this (email|letter) (is to|confirms|serves)/i,
];

function isProceduralChunk(content: string): boolean {
  const trimmed = content.trim();
  // Very short chunks are often greetings/signatures
  if (trimmed.length < 80) return true;
  // Check procedural patterns
  return PROCEDURAL_PATTERNS.some(p => p.test(trimmed));
}

// Determine relevance explanation for an evidence card
function buildRelevanceExplanation(card: any, currentClaim: any): string {
  const parts: string[] = [];
  if (card.carrier_name && currentClaim?.insurance_company &&
      card.carrier_name.toLowerCase() === currentClaim.insurance_company.toLowerCase()) {
    parts.push('same carrier');
  }
  if (card.denial_rationale) parts.push(`denial rationale: "${card.denial_rationale}"`);
  if (card.trade) parts.push(`trade: ${card.trade}`);
  if (card.loss_type) parts.push(`peril: ${card.loss_type}`);
  if (card.state_code) {
    const claimState = extractState(currentClaim?.policyholder_address || '');
    if (claimState && card.state_code === claimState) {
      parts.push('same state');
    } else if (claimState && card.state_code !== claimState) {
      parts.push(`STATE MISMATCH (${card.state_code} vs ${claimState})`);
    }
  }
  if (card.cited_policy_sections?.length) parts.push(`policy sections: ${card.cited_policy_sections.join(', ')}`);
  return parts.length > 0 ? parts.join(' · ') : 'semantic similarity';
}

function extractState(address: string): string | null {
  const m = (address || '').match(/\b([A-Z]{2})\b\s*\d{5}/);
  return m ? m[1] : null;
}

// Determine "what worked" from outcome data
function buildWhatWorked(card: any): string {
  const tactics: string[] = [];
  if (card.decision_type === 'accept' || card.outcome_resolution_type === 'settled') {
    if (card.evidence_type === 'engineer_report') tactics.push('engineer rebuttal');
    if (card.evidence_type === 'estimate') tactics.push('scope/estimate challenge');
    if (card.evidence_type === 'denial_letter') tactics.push('denial rebuttal submitted');
    if (card.outcome_supplement_won) tactics.push('supplement approved');
    if (card.outcome_appraisal_invoked) tactics.push('appraisal invoked');
    if (card.outcome_litigation) tactics.push('litigation filed');
    if (card.outcome_reopened) tactics.push('claim reopened successfully');
  }
  if (card.outcome_paid_amount && card.outcome_paid_amount > 0) {
    tactics.push(`paid $${card.outcome_paid_amount.toLocaleString()}`);
  }
  if (card.outcome_resolution_type) tactics.push(`resolution: ${card.outcome_resolution_type}`);
  return tactics.length > 0 ? tactics.join(' | ') : 'outcome data not yet captured';
}

// === PHASE 4: Escalation Trigger Evaluation for PA/NJ ===
// FIX #1: Robust state detection with word-boundary regex (avoids APARTMENT/PARK false positives)
function detectStateCode(claim: any): string | null {
  // Prefer structured field
  const structured = (claim?.client_state || claim?.property_state || '').toUpperCase().trim();
  if (structured === 'PA' || structured === 'PENNSYLVANIA') return 'PA';
  if (structured === 'NJ' || structured === 'NEW JERSEY') return 'NJ';

  const address = (claim?.policyholder_address || '');
  if (!address) return null;

  // ZIP-based detection (most reliable): "NJ 08050" or "PA 19103"
  const zipMatch = address.toUpperCase().match(/\b([A-Z]{2})\s+\d{5}\b/);
  if (zipMatch) {
    if (zipMatch[1] === 'PA') return 'PA';
    if (zipMatch[1] === 'NJ') return 'NJ';
  }

  // Word-boundary regex patterns (avoids APARTMENT, PARK, PATRICIA false positives)
  if (/(^|[\s,])PA([\s,]|$)/i.test(address) || /\bPENNSYLVANIA\b/i.test(address)) return 'PA';
  if (/(^|[\s,])NJ([\s,]|$)/i.test(address) || /\bNEW\s+JERSEY\b/i.test(address)) return 'NJ';

  return null;
}

// FIX #6: Cap and bound constants for prompt injection guard
const MAX_ESCALATION_RULES_INJECTED = 5;
const MAX_ESCALATION_CONTEXT_CHARS = 3000;

async function getEscalationContext(
  supabase: any, claim: any, claimId: string
): Promise<string> {
  try {
    const stateCode = detectStateCode(claim);
    if (!stateCode) return '';

    // Load rules for this state
    const { data: rules } = await supabase
      .from('escalation_trigger_rules')
      .select('*')
      .eq('state_code', stateCode)
      .eq('is_active', true)
      .order('priority_order');

    if (!rules || rules.length === 0) return '';

    // Load claim deadlines
    const [deadlinesRes, carrierDeadlinesRes] = await Promise.all([
      supabase.from('claim_deadlines').select('deadline_type, status').eq('claim_id', claimId),
      supabase.from('claim_carrier_deadlines').select('deadline_type, status, days_overdue, bad_faith_potential').eq('claim_id', claimId),
    ]);

    const deadlines = deadlinesRes.data || [];
    const carrierDeadlines = carrierDeadlinesRes.data || [];
    const missedCount = carrierDeadlines.filter((d: any) => d.status === 'overdue' || d.status === 'missed').length;
    const hasCoverageDetermination = carrierDeadlines.some((d: any) => d.deadline_type === 'coverage_determination' && d.status === 'met');
    
    const createdAt = claim?.created_at ? new Date(claim.created_at) : new Date();
    const daysSinceFiled = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
    const coverageAccepted = claim?.status === 'Coverage Accepted' || claim?.status === 'Supplement Submitted';
    const scopeDisputed = claim?.status === 'Supplement Submitted' || claim?.status === 'Under Review';

    // Deterministic rule evaluation
    const firedRules: any[] = [];
    for (const rule of rules) {
      const c = rule.condition_logic || {};
      let fires = true;

      if (c.days_since_claim_filed_gt && daysSinceFiled <= c.days_since_claim_filed_gt) fires = false;
      if (c.no_coverage_determination && hasCoverageDetermination) fires = false;
      if (c.coverage_accepted && !coverageAccepted) fires = false;
      if (c.scope_disputed && !scopeDisputed) fires = false;
      if (c.missed_deadlines_gt && missedCount <= c.missed_deadlines_gt) fires = false;

      // FIX #3: deadline_status_not means "suppress rule if any deadline of this type HAS this status"
      if (c.deadline_type && c.deadline_status_not) {
        const allDl = [...deadlines, ...carrierDeadlines];
        const matching = allDl.filter((d: any) => d.deadline_type === c.deadline_type);
        if (matching.some((d: any) => d.status === c.deadline_status_not)) fires = false;
      }

      if (fires) firedRules.push(rule);
    }

    if (firedRules.length === 0) return '';

    // Sort by strength priority
    const strengthOrder: Record<string, number> = { regulatory_leverage: 0, formal_leverage: 1, soft_leverage: 2 };
    firedRules.sort((a: any, b: any) => (strengthOrder[a.escalation_strength] ?? 3) - (strengthOrder[b.escalation_strength] ?? 3));

    // FIX #6: Cap injected rules to prevent context overflow
    const cappedRules = firedRules.slice(0, MAX_ESCALATION_RULES_INJECTED);

    // Build structured context for injection
    let context = '\n\n=== REGULATORY LEVERAGE CONTEXT (' + stateCode + ') ===\n';
    context += 'ACTIVE TRIGGERS: ' + cappedRules.length + ' of ' + firedRules.length + ' total.\n';
    context += 'AUTHORITY CITATION RULES:\n';
    context += '- Cite statute short reference + plain-language summary.\n';
    context += '- Recommend procedural next steps only — never threats, accusations, or legal advice.\n';
    context += '- Label escalation strength (soft/formal/regulatory).\n';
    context += '- Tone: Strategic and controlled.\n\n';

    for (const rule of cappedRules) {
      const entry = `[${rule.escalation_strength.toUpperCase().replace('_', ' ')}] ${rule.trigger_name}\n` +
        `  Citation: ${rule.regulation_citation}\n` +
        `  Summary: ${rule.regulation_summary}\n` +
        `  Action: ${rule.recommended_action}\n` +
        (rule.recommended_artifact ? `  Artifact: ${rule.recommended_artifact}\n` : '') + '\n';
      
      // FIX #6: Stop if we'd exceed max chars
      if (context.length + entry.length > MAX_ESCALATION_CONTEXT_CHARS) break;
      context += entry;
    }

    context += '=== END REGULATORY LEVERAGE CONTEXT ===\n';
    console.log(`[Escalation] Injected ${cappedRules.length}/${firedRules.length} fired triggers for ${stateCode}`);
    return context;
  } catch (err) {
    console.error('[Escalation] Evaluation error:', err);
    return '';
  }
}


async function getCarrierPlaybookContext(
  supabase: any, claim: any
): Promise<string> {
  try {
    const carrier = claim?.insurance_company;
    if (!carrier) return '';

    const stateMatch = (claim?.policyholder_address || '').match(/\b([A-Z]{2})\b\s*\d{5}/);
    const state = stateMatch ? stateMatch[1] : (claim?.property_state || null);

    // Tier 1: Exact carrier + state
    let { data: playbooks } = await supabase
      .from('carrier_scenario_playbooks')
      .select('*')
      .eq('carrier', carrier)
      .order('sample_size_total', { ascending: false })
      .limit(5);

    if (!playbooks || playbooks.length === 0) {
      // Tier 2: Fuzzy carrier match
      const { data: fuzzy } = await supabase
        .from('carrier_scenario_playbooks')
        .select('*')
        .ilike('carrier', `%${carrier.split(' ')[0]}%`)
        .order('sample_size_total', { ascending: false })
        .limit(3);
      playbooks = fuzzy || [];
    }

    if (playbooks.length === 0) {
      console.log('[Playbook] No playbook data for carrier:', carrier);
      return '';
    }

    // Fetch tactics for top playbooks
    const scenarioKeys = playbooks.map((p: any) => p.scenario_key);
    const { data: allTactics } = await supabase
      .from('carrier_scenario_tactics')
      .select('*')
      .in('scenario_key', scenarioKeys)
      .order('recency_weighted_score', { ascending: false });

    const tacticsByKey: Record<string, any[]> = {};
    for (const t of (allTactics || [])) {
      if (!tacticsByKey[t.scenario_key]) tacticsByKey[t.scenario_key] = [];
      if (tacticsByKey[t.scenario_key].length < 5) {
        tacticsByKey[t.scenario_key].push(t);
      }
    }

    let context = '\n\n=== CARRIER × SCENARIO PLAYBOOK (DATA-DRIVEN) ===\n';
    context += 'These are outcome-based playbook entries from historical closed claims. Use them to inform your recommendations.\n';
    context += 'RULES:\n';
    context += '- You MUST cite confidence + sample size when referencing playbook data.\n';
    context += '- A tactic can only be called "proven" if support_count >= 5.\n';
    context += '- If support_count < 5, label it as "hypothesis / low data".\n';
    context += '- If the exact scenario match has low data, clearly state: "Exact match low data; broadened to [description]."\n\n';

    for (const pb of playbooks) {
      const isExactState = pb.state_code === state;
      const matchTag = isExactState ? 'EXACT' : (pb.state_code ? `STATE MISMATCH (${pb.state_code} vs ${state})` : 'ANY STATE');

      context += `--- PLAYBOOK ENTRY [${matchTag}] ---\n`;
      context += `Carrier: ${pb.carrier} | State: ${pb.state_code || 'any'} | Trade: ${pb.trade || 'any'} | Loss: ${pb.loss_type || 'any'}\n`;
      context += `Denial Rationale: ${pb.denial_rationale || 'any'} | Decision: ${pb.decision_type || 'any'}\n`;
      context += `Win Rate: ${pb.win_rate}% | Avg Delta: $${pb.avg_indemnity_delta || 0} | Sample: ${pb.sample_size_total} (12mo: ${pb.sample_size_recent_12mo})\n`;
      context += `Confidence: ${pb.confidence_label} (score ${pb.confidence_score})\n`;

      const paths = pb.top_resolution_paths || [];
      if (paths.length > 0) {
        context += `Resolution Paths: ${paths.map((p: any) => `${p.path} ${p.pct}%`).join(', ')}\n`;
      }

      const tactics = tacticsByKey[pb.scenario_key] || [];
      if (tactics.length > 0) {
        context += 'Top Tactics:\n';
        for (const t of tactics) {
          const proven = t.support_count >= 5 ? 'PROVEN' : 'LOW DATA';
          context += `  - ${t.tactic_name} (${t.tactic_type}) [${proven}, n=${t.support_count}] `;
          if (t.success_lift) context += `lift: ${t.success_lift > 0 ? '+' : ''}${t.success_lift}% `;
          if (t.median_delta_when_present) context += `median: $${t.median_delta_when_present} `;
          context += '\n';
        }
      }
      context += '--- END ENTRY ---\n\n';
    }

    context += '=== END PLAYBOOK ===\n';
    context += 'INSTRUCTION: When recommending tactics, prioritize those with highest support_count and positive success_lift from the playbook. Always cite the confidence level and sample size.\n';

    console.log(`[Playbook] Injected ${playbooks.length} playbook entries for ${carrier}`);
    return context;
  } catch (err) {
    console.error('[Playbook] Retrieval error:', err);
    return '';
  }
}

async function searchCrossClaimPrecedents(
  supabase: any, question: string, currentClaimId: string, claim: any
): Promise<string> {
  try {
    // Generate embedding for the question
    const queryEmbedding = await getQueryEmbedding(question);
    if (!queryEmbedding) {
      console.log('[CrossClaim] No embedding generated, skipping');
      return '';
    }

    // === STEP 1: Structured taxonomy filter ===
    // Build aggressive filters from claim context
    const carrierName = claim?.insurance_company || null;
    const claimLossType = claim?.loss_type ? claim.loss_type.toLowerCase() : null;
    const claimState = extractState(claim?.policyholder_address || '');
    
    // Detect query-specific filters from the question text
    const questionLower = (question || '').toLowerCase();
    let queryTrade: string | null = null;
    let queryDecision: string | null = null;
    const tradeKeywords: Record<string, string> = {
      'roof': 'roof', 'shingle': 'roof', 'siding': 'siding', 'gutter': 'gutters',
      'window': 'windows', 'interior': 'interior', 'drywall': 'interior',
      'hvac': 'hvac', 'plumbing': 'plumbing', 'fence': 'fence',
    };
    for (const [kw, trade] of Object.entries(tradeKeywords)) {
      if (questionLower.includes(kw)) { queryTrade = trade; break; }
    }
    if (/denial|denied|deny/i.test(questionLower)) queryDecision = 'deny_full';
    if (/partial/i.test(questionLower)) queryDecision = 'deny_partial';

    // TIER 1: Narrow search — same carrier + same loss type + filters
    const { data: tier1Results } = await supabase.rpc('match_claim_document_chunks', {
      query_embedding: queryEmbedding,
      match_count: 10,
      filter_carrier: carrierName,
      filter_loss_type: claimLossType,
      filter_trade: queryTrade,
      filter_decision: queryDecision,
      filter_state: claimState,
      exclude_claim_id: currentClaimId,
    });

    let allResults: any[] = (tier1Results || []).filter((r: any) => r.similarity > 0.25);
    console.log(`[CrossClaim] Tier 1 (narrow): ${allResults.length} results`);

    // TIER 2: Relax state + trade filters if thin
    if (allResults.length < 5) {
      const { data: tier2Results } = await supabase.rpc('match_claim_document_chunks', {
        query_embedding: queryEmbedding,
        match_count: 10,
        filter_carrier: carrierName,
        filter_loss_type: claimLossType,
        filter_decision: queryDecision,
        exclude_claim_id: currentClaimId,
      });
      const existingIds = new Set(allResults.map((r: any) => r.id));
      for (const r of (tier2Results || [])) {
        if (!existingIds.has(r.id) && r.similarity > 0.25) {
          allResults.push(r);
          existingIds.add(r.id);
        }
      }
      console.log(`[CrossClaim] Tier 2 (carrier+loss): total ${allResults.length}`);
    }

    // TIER 3: Broad search (no carrier filter) if still thin
    if (allResults.length < 5) {
      const { data: tier3Results } = await supabase.rpc('match_claim_document_chunks', {
        query_embedding: queryEmbedding,
        match_count: 10,
        exclude_claim_id: currentClaimId,
      });
      const existingIds = new Set(allResults.map((r: any) => r.id));
      for (const r of (tier3Results || [])) {
        if (!existingIds.has(r.id) && r.similarity > 0.3) {
          allResults.push(r);
          existingIds.add(r.id);
        }
      }
      console.log(`[CrossClaim] Tier 3 (broad): total ${allResults.length}`);
    }

    // === STEP 2: Deny-list filtering — suppress procedural/weak chunks ===
    const beforeFilter = allResults.length;
    allResults = allResults.filter((r: any) => !isProceduralChunk(r.content));
    if (beforeFilter !== allResults.length) {
      console.log(`[CrossClaim] Deny-list suppressed ${beforeFilter - allResults.length} procedural chunks`);
    }

    // Sort by similarity descending
    allResults.sort((a: any, b: any) => (b.similarity || 0) - (a.similarity || 0));

    // Deduplicate by claim (max 3 chunks per claim)
    const claimChunkCounts: Record<string, number> = {};
    const diverseResults: any[] = [];
    for (const r of allResults) {
      const count = claimChunkCounts[r.claim_id] || 0;
      if (count < 3) {
        diverseResults.push(r);
        claimChunkCounts[r.claim_id] = count + 1;
        if (diverseResults.length >= 10) break;
      }
    }

    if (diverseResults.length === 0) {
      console.log('[CrossClaim] No relevant precedents found after filtering');
      return '';
    }

    // Get claim details for citations
    const claimIds = [...new Set(diverseResults.map((r: any) => r.claim_id))];
    const { data: claimDetails } = await supabase
      .from('claims')
      .select('id, claim_number, policyholder_name, status, is_closed')
      .in('id', claimIds);

    const claimMap: Record<string, any> = {};
    for (const c of (claimDetails || [])) {
      claimMap[c.id] = c;
    }

    // Get file names for citations
    const fileIds = [...new Set(diverseResults.filter((r: any) => r.file_id).map((r: any) => r.file_id))];
    let fileMap: Record<string, string> = {};
    if (fileIds.length > 0) {
      const { data: files } = await supabase
        .from('claim_files')
        .select('id, file_name')
        .in('id', fileIds);
      for (const f of (files || [])) {
        fileMap[f.id] = f.file_name;
      }
    }

    console.log(`[CrossClaim] Returning ${diverseResults.length} precedent chunks from ${claimIds.length} claims`);

    // === BUILD ACTIONABLE EVIDENCE CARDS ===
    let context = '\n\n=== CROSS-CLAIM PRECEDENTS (INTERNAL DATABASE) ===\n';
    context += 'The following are excerpts from OTHER claims in your database. Present each as an EVIDENCE CARD.\n';
    context += 'IMPORTANT: For each card, include WHY it is relevant and WHAT WORKED (the tactic/evidence that flipped the outcome).\n';
    context += 'Tag state mismatches when the precedent is from a different state than the current claim.\n\n';

    for (const r of diverseResults) {
      const claimInfo = claimMap[r.claim_id];
      const fileName = r.file_id ? (fileMap[r.file_id] || 'Unknown') : 'N/A';
      const claimNum = claimInfo?.claim_number || 'Unknown';
      const status = claimInfo?.is_closed ? 'CLOSED' : (claimInfo?.status || 'Unknown');
      const similarity = Math.round((r.similarity || 0) * 100);
      const whyRelevant = buildRelevanceExplanation(r, claim);
      const whatWorked = buildWhatWorked(r);

      context += `--- EVIDENCE CARD ---\n`;
      context += `Claim: ${claimNum} | Carrier: ${r.carrier_name || 'Unknown'} | Status: ${status}\n`;
      context += `Document: ${fileName} | Type: ${r.evidence_type || 'unknown'} | Trade: ${r.trade || 'N/A'} | State: ${r.state_code || 'N/A'}\n`;
      context += `Decision: ${r.decision_type || 'N/A'}`;
      if (r.outcome_paid_amount) context += ` | Paid: $${r.outcome_paid_amount.toLocaleString()}`;
      if (r.outcome_resolution_type) context += ` | Resolution: ${r.outcome_resolution_type}`;
      context += `\nSimilarity: ${similarity}%\n`;
      context += `WHY RELEVANT: ${whyRelevant}\n`;
      context += `WHAT WORKED: ${whatWorked}\n`;
      if (r.denial_rationale) context += `Denial Rationale: ${r.denial_rationale}\n`;
      context += `Excerpt: ${r.content.substring(0, 500)}\n`;
      context += `--- END CARD ---\n\n`;
    }

    context += '=== END CROSS-CLAIM PRECEDENTS ===\n';
    context += 'INSTRUCTIONS: Present the most relevant evidence cards to the user. For each card, explain WHY it matters and WHAT WORKED. If a precedent shows a similar denial was overturned, highlight the specific tactic. Tag any state mismatches. Use outcome data to inform confidence scoring.\n';

    return context;
  } catch (err) {
    console.error('[CrossClaim] Error:', err);
    return '';
  }
}

// === PHASE 2.5: Persist document analysis to document_analysis_results ===
async function persistDocumentAnalysis(
  supabase: any, claimId: string | null, documentName: string | undefined,
  fullAnalysis: string, crossClaimContext: string, sourceMode: string, claim: any
) {
  try {
    if (!claimId) return;
    const docType = (() => { const f = fullAnalysis.substring(0,500).toLowerCase(); if(/denial|denied/.test(f)) return 'denial'; if(/estimate|xactimate|rcv/.test(f)) return 'estimate'; if(/engineer/.test(f)) return 'engineering_report'; if(/policy|declaration/.test(f)) return 'policy'; return 'correspondence'; })();
    const carrierPos = (() => { const l = fullAnalysis.toLowerCase(); if(/carrier.*(deny|denial)/i.test(l)) return 'deny'; if(/carrier.*(limit)/i.test(l)) return 'limit'; if(/scope.*(reduc)/i.test(l)) return 'scope_reduce'; return null; })();
    const rationales: string[] = [];
    if(/no direct physical loss/i.test(fullAnalysis)) rationales.push('no direct physical loss');
    if(/wear (and|&) tear|deterioration/i.test(fullAnalysis)) rationales.push('wear and tear / deterioration');
    if(/repairable.*(not|rather).*(replac)/i.test(fullAnalysis)) rationales.push('repairable not replace');
    if(/pre[- ]?existing/i.test(fullAnalysis)) rationales.push('pre-existing damage');
    const packType = rationales.includes('no direct physical loss') ? 'no_direct_physical_loss' : rationales.includes('wear and tear / deterioration') ? 'wear_and_tear' : rationales.includes('repairable not replace') ? 'repairable_not_replace' : rationales.includes('pre-existing damage') ? 'pre_existing' : null;
    const nextStepMatch = fullAnalysis.match(/➡\s*(?:NEXT STEP|RECOMMENDED NEXT STEP)[:\s]*\n?([\s\S]*?)(?:\n\n|$)/i);
    const nextStep = nextStepMatch ? nextStepMatch[1].trim().substring(0,500) : null;
    const covIdx = fullAnalysis.indexOf('⚖ COVERAGE-FIRST ANALYSIS');
    const covImpact = covIdx > -1 ? fullAnalysis.substring(covIdx, covIdx + 1000).split('📊')[0].trim().substring(0,1000) : null;
    const gaps: any[] = [];
    const checkMatch = fullAnalysis.match(/🧾[\s\S]*?(?=➡|$)/);
    if (checkMatch) { for (const line of checkMatch[0].split('\n')) { const u = line.match(/□\s*(.+)/); if(u) gaps.push({gap:u[1].trim(),evidence_needed:u[1].trim(),priority:/annotated photo|test square|storm report|moisture map/i.test(u[1])?'HIGH':'MEDIUM'}); }}
    const precedents: any[] = [];
    if (crossClaimContext) { for (const m of crossClaimContext.matchAll(/Claim: ([^\s|]+)\s*\|\s*Carrier: ([^\s|]+)/g)) { if(m[1]!=='Unknown') precedents.push({claim_number:m[1],carrier:m[2]}); }}
    const stateMatch = (claim?.policyholder_address||'').match(/\b([A-Z]{2})\b\s*\d{5}/);
    await supabase.from('document_analysis_results').insert({
      claim_id: claimId, file_name: documentName||'Unknown', document_type: docType,
      carrier_name: claim?.insurance_company||null, state_code: stateMatch?stateMatch[1]:null,
      loss_type: claim?.loss_type||null, carrier_position: carrierPos, denial_rationales: rationales,
      coverage_impact: covImpact, evidence_gaps: gaps, evidence_pack_type: packType,
      next_step: nextStep, full_analysis: fullAnalysis, precedent_claim_ids: [],
      precedent_summary: precedents, source_mode: sourceMode,
    });
    console.log(`[DocAnalysis] Saved analysis for "${documentName}" on claim ${claimId}`);
  } catch (err) { console.error('[DocAnalysis] Error:', err); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { claimId, question, messages, mode, reportType, documentContent, documentName, documentFilePath } = body;
    
    if (!question && !reportType) {
      return new Response(
        JSON.stringify({ error: "Missing question or reportType" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    let claim = null;
    let claimsOverview = "";
    let knowledgeBaseContext = "";
    let knowledgeBaseResult: KnowledgeSearchResult = {
      context: "",
      retrievalMode: "none",
      chunkCount: 0,
      sourceCount: 0,
      topSources: [],
    };
    let staffMembers: { id: string; name: string; email: string }[] = [];
    const sourceMode: "internal_only" | "hybrid" = body.sourceMode === "internal_only" ? "internal_only" : "hybrid";

    // Get staff members for task assignment
    staffMembers = await getStaffMembers(supabase);

    if (mode === "general" || !claimId) {
      const { data: allClaims } = await supabase
        .from("claims")
        .select(`
          id,
          claim_number,
          policyholder_name,
          status,
          loss_type,
          loss_date,
          claim_amount,
          insurance_company,
          created_at
        `)
        .eq("is_closed", false)
        .order("created_at", { ascending: false })
        .limit(20);

      if (allClaims && allClaims.length > 0) {
        claimsOverview = `\n\nRecent Active Claims (${allClaims.length}):\n`;
        allClaims.forEach((c, i) => {
          claimsOverview += `${i + 1}. ${c.claim_number || 'No #'} - ${c.policyholder_name} (ID: ${c.id}) | ${c.status || 'Unknown'} | ${c.loss_type || 'Unknown loss'} | ${c.insurance_company || 'Unknown carrier'}\n`;
        });
      }

      const { data: pendingTasks } = await supabase
        .from("tasks")
        .select(`
          id,
          title,
          due_date,
          priority,
          claims!inner(claim_number, policyholder_name)
        `)
        .eq("status", "pending")
        .order("due_date", { ascending: true })
        .limit(10);

      if (pendingTasks && pendingTasks.length > 0) {
        claimsOverview += `\n\nPending Tasks (${pendingTasks.length}):\n`;
        pendingTasks.forEach((t: any, i) => {
          const dueDate = t.due_date ? new Date(t.due_date).toLocaleDateString() : 'No due date';
          claimsOverview += `${i + 1}. ${t.title} | ${t.claims?.claim_number || 'No claim #'} - ${t.claims?.policyholder_name} | Due: ${dueDate} | Priority: ${t.priority || 'Normal'}\n`;
        });
      }
    } else if (claimId) {
      const { data: claimData, error: claimError } = await supabase
        .from("claims")
        .select(`
          *,
          claim_settlements(*),
          claim_checks(*),
          claim_expenses(*),
          claim_fees(*),
          tasks(*),
          claim_files(*)
        `)
        .eq("id", claimId)
        .single();

      if (claimError || !claimData) {
        return new Response(
          JSON.stringify({ error: "Claim not found" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      claim = claimData;
    }

    // ── Fetch document intelligence for in-claim mode ──
    // This gives the AI actual denial reasons, coverage positions, and extracted facts
    let docIntelligenceContext = "";
    if (claimId && mode !== "general") {
      try {
        const [docIntelRes, rawTextRes] = await Promise.all([
          supabase.from('claim_document_intelligence')
            .select('claim_file_id, document_type, document_subtype, summary, coverage_position, denial_reasons, exclusions_cited, testing_performed, testing_missing, estimate_totals, scope_positions, contradictions, cause_of_loss, extracted_facts, confidence_score, sender, recipient')
            .eq('claim_id', claimId)
            .order('confidence_score', { ascending: false })
            .limit(20),
          // Also get raw text from key denial files as fallback
          supabase.from('claim_files')
            .select('id, file_name, clean_text, extracted_text, text_quality_status, document_type')
            .eq('claim_id', claimId)
            .not('extracted_text', 'is', null)
            .limit(10),
        ]);

        const docIntel = (docIntelRes.data || []);
        const fileNameMap = new Map((rawTextRes.data || []).map((f: any) => [f.id, f.file_name]));

        // Filter for usable intelligence (not just PDF metadata)
        const usableIntel = docIntel.filter((d: any) => {
          const summary = (d.summary || '').trim();
          if (/technical pdf file|metadata and structural|fonts?, images?, and page/i.test(summary)) return false;
          const hasStructured = [d.coverage_position, d.denial_reasons, d.exclusions_cited, d.contradictions, d.cause_of_loss, d.extracted_facts, d.estimate_totals, d.scope_positions]
            .some((v: unknown) => Array.isArray(v) ? (v as unknown[]).length > 0 : (v && typeof v === 'object' ? Object.keys(v as Record<string, unknown>).length > 0 : (typeof v === 'string' ? v.trim().length > 0 : Boolean(v))));
          return hasStructured || (summary.length >= 80);
        });

        if (usableIntel.length > 0) {
          const intelLines = usableIntel.map((d: any, i: number) => {
            const fileName = d.claim_file_id ? fileNameMap.get(d.claim_file_id) || d.document_type : d.document_type;
            const parts = [`${i + 1}. [${fileName}${d.document_subtype ? '/' + d.document_subtype : ''}] ${(d.summary || '').slice(0, 400)}`];
            if (d.coverage_position) parts.push(`   Coverage Position: ${JSON.stringify(d.coverage_position)}`);
            if (d.denial_reasons) parts.push(`   Denial Reasons: ${JSON.stringify(d.denial_reasons)}`);
            if (d.exclusions_cited) parts.push(`   Exclusions Cited: ${JSON.stringify(d.exclusions_cited)}`);
            if (d.contradictions) parts.push(`   Contradictions: ${JSON.stringify(d.contradictions)}`);
            if (d.cause_of_loss) parts.push(`   Cause of Loss: ${d.cause_of_loss}`);
            if (d.extracted_facts) parts.push(`   Key Facts: ${JSON.stringify(d.extracted_facts)}`);
            if (d.estimate_totals) parts.push(`   Estimate Totals: ${JSON.stringify(d.estimate_totals)}`);
            if (d.scope_positions) parts.push(`   Scope Positions: ${JSON.stringify(d.scope_positions)}`);
            return parts.join('\n');
          });
          docIntelligenceContext = `\n\n=== DOCUMENT INTELLIGENCE (${usableIntel.length} documents analyzed) ===\nThis is your PRIMARY source for denial reasons, coverage positions, carrier arguments, and evidence. USE THIS DATA to answer questions directly. Do NOT say "I need to review the denial letter" when this data already contains what the denial says.\n\n${intelLines.join('\n\n')}\n=== END DOCUMENT INTELLIGENCE ===\n`;
        } else {
          // Fallback: inject raw text from denial-related files
          const denialFiles = (rawTextRes.data || []).filter((f: any) => 
            /coverage decision|reservation of rights|\bdenial\b|\bror\b/i.test(f.file_name || '') || f.document_type === 'carrier_denial'
          );
          const fallbackFiles = denialFiles.length > 0 ? denialFiles : (rawTextRes.data || []).slice(0, 3);
          const textEntries: string[] = [];
          for (const f of fallbackFiles) {
            const text = (f.clean_text || f.extracted_text || '').trim();
            if (text.length >= 100 && !/^%?PDF-\d|endobj|endstream|startxref/i.test(text.substring(0, 500))) {
              textEntries.push(`--- FILE: ${f.file_name} ---\n${text.slice(0, 5000)}${text.length > 5000 ? '\n[...truncated]' : ''}`);
            }
          }
          if (textEntries.length > 0) {
            docIntelligenceContext = `\n\n=== RAW DOCUMENT TEXT (from claim files) ===\nThe structured intelligence pipeline has not fully processed these yet. READ the text below carefully to find denial reasons, exclusions cited, coverage positions, and key facts. Answer the user's question directly using this text.\n\n${textEntries.join('\n\n')}\n=== END RAW DOCUMENT TEXT ===\n`;
          }
        }
      } catch (docIntelErr) {
        console.warn('[Claims AI] Error fetching document intelligence:', docIntelErr);
      }
    }

    // Analyze uploaded files/estimates
    let filesContext = "";
    if (claim && claim.claim_files && claim.claim_files.length > 0) {
      filesContext = "\n\nUploaded Files:\n";
      for (const file of claim.claim_files) {
        const { data: signedUrl } = await supabase
          .storage
          .from('claim-files')
          .createSignedUrl(file.file_path, 60);
        
        if (signedUrl?.signedUrl) {
          const analysis = await analyzeDocument(signedUrl.signedUrl, file.file_name);
          filesContext += `- ${analysis}\n`;
        } else {
          filesContext += `- ${file.file_name} (${file.file_type || 'unknown type'})\n`;
        }
      }
    }

    // Build context based on mode
    let contextContent = "";
    
    if (claim) {
      contextContent = `
Claim Details:
- Claim Number: ${claim.claim_number}
- Policyholder: ${claim.policyholder_name}
- Property Address: ${claim.policyholder_address || "Not provided"}
- Loss Type: ${claim.loss_type || "Not specified"}
- Loss Date: ${claim.loss_date || "Not specified"}
- Loss Description: ${claim.loss_description || "Not provided"}
- Status: ${claim.status || "Unknown"}
- Claim Amount: ${claim.claim_amount ? `$${claim.claim_amount.toLocaleString()}` : "Not specified"}
- Policy Number: ${claim.policy_number || "Not provided"}
- Insurance Company: ${claim.insurance_company || "Not specified"}
- Adjuster: ${claim.adjuster_name || "Not assigned"}

${claim.claim_settlements && claim.claim_settlements.length > 0 ? `
Settlement Information:
- RCV: $${claim.claim_settlements[0].replacement_cost_value.toLocaleString()}
- Recoverable Depreciation: $${claim.claim_settlements[0].recoverable_depreciation.toLocaleString()}
- Non-Recoverable Depreciation: $${claim.claim_settlements[0].non_recoverable_depreciation.toLocaleString()}
- Deductible: $${claim.claim_settlements[0].deductible.toLocaleString()}
` : ""}

${claim.claim_checks && claim.claim_checks.length > 0 ? `
Checks Received: ${claim.claim_checks.length} check(s) totaling $${claim.claim_checks.reduce((sum: number, check: any) => sum + Number(check.amount), 0).toLocaleString()}
` : ""}

${claim.tasks && claim.tasks.length > 0 ? `
Active Tasks: ${claim.tasks.filter((t: any) => t.status === "pending").length} pending, ${claim.tasks.filter((t: any) => t.status === "completed").length} completed
` : ""}${filesContext}
      `.trim();
    } else {
      contextContent = `You are helping a public adjuster manage their claims workload.${claimsOverview}`;
    }

    // Inject uploaded document content from chat
    let uploadedDocContext = "";
    let resolvedDocContent = documentContent || "";

    // If we have a file path but no text content, download and extract from storage
    if ((!resolvedDocContent || resolvedDocContent.trim() === "") && documentFilePath) {
      console.log("Downloading document from storage for extraction:", documentFilePath);
      try {
        const { data: fileData, error: downloadError } = await supabase.storage
          .from("claim-files")
          .download(documentFilePath);

        if (downloadError) {
          console.error("Error downloading file:", downloadError);
        } else if (fileData) {
          const fileName = documentName || documentFilePath.split("/").pop() || "document";
          const lowerName = fileName.toLowerCase();

          if (lowerName.endsWith(".pdf")) {
            try {
              resolvedDocContent = await extractTextFromPDFNative(fileData);
              if (!resolvedDocContent || resolvedDocContent.trim().length < 50) {
                resolvedDocContent = `[PDF document "${fileName}" appears to be scanned/image-based. Please describe the key details.]`;
              } else {
                resolvedDocContent = resolvedDocContent.substring(0, 50000);
                console.log(`Extracted ${resolvedDocContent.length} chars from PDF via pdf.js`);
              }
            } catch (pdfErr) {
              console.error("PDF.js extraction failed:", pdfErr);
              resolvedDocContent = `[PDF "${fileName}" could not be read. Please describe the key details.]`;
            }
          } else if (lowerName.endsWith(".txt") || lowerName.endsWith(".csv") || lowerName.endsWith(".json") || lowerName.endsWith(".xml") || lowerName.endsWith(".md")) {
            resolvedDocContent = await fileData.text();
          } else if (lowerName.endsWith(".doc") || lowerName.endsWith(".docx") || lowerName.endsWith(".xls") || lowerName.endsWith(".xlsx")) {
            // For Office docs, extract what we can
            const arrayBuffer = await fileData.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            const textDecoder = new TextDecoder("utf-8", { fatal: false });
            const rawText = textDecoder.decode(bytes);
            // For docx (which is XML-based zip), try to find XML text content
            const xmlTextMatches = rawText.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
            if (xmlTextMatches) {
              resolvedDocContent = xmlTextMatches.map(m => m.replace(/<[^>]+>/g, "")).join(" ").substring(0, 50000);
            } else {
              const asciiText = rawText.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{3,}/g, " ").trim();
              resolvedDocContent = asciiText.length > 100 ? asciiText.substring(0, 50000) : `[Office document "${fileName}" uploaded but could not extract text. Please describe the key contents.]`;
            }
          } else if (lowerName.match(/\.(jpg|jpeg|png|webp|gif)$/)) {
            resolvedDocContent = `[Image "${fileName}" was uploaded. Unable to read image text server-side. Please describe what the image shows or key details from it.]`;
          } else {
            resolvedDocContent = await fileData.text();
          }
        }
      } catch (extractErr) {
        console.error("Error extracting document content:", extractErr);
        resolvedDocContent = `[Document "${documentName || 'unknown'}" was uploaded but could not be processed. Please describe the key details.]`;
      }
    }

    if (resolvedDocContent && resolvedDocContent.trim()) {
      const lossType = claim?.loss_type || "";
      const lossDescription = claim?.loss_description || "";
      const hasClaimContext = lossType && lossType !== "unknown" && lossType.trim() !== "";
      
      let docAnalysisInstructions = "";
      
      // Shared deep analysis framework used by Darwin in both claim-specific and general chat
      const deepAnalysisFramework = `
ESTIMATE ANALYSIS (if this is a carrier or contractor estimate):
- ESTIMATE SUMMARY: Identify the estimating software (Xactimate, Symbility, etc.), total RCV, total ACV, depreciation amounts, deductible
- LINE ITEM REVIEW: Check each line item for correct quantities, unit pricing, and trade categorization
- MISSING LINE ITEMS: Identify commonly missed items for the identified loss type (e.g., detach/reset for roofing, content manipulation for water, demo/haul for fire, temporary repairs, etc.)
- OVERHEAD & PROFIT: Is O&P included? If multiple trades are involved, O&P is standard and should be applied (typically 10% each for overhead and profit)
- CODE UPGRADES: Are ordinance and law / code upgrade costs included? Check for items like arc-fault breakers, GFCI outlets, permits, engineering
- QUANTITY CONCERNS: Flag any quantities that seem low relative to the described scope
- SUPPLEMENT OPPORTUNITIES: List specific items that should be supplemented with justification
- AMBIGUOUS LANGUAGE: Flag limiting or ambiguous language the carrier uses to minimize scope (e.g., "repair as needed", "patch", "spot treat")
- DEPRECIATION REVIEW: Is depreciation applied correctly? Check for excessive depreciation percentages or depreciation applied to non-depreciable items (labor, removal, etc.)

DENIAL LETTER ANALYSIS (if this is a denial or partial denial):
- CARRIER ASSERTION: Quote the carrier's specific denial reason(s) verbatim
- POLICY LANGUAGE: Identify what policy provisions the carrier cites and whether they're applying them correctly
- BURDEN OF PROOF: Has the carrier met their burden of proof for the denial? What evidence did they provide vs. what they should have provided?
- LOGICAL FAILURES: Identify contradictions, unsupported conclusions, or circular reasoning in the carrier's position
- PROCEDURAL DEFECTS: Did the carrier follow required timelines, provide proper notice, conduct adequate investigation?
- WEAKNESSES TO EXPLOIT: Specific points where the carrier's reasoning can be challenged
- REBUTTAL STRATEGY: Outline the approach to overturn — what evidence to gather, what arguments to make, what deadlines to enforce
- BAD FAITH INDICATORS: Flag any carrier actions that suggest bad faith handling (delays, inadequate investigation, ignoring evidence)

ENGINEER/INSPECTION REPORT ANALYSIS (if this is an engineering or inspection report):
- METHODOLOGY: Was the inspection methodology appropriate for the reported damage?
- CONCLUSIONS vs EVIDENCE: Do the conclusions logically follow from the observations?
- OMISSIONS: What areas, components, or damage indicators were NOT inspected or mentioned?
- BIAS INDICATORS: Look for language that reveals predetermined conclusions or carrier-favorable bias
- COUNTER-ARGUMENTS: Technical arguments to challenge unfavorable findings
- STANDARDS CITED: Are building codes, ASTM standards, or manufacturer specs cited correctly?

GENERAL DOCUMENT ANALYSIS:
- Provide a clear, structured assessment organized by the document type
- Recommend specific next steps with actionable items
- Identify the strongest arguments available to the policyholder
- Flag any time-sensitive deadlines or requirements`;

      const structuredInsightFormat = `

YOU MUST RESPOND WITH THIS EXACT STRUCTURED FORMAT — NO EXCEPTIONS:

📄 WHAT THIS DOCUMENT IS
(Document type, sender/author, date issued, carrier, claim #, state, trade, loss type)

🎯 CARRIER POSITION & CLAIM IMPACT
(What is the carrier trying to do: deny / limit scope / reduce payment / delay? Quote the EXACT denial rationale(s) detected. If multiple, label each.)

⚖ COVERAGE-FIRST ANALYSIS
(Coverage basis to establish or attack — use POLICY LANGUAGE FIRST, then state regulations. Do NOT use manufacturer specs as coverage arguments. Manufacturer specs are only relevant as repair-method feasibility support.)

📊 PRECEDENTS FROM OUR DATABASE
(Present the top 3-7 evidence cards from cross-claim retrieval. Each card MUST show:
 - Claim # | Carrier | Trade | State
 - WHY RELEVANT: (same carrier, same denial rationale, same trade, same state or STATE MISMATCH tag)
 - WHAT WORKED: (the specific tactic/evidence that flipped it: engineer rebuttal, matching packet, supplement, appraisal, etc.)
 - OUTCOME: (first offer vs final, or resolution type)
If no precedents found, say "No matching precedents in database — this may be a novel scenario.")

🧾 EVIDENCE GAP CHECKLIST
(The MINIMUM evidence pack needed to defeat this specific denial rationale. Use these templates:)

For "No direct physical loss":
 □ Annotated photos showing direct impact damage
 □ Test square results with measurements
 □ Brittleness/granule loss documentation
 □ Lift/crease documentation with photos
 □ Moisture map (if interior involvement)
 □ Collateral damage indicators (gutters, AC units, soft metals)

For "Wear & tear / deterioration":
 □ Storm report with date-of-loss weather data
 □ Collateral damage indicators proving storm causation
 □ Creased/fractured shingle count with photos
 □ Hail hit count per test square
 □ Timeline showing damage post-storm, not pre-existing
 □ Prior condition proof (Google Street View, MLS photos, underwriting photos)

For "Repairable, not replace":
 □ Repair feasibility analysis (why repair is not viable)
 □ Uniformity/appearance argument (sealed system, continuous surface)
 □ Manufacturer spec ONLY as feasibility support (not coverage trigger)
 □ Cost comparison: repair vs replace with warranty implications

For "Pre-existing damage":
 □ Underwriting photos showing pre-loss condition
 □ Prior inspection reports
 □ MLS listing photos
 □ Date-of-loss meteorological data
 □ Affidavits from homeowner/neighbors
 □ Google Street View timeline images

(Check off items already present in the claim files. Mark missing items with priority: HIGH / MEDIUM / LOW)

➡ NEXT STEP
(ONE action, phrased like a colleague: "Do X today; I'll draft Y." — be specific and tactical)

After the structured insight, apply the detailed analysis framework below:`;

      if (hasClaimContext) {
        docAnalysisInstructions = `CRITICAL: Base your ENTIRE analysis on the ACTUAL loss type: "${lossType}". Loss Description: "${lossDescription}". DO NOT default to roofing or hail damage assumptions. Your analysis must match the specific peril and damages described.
${structuredInsightFormat}
${deepAnalysisFramework}

Tailor ALL missing items, supplement opportunities, and strategies specifically to the "${lossType}" peril.`;
      } else {
        docAnalysisInstructions = `CRITICAL: No specific claim is linked to this conversation. You MUST analyze the document based ONLY on what the document itself says. DO NOT assume any specific peril or damage type (especially NOT roofing/hail/wind by default). Read the document carefully to determine what type of loss, damage, or claim it pertains to.

Step 1: IDENTIFY the document type and loss type from the document content.
Step 2: Provide the structured insight:
${structuredInsightFormat}
Step 3: Apply the appropriate deep analysis:
${deepAnalysisFramework}

If the document is ambiguous about the type of loss, ask the user to clarify rather than assuming.`;
      }
       
       uploadedDocContext = `\n\n=== UPLOADED DOCUMENT FOR ANALYSIS ===\nDocument Name: ${documentName || 'Unknown'}\n\n${docAnalysisInstructions}\n\nDocument Content:\n${resolvedDocContent}\n=== END UPLOADED DOCUMENT ===\n`;
       contextContent += uploadedDocContext;
    }

    // Inject document intelligence context (denial reasons, coverage positions, extracted facts)
    if (docIntelligenceContext) {
      contextContent += docIntelligenceContext;
    }

    // Handle report generation
    let reportQuestion = question;
    let additionalContext = "";
    
    if (reportType && claim) {
      console.log(`Generating ${reportType} report for claim ${claimId}`);
      
      // Get weather data for weather reports
      if (reportType === "weather" && claim.policyholder_address && claim.loss_date) {
        const weatherData = await getWeatherReport(claim.policyholder_address, claim.loss_date);
        additionalContext = `\n\nHistorical Weather Data:\n${weatherData}`;
      }
      
      reportQuestion = reportPrompts[reportType] || question;
    }

    // Search the knowledge base ONLY for analytical/strategic questions — NOT for simple operational tasks
    const operationalPatterns = /^(create|add|make|mark|complete|delete|remove|update|change|set|assign|close|reopen|show|list|find tasks|bulk|share|remind|jot|note|what (tasks|claims|did I)|how many claims|send (an? )?(email|text|sms|portal|notification)|email (the )?(client|policyholder|adjuster|insured)|text (the )?(client|policyholder|adjuster|insured)|notify (the )?(client|contractor|portal)|portal message|draft (an? )?(email|text|sms|message)|draft and send|write (a )?letter|send (a )?letter|schedule (a )?call|book (a )?call|set (up )?(a )?call)/i;
    const isOperationalRequest = operationalPatterns.test((question || '').trim());
    
    if (!isOperationalRequest) {
      knowledgeBaseResult = await searchKnowledgeBase(supabase, reportQuestion || question);
      knowledgeBaseContext = knowledgeBaseResult.context;
    } else {
      console.log('[KB Retrieval] Skipped — operational/task request detected');
    }

    // === CROSS-CLAIM RETRIEVAL: Search vectorized claim docs for precedents ===
    let crossClaimContext = "";
    let playbookContext = "";
    
    // Fire cross-claim search for claim mode OR when a document is uploaded (even in general chat)
    const hasUploadedDoc = !!(resolvedDocContent && resolvedDocContent.trim());
    let escalationContext = "";
    if (!isOperationalRequest && (claimId || hasUploadedDoc)) {
      try {
        const searchQuery = hasUploadedDoc 
          ? `${question || ''} ${resolvedDocContent.substring(0, 2000)}`.trim()
          : question;
        const [ccResult, pbResult, escResult] = await Promise.all([
          searchCrossClaimPrecedents(supabase, searchQuery, claimId || '', claim),
          claim ? getCarrierPlaybookContext(supabase, claim) : Promise.resolve(''),
          claim && claimId ? getEscalationContext(supabase, claim, claimId) : Promise.resolve(''),
        ]);
        crossClaimContext = ccResult;
        playbookContext = pbResult;
        escalationContext = escResult;
      } catch (ccErr) {
        console.error('[CrossClaim/Playbook/Escalation] Search error:', ccErr);
      }
    }
    
    // Determine if web search is needed (internal-first unless recency/external signals require web)
    let webSearchResults = "";
    let webSearchQueryUsed: string | null = null;
    let webSearchStatus: "not_requested" | "success" | "unavailable" | "failed" = "not_requested";
    const evidencePlan = decideEvidencePlan({
      question: question || reportQuestion || "",
      sourceMode,
      isOperationalRequest,
      reportType,
      kbSourceCount: knowledgeBaseResult.sourceCount,
      claimLossType: claim?.loss_type || null,
    });

    if (evidencePlan.shouldSearchWeb && evidencePlan.searchQuery) {
      webSearchQueryUsed = evidencePlan.searchQuery;
      console.log("[EvidencePlan] Performing web search:", {
        query: webSearchQueryUsed,
        reason: evidencePlan.reason,
      });
      webSearchResults = await searchWeb(webSearchQueryUsed);
      if (webSearchResults && !webSearchResults.toLowerCase().includes("unavailable") && !webSearchResults.toLowerCase().includes("failed")) {
        webSearchStatus = "success";
        webSearchResults = `\n\nRelevant Industry Information:\n${webSearchResults}`;
      } else {
        webSearchStatus = webSearchResults.toLowerCase().includes("failed") ? "failed" : "unavailable";
      }
    }

    const { callOpenAI, callWithTools } = await import("../_shared/ai/openaiClient.ts");
    const { MODEL_CHEAP } = await import("../_shared/ai/modelRouter.ts");
    }

    // Build staff list context
    let staffListContext = "";
    if (staffMembers.length > 0) {
      staffListContext = `\n\nAvailable Staff Members for Task Assignment:\n${staffMembers.map(s => `- ${s.name} (ID: ${s.id})`).join("\n")}`;
    }

    // Get current date for AI context
    const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    
    const toolInstructions = `

CURRENT DATE: ${currentDate}
Use this date as reference when calculating due dates. For example:
- "tomorrow" means add 1 day to ${currentDate}
- "next week" means add 7 days to ${currentDate}
- "in 3 days" means add 3 days to ${currentDate}

*** CRITICAL - INSURANCE COMPANY BULK UPDATE (USE WHEN ASKED!) ***
When the user asks to "update contact info for insurance companies" or mentions "networking tab" or "find phone numbers for insurance companies":
- IMMEDIATELY call bulk_update_insurance_companies tool - do NOT say you cannot do this
- Call with empty parameters {} to update ALL active companies in the database
- This tool has DIRECT DATABASE ACCESS and will search the web for each company's contact info
- Example: "update contact info for all insurance companies" → call bulk_update_insurance_companies({})

*** CRITICAL - CLAIM LOOKUP TOOL (USE THIS FIRST!) ***
When the user asks about a SPECIFIC claim by name, number, or any identifier:
1. ALWAYS call get_full_claim_context FIRST with the client_name before answering
2. This retrieves COMPLETE claim data: loss type, settlements, emails, inspections, tasks, files, adjuster info
3. WITHOUT calling this tool first, you will NOT have accurate claim information
4. Common triggers: "help with [name] claim", "what's the status of [name]", "tell me about [claim number]", "the [name] file", etc.
5. NEVER assume or guess claim details - always fetch the full context first

*** CRITICAL - COMMUNICATION EXECUTION (USE WHEN USER SAYS "SEND") ***
When the user explicitly asks to SEND an email/text/SMS now:
1. Use send_email for email requests and send_sms for text/SMS requests.
2. If the user says "draft and send", generate the content and then call the send tool in the same turn.
3. If recipient details are missing, use the active claim context (default policyholder) when appropriate.
4. For carrier emails, use recipient_type: "insurance_company" so the system sends to both insurance company email and assigned adjuster when available (with fallback to whichever exists).
5. Outbound claim email subject must be the claim number only.
6. If recipient is still ambiguous, ask ONE concise clarifying question.
7. NEVER tell the user to copy/paste and send manually when they asked you to send it.

*** CRITICAL - DRAFT/APPROVAL WORKFLOW ***
When the user asks to draft, review, edit, approve, or "let me check it first":
1. Use draft_email for email drafts and draft_sms for text drafts.
2. Do NOT call send_email/send_sms unless the user explicitly asks to send now.
3. Drafts should be polished and ready for approval with greeting, context, clear ask, and closing.
4. Assume the user can edit the draft body and click an "Approve & Send" button in the UI.
5. If the user asks for a draft "based on damage in the photos", ground the draft in photo-documented damages and align those points to estimate scope already on file.
ACTION TOOLS FOR "DO IT FOR ME":
- send_portal_notification: Send claim portal notifications to client/contractors and create notification records.
- create_claim_letter: Create/save a letter file to the claim and optionally send it immediately by email.
- schedule_claim_call: Schedule/log a call in communications diary and optionally create a follow-up task.

IMPORTANT: You have the ability to CREATE TASKS. When the user asks you to create a task, reminder, follow-up, or to-do item:
1. Use the create_task function
2. CRITICAL - To identify the claim:
   - If user mentions a person's name (e.g., "James Hanlon", "Smith claim"), use client_name parameter with that name
   - NEVER put names or placeholders like "[CLAIM ID]" in claim_id - that field only accepts UUIDs
   - Only use claim_id if you have an actual UUID from the claims list context
3. Always include a clear title
4. Set a due date if the user specifies one (use YYYY-MM-DD format with actual future dates based on CURRENT DATE above)
5. Set priority based on urgency (low, medium, high)
6. Assign to a staff member if requested (use their ID from the staff list)

LEAD FINDER: You can FIND LEADS for potential clients! When the user asks about finding leads, prospecting, or identifying potential clients in a specific area:
1. Use the find_leads function with the location (city, county, state)
2. Optionally specify a damage type (hail, wind, hurricane, tornado, roof, etc.)
3. The tool will search for recent storm events and provide public property records resources
4. This helps identify areas with recent damage where homeowners may need public adjuster services

BULK CLAIM MANAGEMENT: You can help clean up and manage multiple claims at once!
- bulk_update_status: Change the status of multiple claims
- bulk_close_claims: Close multiple claims at once
- bulk_reopen_claims: Reopen multiple closed claims
- bulk_assign_staff: Assign a staff member to multiple claims
- bulk_share_to_workspace: Share multiple claims to a workspace for partner collaboration

IMPORTANT: You can filter claims by their CURRENT STATUS using filter_by_status parameter!
Examples:
- "close all claims with status Claim Settled" → use filter_by_status: "Claim Settled"
- "change all Open claims to In Review" → use filter_by_status: "Open", new_status: "In Review"
- "mark claims with Claim Settled status as closed" → use filter_by_status: "Claim Settled"

WORKSPACE SHARING: You can share claims to workspaces for partner collaboration!
- Use bulk_share_to_workspace with workspace_name (e.g., "Condition One Workspace")
- Filter by contractor using filter_by_contractor (e.g., "Condition One")
- Example: "share all claims with Condition One as contractor to Condition One workspace"
  → use filter_by_contractor: "Condition One", workspace_name: "Condition One"

You can also specify claims by name using client_names array, or by ID using claim_ids array.

NOTEPAD vs CLAIM NOTES — CRITICAL DISTINCTION:
- add_claim_note → PRIMARY tool for adding notes to a claim's Notes & Activity section. Use when user says "add a note to the [name] claim", "make a note on the claim", "note on the claim". ALWAYS use this for claim notes.
- add_notepad_item → ONLY for the user's personal DASHBOARD quick notepad. Use ONLY when user explicitly says "add to my notepad", "jot down for me", "remind me later"
- When the user says "add a note" or "make a note" while discussing claims, they ALWAYS mean a CLAIM NOTE → use add_claim_note
- NEVER use add_notepad_item for claim-related notes!

*** SYSTEM-WIDE SEARCH CAPABILITIES ***

SEARCH MY ACTIVITY (search_my_activity):
- Use this when the user asks "what claims did I update today", "what have I worked on this week", "show me my recent activity"
- Searches audit logs to find all claims and records the user has modified
- Time periods: today, yesterday, this_week, last_week, this_month, last_30_days
- Can filter by action type: create, update, status_change, email_sent, sms_sent, file_upload, payment_recorded
- Examples: "what claims did I update today" → search_my_activity({ time_period: "today" })

SEARCH COMMUNICATIONS (search_communications):
- Use this when the user asks about previous discussions, what was said about a topic, or to find specific conversations
- Searches ALL emails, SMS, notes, and communications diary entries across all claims
- Can search by keywords, adjuster names, topics, etc.
- Can optionally filter to a specific claim by name
- IMPORTANT: When the user says "this claim" or "about this claim", do NOT pass a claim_name - the system will automatically scope to the current claim context
- Examples:
  - "what did the adjuster and I discuss about depreciation" → search_communications({ search_query: "depreciation" })
  - "find all emails mentioning denial" → search_communications({ search_query: "denial", communication_type: "emails" })
  - "show me communications with State Farm" → search_communications({ search_query: "State Farm" })
  - "find emails from State Farm about this claim" → search_communications({ search_query: "State Farm", communication_type: "emails" })

SEARCH CLAIM HISTORY (search_claim_history):
- Use this for timeline questions like "what happened last week", "when did we last contact...", "show me status changes"
- Searches notes, files, tasks, inspections, payments, and emails across all claims
- Can filter by event type: status_changes, notes_added, files_uploaded, emails, tasks_created, inspections, payments
- Examples:
  - "what happened on my claims last week" → search_claim_history({ time_period: "last_week" })
  - "show me all files uploaded this month" → search_claim_history({ event_type: "files_uploaded", time_period: "this_month" })

GET ADJUSTER INTERACTIONS (get_adjuster_interactions):
- Use this when the user asks about dealings with a specific adjuster
- Finds all claims involving that adjuster and all related communications
- Shows emails, notes, and diary entries from those claims
- Examples:
  - "tell me about my dealings with John Smith from State Farm" → get_adjuster_interactions({ adjuster_name: "John Smith" })
  - "what claims does adjuster Mike handle" → get_adjuster_interactions({ adjuster_name: "Mike" })

*** TASK SEARCH (search_tasks) - USE THIS FOR FINDING TASKS! ***
- Use this when the user asks to find tasks by keywords, topic, or type
- Performs FUZZY matching - it will find similar words and common variations automatically
- Keyword synonyms include: COC ↔ certificate of completion, photos ↔ pictures/images, needed ↔ required/missing/get/upload, etc.
- Can filter by status: pending, completed, or all
- Results are grouped by claim for easy viewing
- Examples:
  - "find tasks with photos of completion" → search_tasks({ keywords: ["photos", "completion"] })
  - "which claims have COC tasks" → search_tasks({ keywords: ["COC", "certificate of completion"] })  
  - "show me tasks about photos needed" → search_tasks({ keywords: ["photos", "needed"] })
  - "find all tasks mentioning denial" → search_tasks({ keywords: ["denial"] })
  - "what claims have supplement tasks" → search_tasks({ keywords: ["supplement"] })
  - "show completed inspection tasks" → search_tasks({ keywords: ["inspection"], status: "completed" })

IMPORTANT: When the user asks about finding tasks with certain words or topics, ALWAYS use the search_tasks tool. The fuzzy matching will find related terms even if the user's wording doesn't exactly match the task titles.

*** BULK TASK PROCESSING (bulk_process_tasks) - USE FOR MULTI-CLAIM TASK OPERATIONS! ***
- Use this when the user asks to update/clear/complete tasks across MULTIPLE claims at once
- Can find claims by client names (client_names array)
- Can add a note to tasks, mark them completed, AND create follow-up tasks — all in one call
- Examples:
  - "update the tasks on these 5 claims with a note and clear them" → bulk_process_tasks({ client_names: ["Smith", "Jones", ...], note: "Contacted client", complete_tasks: true })
  - "clear all tasks on the filtered claims and create follow-ups for next week" → bulk_process_tasks({ client_names: [...], complete_tasks: true, create_follow_up: true, follow_up_title: "Follow-up", follow_up_due_date: "2026-02-27" })
  - "add a note to all tasks on these claims" → bulk_process_tasks({ client_names: [...], note: "Note text", complete_tasks: false })
- IMPORTANT: When the user says "the claims on this page" or "filtered claims", ask them for the client names or use the claims list context to identify them.

*** TASK MANAGEMENT (update_task, complete_task, reopen_task, delete_task, list_claim_tasks) ***
- update_task: Change task title, description, due date, priority, or assignee. Can find tasks by title keywords.
- complete_task: Mark a task as done. Can find by title keywords.
- reopen_task: Reopen a completed task back to pending.
- delete_task: Permanently remove a task.
- list_claim_tasks: Show all tasks for the current claim or a specific claim.
- All task tools support finding tasks by title search (task_title_search) — no need for exact task IDs.
- Examples:
  - "mark the follow-up task as done" → complete_task({ task_title_search: "follow-up" })
  - "change the inspection task due date to next Friday" → update_task({ task_title_search: "inspection", due_date: "2026-02-27" })
  - "delete the old estimate task" → delete_task({ task_title_search: "estimate" })
  - "show me all tasks on this claim" → list_claim_tasks({})
  - "reopen the supplement task" → reopen_task({ task_title_search: "supplement" })

*** DARWIN ANALYSIS & FINANCIAL SUMMARY (USE FOR THIS CLAIM!) ***
- run_darwin_analysis: When the user asks to "run an analysis", "analyze this claim", "write a case study", "create an operating manual", or "turn this into marketing assets" → call run_darwin_analysis({ analysis_type: "claim_analysis" | "case_study" | "operating_manual" | "marketing_assets" }). Use claim_id from context when in claim view.
- get_claim_financial_summary: When the user asks "what has been paid", "what is outstanding", "depreciation", "what is tied up in depreciation", "contents vs ALE vs dwelling", "how much paid per line item", or any payment/financial question → call get_claim_financial_summary({}). Do NOT say you cannot do this or that it is coming soon.`;

    // Fetch available workspaces for context
    let workspacesContext = "";
    const { data: allWorkspaces } = await supabase
      .from("workspaces")
      .select("id, name")
      .limit(20);
    
    if (allWorkspaces && allWorkspaces.length > 0) {
      workspacesContext = `\n\nAvailable Workspaces:\n${allWorkspaces.map(w => `- ${w.name} (ID: ${w.id})`).join("\n")}`;
    }

    const systemPrompt = reportType
      ? `You are an expert insurance claims report writer. Generate professional, detailed reports for property insurance claims. Your reports should be:
- Well-structured with clear sections and headings
- Factual and based on the claim information provided
- Professional enough to be included in claim documentation
- Actionable with specific recommendations
- Written to support the policyholder's claim

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting such as ** for bold, # for headers, or * for italics. Use normal capitalization and line breaks for emphasis instead.`
      : mode === "general" 
      ? `You are Darwin, an elite Claims Operations Assistant.

=== RESPONSE DISCIPLINE ===
RULE #1: Match your response to the request complexity.
- For SIMPLE OPERATIONAL requests (create a task, update status, bulk operations, assign staff, list tasks, close claims): Execute the action immediately and confirm briefly. Do NOT reference training materials, knowledge base content, or provide unsolicited analysis.
- For COMMUNICATION DRAFTING requests (email/text/letter/portal drafts): deliver polished, professional, ready-to-send copy. These are deliverables, not one-line confirmations.
- For ANALYTICAL/STRATEGIC requests (denial analysis, coverage questions, rebuttal strategy, evidence evaluation): Provide thorough, structured analysis using all available context including knowledge base materials.
- NEVER pad a simple request with irrelevant knowledge base citations or training material references.
- If you have knowledge base content in your context but the question is operational, IGNORE the knowledge base content entirely.

=== DARWIN CORE PHILOSOPHY (BRELLY-INSPIRED) ===

=== DARWIN CORE PHILOSOPHY (BRELLY-INSPIRED) ===

FUNDAMENTAL TRUTH: Your insurance claim is YOUR responsibility, and yours alone. The insurance company owes you a duty of good faith and fair dealing, but they don't owe you any money until you've proven your losses are covered by your policy.

THE FOUR PILLARS OF CLAIM SUCCESS:
1. STOP THE BLEEDING - Take reasonable measures to prevent further damage immediately
2. MAKE YOUR CLAIM - Notify the insurer promptly with proper documentation
3. PROVE YOUR LOSS - Build an airtight "Proof Castle" with cause, scope, and cost documentation
4. GET PAID AND FIX YOUR STUFF - Follow up persistently and use formal processes

PROOF OF LOSS IS YOUR BEST FRIEND (NOT A TRAP):
- The POL is a strategic asset that PUTS THE INSURER ON THE CLOCK
- Policyholders should leverage the POL process on EVERY claim
- It doesn't have to be perfect - "substantial compliance" is the legal standard
- Include qualifying statements to preserve flexibility: "This represents what is known as of this date"
- Submit your own POL proactively - don't wait for the carrier to request it
- Key deadlines: Usually 60 days to submit, insurer has 30 days to respond

BUILD YOUR "PROOF CASTLE" - Every claim needs three pillars:
1. THE CAUSE - What caused the loss? Weather reports, engineering opinions
2. THE SCOPE - How broad is the loss? Contractor opinions, code requirements
3. THE COST - What will it cost? Contractor estimates, market pricing

CRITICAL DEADLINES (STATE-SPECIFIC):
- NJ: Acknowledge 10 working days, investigate 30 days, decide 10 business days, pay 10 business days
- PA: Acknowledge 10 working days, investigate 30 days, notify 15 working days, pay 15 working days
- CALENDAR THESE AND FOLLOW UP WHEN MISSED

COMMUNICATION STRATEGY:
- Always communicate in WRITING (email, certified mail) for documentation
- Keep a communications diary: date, time, names, employee IDs, substance of calls
- Send POL electronically AND via certified mail for double documentation
- When carrier misses deadlines, put them on notice immediately in writing

CONTRACTOR SELECTION (7 KEY FACTORS):
1. Reputation - Check reviews, BBB, word of mouth
2. Proof of Insurance - Get the COI, don't just take their word
3. Location - Local contractors know codes and won't skip town
4. Availability - When can they start? Delays cause more damage
5. Licensing - Verify state, county, city licenses
6. Experience - How long in business? Do they understand insurance work?
7. Size - Larger operations handle disaster work better and manage cash flow

ADJUSTER TYPES - KNOW WHO YOU'RE DEALING WITH:
- Company/Staff Adjusters: Employees of the insurance company
- Independent Adjusters: Contractors who work for multiple insurers (NOT for you)
- Public Adjusters: Work for policyholders and take commission from recovery
The distinction that matters: Staff and independent adjusters work for INSURERS. Public adjusters work for POLICYHOLDERS.

APPRAISAL PROCESS:
- Use when you disagree on the AMOUNT (not coverage questions)
- Each side picks an appraiser, they pick an umpire
- Two of three must agree for binding decision
- This is faster and cheaper than litigation

FIRST NOTICE OF LOSS (FNOL):
- Critical milestone that starts all the clocks running
- Document everything: what you reported, when, to whom
- Get confirmation in writing
- Don't delay - prompt notice is a policy duty

=== CAPABILITIES ===
You help with:
- Drafting follow-up emails and communications
- Summarizing claim statuses and recommending next steps
- Prioritizing tasks and workload management
- Creating tasks and reminders with proper deadlines
- Explaining insurance regulations and policyholder rights
- Suggesting negotiation strategies with carriers
- Identifying claims that need immediate attention
- Building "Proof Castles" for claim documentation
- FINDING LEADS: Search for potential clients by identifying recent storm damage
${toolInstructions}

You have detailed training materials in your knowledge base about ACV policies, depreciation, and ordinance and law/code upgrades. When asked about these topics, you MUST answer from that knowledge and you MUST NOT say you lack information about them.

CRITICAL INSTRUCTION - KNOWLEDGE BASE PRIORITY:
When you see "=== CRITICAL: KNOWLEDGE BASE CONTENT ===" in the context, you MUST:
1. Read and understand that content FIRST before formulating your response
2. Base your answer primarily on that knowledge base content
3. Explicitly state "Based on your uploaded training materials..." or "According to your knowledge base..." when using that information
4. Quote or paraphrase the relevant parts directly
5. Only supplement with general knowledge if the knowledge base doesn't fully answer the question

FORMATTING REQUIREMENT: Write in plain text only. Do NOT use markdown formatting such as ** for bold, # for headers, or * for italics. Use normal capitalization and line breaks for emphasis instead.


CRITICAL - LOSS TYPE AWARENESS (HIGHEST PRIORITY):
You must NEVER default to roofing, hail, shingle, or wind damage assumptions unless the claim or document explicitly involves roofing. Every claim has a SPECIFIC loss type (water damage, fire, theft, vandalism, vehicle impact, plumbing failure, hurricane, tornado, mold, smoke, collapse, etc.). When analyzing ANY claim or document:
1. READ the claim's actual loss type and description FIRST
2. If no loss type is provided and no claim is linked, READ the uploaded document to determine the loss type
3. If you still cannot determine the loss type, ASK the user — do NOT guess or default to roofing
4. Tailor ALL analysis, recommendations, missing items, strategies, and terminology to THAT specific peril
5. Do NOT mention roofing terms (shingles, flashing, ridge caps, etc.) unless the claim is actually about roof damage

You have access to the user's active claims and pending tasks. Provide practical, actionable advice focused on getting claims FILED RIGHT, MOVING FAST, and PAID FULLY. When asked to draft communications, write them professionally and ready to send. Be thorough and strategic.`
      : `You are Darwin, a Claims Operations Assistant — not a chatbot, not a compliance bot, not a contractor estimating tool. You are a document-aware, workflow-driven intelligence assistant embedded inside the claim file. You function as a senior claims consultant, a construction engineer, and a policy strategist combined.

=== RESPONSE DISCIPLINE (HIGHEST PRIORITY) ===
RULE #1: Match your response to the request complexity.
- For SIMPLE OPERATIONAL requests (create a task, update status, bulk operations, assign staff, list tasks, close claims): Execute the action immediately and confirm briefly. Do NOT reference training materials, knowledge base content, or provide unsolicited analysis. Keep responses concise and action-focused.
- For COMMUNICATION DRAFTING/SENDING requests (emails, texts, letters, portal updates): produce polished professional content first, then execute send actions. Do not use shorthand or casual one-line drafts.
- For ANALYTICAL/STRATEGIC requests (denial analysis, coverage questions, rebuttal strategy, evidence evaluation, document analysis): Provide thorough, structured analysis using all available context.
- NEVER pad a simple request with irrelevant knowledge base citations or training material references.
- If you have knowledge base content in your context but the question is operational, IGNORE the knowledge base content entirely.

=== ABSOLUTE RULE: CURRENT CLAIM FOCUS ===
You are currently embedded INSIDE a specific claim. ALL of your responses, tool calls, searches, and analysis MUST be about THIS claim and THIS claim ONLY.
- When the user says "this claim", "the claim", "this file", or refers to anything without specifying a different claim, they mean the claim in your current context.
- NEVER reference, confuse, or substitute a different claim's number, policyholder, or details.
- When using tools like search_communications, search_claim_history, or search_tasks, do NOT pass a claim_name parameter — the system will automatically scope to the current claim.
- If the user explicitly asks about a DIFFERENT claim by name, only then should you use get_full_claim_context to look it up.
- Before responding, VERIFY that any claim number or policyholder name you mention matches the claim in your context. If it doesn't match, you have the WRONG claim — stop and correct yourself.

=== 1. DOCUMENT ANALYSIS BEHAVIOR (MANDATORY) ===

When a document is uploaded or referenced, you MUST perform three steps:

STEP 1 - READ & ANALYZE: Extract document type (estimate, denial, policy, inspection report, engineer report, invoice, etc.), carrier name, claim number, date, coverage references, damage descriptions, repair recommendations, regulatory references, and any denial or limitation language.

STEP 2 - CLASSIFY & FILE: Identify the correct claim folder category: Coverage, Policy, Estimates, Carrier Correspondence, Insured Correspondence, Engineering, Photos/Evidence, Invoices, Supplements, Regulatory/DOI. If classification is unclear, ask ONE clarifying question.

STEP 3 - PROVIDE STRUCTURED INSIGHT: Respond in this EXACT format:

[Document Icon] WHAT THIS DOCUMENT IS
(Type, sender, date, purpose)

[Scales Icon] COVERAGE IMPACT
(How does this affect coverage position? What policy provisions apply?)

[Magnifying Glass Icon] GAPS / WEAKNESSES
(What is wrong with this document? What logic fails? What is missing?)

[Receipt Icon] EVIDENCE NEEDED (if any)
(What specific evidence would strengthen the position against this document?)

[Arrow Icon] RECOMMENDED NEXT STEP
(ONE clear, tactical, actionable next step to advance this claim)

NO generic summaries. Every analysis must connect to claim advancement.

=== 2. CONVERSATIONAL MODE - COLLEAGUE / ENGINEER BEHAVIOR ===

You behave like a knowledgeable peer — a senior claims consultant who has handled thousands of claims. Users will ask things like:
- "Does this denial hold up?"
- "What are they missing?"
- "How do we rebut this?"
- "What evidence do we need to force coverage?"
- "Is this repair actually feasible?"
- "Would matching apply here?"
- "Is this direct physical loss?"

You respond ANALYTICALLY — never generically. You:
- Challenge weak carrier logic with specific technical counter-arguments
- Identify policy leverage (specific provisions, endorsements, definitions)
- Identify regulatory leverage (state-specific deadlines, bad faith indicators, DOI complaint triggers)
- Identify technical flaws in carrier reasoning (methodology errors, unsupported conclusions, bias indicators)
- Suggest specific evidence to strengthen the policyholder's position
- Cite building codes, industry standards, and manufacturer specs when supporting SCOPE arguments (never to deny coverage)

=== 3. COVERAGE-FIRST LOGIC (MANDATORY ORDER OF OPERATIONS) ===

Every analysis MUST follow this sequence:
1. COVERAGE DETERMINATION — Policy language + state regulations ONLY. Does coverage exist?
2. PROOF OF DAMAGE — Direct physical loss evidence. Is the damage documented?
3. SCOPE DISCUSSION — Repair vs. replace feasibility. What is the full extent?
4. REPAIR EXECUTION — Contractor workflow, code compliance, O&P justification.

=== CRITICAL: TOOL CALL DISCIPLINE ===
When the user asks an analytical or strategic question (how to rebut, denial analysis, coverage questions, strategy, what to do next, explain something), you MUST:
- Answer the question directly with substantive analysis using the DOCUMENT INTELLIGENCE and claim data in your context
- NEVER call add_claim_note, add_notepad_item, or any action tool as your response to an analysis question
- Only call action tools (add_claim_note, create_task, send_email, etc.) when the user EXPLICITLY asks to create, add, send, or log something

If you have DOCUMENT INTELLIGENCE in your context that contains denial reasons, coverage positions, or extracted facts — USE IT. Quote the specific denial reasons and exclusions. Do NOT say "I need to analyze the denial letter" when the data is already in your context.

=== 3. COVERAGE-FIRST LOGIC (MANDATORY ORDER OF OPERATIONS) ===

Every analysis MUST follow this sequence:
1. COVERAGE DETERMINATION — Policy language + state regulations ONLY. Does coverage exist?
2. PROOF OF DAMAGE — Direct physical loss evidence. Is the damage documented?
3. SCOPE DISCUSSION — Repair vs. replace feasibility. What is the full extent?
4. REPAIR EXECUTION — Contractor workflow, code compliance, O&P justification.

STRICT PROHIBITIONS:
- Do NOT use manufacturer specifications to deny scope or coverage
- Do NOT use building codes to determine coverage (codes are for SCOPE only)
- Do NOT move into repair workflow before coverage is established
- Do NOT default to the ASTM wind rating fallacy
- Do NOT use words like "deterioration", "rot", or "decay" — use "weathering" only for depreciation context
- Do NOT accept "man-made damage" or "installation defect" accusations without forensic proof

SOURCE PRIORITY WEIGHTING (apply when synthesizing answers from multiple retrieval sources):
When multiple sources are available, weight them in this strict priority order:
  Priority 1 (Highest): CLAIM-SPECIFIC FACTS — Documents, photos, estimates, timeline events, and communications from THIS claim file. These are ground truth and override all other sources.
  Priority 2: OFFICIAL STATUTES & REGULATIONS — State insurance codes, DOI rules, statutory deadlines, and case law. Cite specific statute numbers when available.
  Priority 3: MANUFACTURER BULLETINS, BUILDING CODES & TECHNICAL STANDARDS — IRC/IBC codes, ASTM standards, manufacturer installation guides, and technical specifications. Use these for scope support only, never to deny coverage.
  Priority 4: INTERNAL KB & TRAINING MATERIALS — Organizational knowledge base, uploaded training documents, cross-claim learning patterns. Reference as "Based on organizational training materials" or "Cross-claim patterns show..."
  Priority 5 (Lowest): GENERAL WEB SOURCES — Industry articles, general guidance, and web search results. Use only to supplement when higher-priority sources are insufficient. Never let general web content override claim-specific facts or official regulations.

When sources conflict, the higher-priority source wins. When citing, lead with the strongest source and note supporting lower-priority sources afterward. If only lower-priority sources are available, explicitly note the absence of stronger authority.

Authority hierarchy: Policy Language > State Regulations > Industry Standards > Building Codes > Manufacturer Specs (scope support only)

=== 4. CLAIM ADVANCEMENT MINDSET ===

Your purpose is to ADVANCE THE CLAIM. Every response MUST end with:

[Arrow Icon] NEXT STEP: [One clear tactical action]

Examples of proper next steps:
- "Request moisture mapping from a certified water damage specialist"
- "Obtain independent engineer rebuttal addressing methodology flaws on page 3"
- "Cite loss settlement clause Section X and demand written coverage position within 15 days"
- "Submit supplement with line-item justification for O&P, code upgrades, and hidden damage"
- "File DOI complaint — carrier missed 30-day investigation deadline by 12 days"
- "Draft demand letter citing bad faith indicators: delayed acknowledgment, inadequate investigation"

NO passive responses. NO "consider consulting an expert." Be the expert.

=== 5. TONE ===

You communicate like:
- A knowledgeable peer (direct, strategic, professional, analytical)
- Someone who has seen this exact carrier tactic 50 times before
- A strategist who knows exactly what leverage to apply and when

You do NOT communicate like:
- A generic AI assistant ("I'd be happy to help!")
- A compliance chatbot ("Please consult your policy for details")
- A contractor estimating bot (you analyze strategy, not just numbers)

=== 6. DARWIN STRATEGIC FRAMEWORK ===

THE PROOF CASTLE - Every claim needs three pillars:
1. THE CAUSE - Weather reports, engineering opinions, incident documentation
2. THE SCOPE - Contractor opinions, building code requirements, proper line itemization
3. THE COST - Detailed estimates, market pricing, O&P justification

STATE DEADLINE ENFORCEMENT:
- Know the deadlines: acknowledgment (10 days), investigation (30 days), decision (10-15 days), payment (10-15 days)
- Calendar every deadline and follow up IN WRITING when missed
- Missed deadlines = potential bad faith = leverage

CARRIER BEHAVIOR ANALYSIS:
- Track response patterns, denial language, and adjuster tactics
- Identify "moving goalposts" across multiple communications
- Flag procedural violations as escalation leverage

PROOF OF LOSS STRATEGY:
- Submit proactively — puts the insurer ON THE CLOCK (usually 30 days)
- Use qualifying statements: "based on information known as of this date"
- Send electronically AND via certified mail for double documentation

=== 7. CLIENT COMMUNICATIONS — SMARTEST IN THE ROOM ===

When the user asks to "send a text/email", "text the client", "email the adjuster", or "draft and send":
1. FIRST use claim context/history to make the communication accurate.
2. DRAFT polished, professional message content in plain language (no slang/shorthand).
3. For EMAIL drafts, include: greeting, claim reference, concise context, specific request/action, and courteous closing.
4. If user asks for DRAFT ONLY (or asks to review before sending), call draft_email or draft_sms and do not send yet.
5. If user explicitly asked to SEND now, call send_email or send_sms immediately using the professional draft body.
6. When the request says "based on damage in the photos" (or equivalent), explicitly incorporate photo-documented damages and tie them to estimate/scope items already on file.
7. For carrier-facing emails (adjuster/insurance company recipients), use assertive but professional claim-advocacy tone with direct causation + repair-necessity language and a clear written ask for revised scope/payment.
8. If the user asks for portal notifications, call send_portal_notification.
9. If the user asks for a letter, call create_claim_letter (and send it if requested).
10. If the user asks to schedule a call, call schedule_claim_call.

*** CLIENT EMAIL NOTIFICATION RULES ***
CRITICAL: You must NEVER automatically email clients about documents unless the document was uploaded to the "Carrier Documents" folder.
- Documents in "Supporting Evidence", "Supporting Estimates", "Freedom Adjustment Documents", "Estimates", or any non-carrier folder must NEVER trigger a client email.
- When you see an estimate in "Supporting Evidence" or "Supporting Estimates", that is YOUR FIRM'S internal estimate — NOT a carrier estimate. Do NOT email the client saying "an estimate came in."
- Only email clients about documents when: (a) the user explicitly asks you to notify the client, OR (b) a document is uploaded to the "Carrier Documents" folder AND the user confirms notification.
- When using send_portal_notification, set send_email_copy to false by default unless the user explicitly asks to email the client.
- NEVER proactively send client emails about internal document processing, analysis results, or supporting evidence uploads.
11. If recipient/channel are missing or ambiguous, ask ONE concise clarification; otherwise execute.
12. Confirm exactly what action was completed after the tool succeeds.
NEVER tell the user to copy/paste and send manually when they asked you to send it.

You are the smartest person in the room: analyze first, then deliver. When the user asks for help communicating with the client or battling the carrier, synthesize status and notes and produce the deliverable (draft, strategy, next step). No hedging, no "I'd be happy to help" — just the analysis and the draft or action.

${toolInstructions}

You have detailed training materials in your knowledge base about ACV policies, depreciation, and ordinance and law/code upgrades. When asked about these topics, you MUST answer from that knowledge.

CRITICAL INSTRUCTION - KNOWLEDGE BASE PRIORITY:
When you see "=== CRITICAL: KNOWLEDGE BASE CONTENT ===" in the context, you MUST:
1. Read that content FIRST before formulating your response
2. Base your answer primarily on that knowledge base content
3. State "Based on your uploaded training materials..." when using it
4. Quote or paraphrase the relevant parts directly
5. Only supplement with general knowledge if needed

FORMATTING REQUIREMENT: Write in plain text only. No markdown formatting like ** or # or *.

CRITICAL - LOSS TYPE AWARENESS (HIGHEST PRIORITY):
You must NEVER default to roofing, hail, shingle, or wind damage assumptions unless the claim explicitly involves roofing. Every claim has a SPECIFIC loss type. When analyzing ANY claim or document:
1. READ the claim's actual loss type and description FIRST
2. If no loss type is provided, READ the uploaded document to determine the loss type
3. If you still cannot determine the loss type, ASK the user — do NOT guess or default to roofing
4. Tailor ALL analysis, recommendations, missing items, strategies, and terminology to THAT specific peril
5. Do NOT mention roofing terms unless the claim is actually about roof damage

Be relentlessly focused on advancing the claim toward a fair, full, and fast settlement. Never suggest fraud.`;

    const conversationMessages = [];
    
    conversationMessages.push({ 
      role: "system", 
      content: `${systemPrompt}\n\nContext:\n${contextContent}${additionalContext}${staffListContext}${workspacesContext}`
    });
    
    // If we have knowledge base context, surface it explicitly as a separate assistant message
    if (knowledgeBaseContext) {
      conversationMessages.push({
        role: "assistant",
        content: knowledgeBaseContext,
      });
    }

    // If we have cross-claim precedents, add them as context
    if (crossClaimContext) {
      conversationMessages.push({
        role: "assistant",
        content: crossClaimContext,
      });
    }

    // If we have playbook data, add it as context
    if (playbookContext) {
      conversationMessages.push({
        role: "assistant",
        content: playbookContext,
      });
    }

    // If we have escalation context, add it
    if (escalationContext) {
      conversationMessages.push({
        role: "assistant",
        content: escalationContext,
      });
    }

    if (messages && messages.length > 0 && !reportType) {
      conversationMessages.push(...messages);
    }
    conversationMessages.push({ 
      role: "user", 
      content: reportQuestion 
    });

    // Include tools only for non-report requests
    const requestBody: any = {
      model: "google/gemini-2.5-flash",
      messages: conversationMessages,
      max_tokens: reportType ? 3000 : 2500,
    };

    if (!reportType) {
      requestBody.tools = tools;
      requestBody.tool_choice = "auto";
    }

    let aiData: any;
    try {
      if (!reportType && requestBody.tools) {
        const toolResult = await callWithTools({
          model: MODEL_CHEAP,
          messages: conversationMessages,
          tools: requestBody.tools,
          toolChoice: "auto",
          temperature: 0.7,
          maxTokens: requestBody.max_tokens || 2500,
        });
        aiData = {
          choices: [{
            message: {
              content: toolResult.text,
              tool_calls: toolResult.toolCalls.map(tc => ({ function: tc.function, id: tc.id })),
            },
          }],
        };
      } else {
        const systemMsg = conversationMessages.find((m: any) => m.role === 'system')?.content || '';
        const userMsgs = conversationMessages.filter((m: any) => m.role !== 'system').map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n');
        const textResult = await callOpenAI({
          model: MODEL_CHEAP,
          system: systemMsg,
          user: userMsgs,
          maxTokens: requestBody.max_tokens || 3000,
        });
        aiData = { choices: [{ message: { content: textResult.text } }] };
      }
    } catch (aiError) {
      const errMsg = aiError instanceof Error ? aiError.message : 'Unknown';
      if (errMsg === 'RATE_LIMIT') {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw new Error(`AI error: ${errMsg}`);
    }

    console.log(`[ClaimsAI] Main AI call complete`);
    const firstChoice = aiData.choices[0];
    let answer = firstChoice.message.content || "";
    let tasksCreated: any[] = [];
    let emailsSent: any[] = [];
    let smsSent: any[] = [];
    let communicationDrafts: CommunicationDraft[] = [];
    let portalNotificationsSent: any[] = [];
    let lettersCreated: any[] = [];
    let callsScheduled: any[] = [];
    let toolCallsTotal = Array.isArray(firstChoice.message.tool_calls) ? firstChoice.message.tool_calls.length : 0;
    let toolCallsProcessed = 0;
    let toolCallProcessingMs = 0;

    // ── Guard: detect when AI calls add_claim_note on an analytical question ──
    const isAnalyticalQuestion = /\b(?:how|what|why|explain|analy[sz]e|review|assess|rebut|respond|strategy|argument|weakness|next step|next move|denial|coverage|carrier position|contradiction|should we|what do you think|how do we|how do i)\b/i.test(reportQuestion);
    
    if (firstChoice.message.tool_calls && firstChoice.message.tool_calls.length > 0) {
      const toolNames = firstChoice.message.tool_calls.map((tc: any) => tc.function?.name);
      const onlyNoteOrNotepad = toolNames.every((n: string) => n === 'add_claim_note' || n === 'add_notepad_item');
      
      if (isAnalyticalQuestion && onlyNoteOrNotepad) {
        console.log('[Claims AI Guard] AI tried to add_claim_note on analytical question — retrying without tools');
        // Retry without tools to force a direct answer
        const retryBody = {
          model: "google/gemini-2.5-flash",
          messages: [
            ...conversationMessages.slice(0, -1),
            { role: "user", content: `${reportQuestion}\n\nIMPORTANT: Answer this question directly with substantive analysis. Do NOT add notes, create tasks, or take any actions. Analyze the claim data and document intelligence provided in your context to give a thorough strategic answer.` }
          ],
          max_tokens: 2500,
        };
        
        try {
          const retryMsgs = retryBody.messages;
          const retrySys = retryMsgs.find((m: any) => m.role === 'system')?.content || '';
          const retryUsr = retryMsgs.filter((m: any) => m.role !== 'system').map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n');
          const retryResult = await callOpenAI({
            model: MODEL_CHEAP,
            system: retrySys,
            user: retryUsr,
            maxTokens: 2500,
          });
          answer = retryResult.text || answer;
          // Skip tool call processing
          return new Response(
            JSON.stringify({ response: answer, tasksCreated: [], emailsSent: [], smsSent: [], communicationDrafts: [], portalNotificationsSent: [], lettersCreated: [], callsScheduled: [] }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
          );
        }
      }
    }

    // Handle tool calls if present
    if (firstChoice.message.tool_calls && firstChoice.message.tool_calls.length > 0) {
      console.log("Processing tool calls:", firstChoice.message.tool_calls.length);
      const toolCallStartedAt = Date.now();
      const cappedToolCalls = firstChoice.message.tool_calls.slice(0, MAX_TOOL_CALLS_PER_TURN);
      if (firstChoice.message.tool_calls.length > MAX_TOOL_CALLS_PER_TURN) {
        answer += `\n\n⚠️ Processed the first ${MAX_TOOL_CALLS_PER_TURN} actions to prevent long-running loops. Please run the remaining actions in a follow-up request if needed.`;
      }
      
      for (const toolCall of cappedToolCalls) {
        toolCallsProcessed += 1;
        if (toolCall.function.name === "create_task") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Creating task with params:", params);
            
            // Resolve claim_id from client_name if needed
            let resolvedClaimId = params.claim_id;
            let resolvedClientName = "";
            
            if (!resolvedClaimId && params.client_name) {
              console.log("Looking up claim by client name:", params.client_name);
              const foundClaim = await findClaimByClientName(supabase, params.client_name);
              if (foundClaim) {
                resolvedClaimId = foundClaim.id;
                resolvedClientName = foundClaim.policyholder_name;
                console.log("Found claim:", foundClaim.claim_number, "for client:", foundClaim.policyholder_name);
              } else {
                answer += `\n\n❌ **Could not find a claim for client "${params.client_name}".** Please check the name and try again.`;
                continue;
              }
            }
            
            if (!resolvedClaimId) {
              answer += `\n\n❌ **No claim specified.** Please provide either a claim ID or client name.`;
              continue;
            }
            
            const result = await createTask(supabase, {
              ...params,
              claim_id: resolvedClaimId
            });
            
            if (result.success && result.task) {
              tasksCreated.push({
                id: result.task.id,
                title: result.task.title,
                due_date: result.task.due_date,
                priority: result.task.priority,
                claim_id: result.task.claim_id
              });
              
              // Add confirmation to the answer
              const dueInfo = result.task.due_date ? ` due on ${result.task.due_date}` : "";
              const priorityInfo = result.task.priority ? ` (${result.task.priority} priority)` : "";
              const clientInfo = resolvedClientName ? ` for ${resolvedClientName}` : "";
              answer += `\n\n✅ **Task Created:** "${result.task.title}"${clientInfo}${dueInfo}${priorityInfo}`;
            } else {
              answer += `\n\n❌ **Failed to create task:** ${result.error}`;
            }
          } catch (parseErr) {
            console.error("Error parsing tool call arguments:", parseErr);
            answer += `\n\n❌ **Error creating task:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "find_leads") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Finding leads for location:", params.location);
            
            const leadResults = await findLeads(params.location, params.damage_type);
            answer = leadResults;
          } catch (parseErr) {
            console.error("Error parsing find_leads arguments:", parseErr);
            answer += `\n\n❌ **Error finding leads:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "bulk_update_status") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Bulk updating status:", params);
            
            const resolved = await resolveClaimIds(supabase, params.claim_ids, params.client_names, params.filter_by_status);
            if (resolved.length === 0) {
              answer += `\n\n❌ **No claims found** ${params.filter_by_status ? `with status "${params.filter_by_status}"` : "to update status"}.`;
              continue;
            }
            
            const claimIds = resolved.map(c => c.id);
            const result = await bulkUpdateStatus(supabase, claimIds, params.new_status);
            
            const filterInfo = params.filter_by_status ? ` (filtered by status: "${params.filter_by_status}")` : "";
            answer += `\n\n✅ **Bulk Status Update:** Changed ${result.success} claim(s) to "${params.new_status}"${filterInfo}`;
          } catch (parseErr) {
            console.error("Error in bulk_update_status:", parseErr);
            answer += `\n\n❌ **Error updating statuses:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "bulk_close_claims") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Bulk closing claims:", params);
            
            const resolved = await resolveClaimIds(supabase, params.claim_ids, params.client_names, params.filter_by_status);
            if (resolved.length === 0) {
              answer += `\n\n❌ **No claims found** ${params.filter_by_status ? `with status "${params.filter_by_status}"` : "to close"}.`;
              continue;
            }
            
            const claimIds = resolved.map(c => c.id);
            const result = await bulkCloseClaims(supabase, claimIds);
            
            const filterInfo = params.filter_by_status ? ` with status "${params.filter_by_status}"` : "";
            answer += `\n\n✅ **Claims Closed:** ${result.success} claim(s)${filterInfo} closed successfully`;
          } catch (parseErr) {
            console.error("Error in bulk_close_claims:", parseErr);
            answer += `\n\n❌ **Error closing claims:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "bulk_reopen_claims") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Bulk reopening claims:", params);
            
            const resolved = await resolveClaimIds(supabase, params.claim_ids, params.client_names, params.filter_by_status);
            if (resolved.length === 0) {
              answer += `\n\n❌ **No claims found** ${params.filter_by_status ? `with status "${params.filter_by_status}"` : "to reopen"}.`;
              continue;
            }
            
            const claimIds = resolved.map(c => c.id);
            const result = await bulkReopenClaims(supabase, claimIds);
            
            const filterInfo = params.filter_by_status ? ` with status "${params.filter_by_status}"` : "";
            answer += `\n\n✅ **Claims Reopened:** ${result.success} claim(s)${filterInfo} reopened successfully`;
          } catch (parseErr) {
            console.error("Error in bulk_reopen_claims:", parseErr);
            answer += `\n\n❌ **Error reopening claims:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "bulk_assign_staff") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Bulk assigning staff:", params);
            
            // Resolve staff ID
            let staffId = params.staff_id;
            let staffName = "";
            
            if (!staffId && params.staff_name) {
              const staff = await findStaffByName(supabase, params.staff_name);
              if (staff) {
                staffId = staff.id;
                staffName = staff.name;
              } else {
                answer += `\n\n❌ **Staff member "${params.staff_name}" not found.**`;
                continue;
              }
            }
            
            if (!staffId) {
              answer += `\n\n❌ **No staff member specified.** Please provide a staff name or ID.`;
              continue;
            }
            
            const resolved = await resolveClaimIds(supabase, params.claim_ids, params.client_names, params.filter_by_status);
            if (resolved.length === 0) {
              answer += `\n\n❌ **No claims found** ${params.filter_by_status ? `with status "${params.filter_by_status}"` : "to assign staff"}.`;
              continue;
            }
            
            const claimIds = resolved.map(c => c.id);
            const result = await bulkAssignStaff(supabase, claimIds, staffId);
            
            const filterInfo = params.filter_by_status ? ` with status "${params.filter_by_status}"` : "";
            answer += `\n\n✅ **Staff Assigned:** ${staffName || "Staff member"} assigned to ${result.success} claim(s)${filterInfo}${result.skipped > 0 ? ` (${result.skipped} already assigned)` : ""}`;
          } catch (parseErr) {
            console.error("Error in bulk_assign_staff:", parseErr);
            answer += `\n\n❌ **Error assigning staff:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "bulk_share_to_workspace") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Bulk sharing to workspace:", params);
            
            // Resolve workspace
            let workspaceId = params.workspace_id;
            let workspaceName = "";
            
            if (!workspaceId && params.workspace_name) {
              const workspace = await findWorkspaceByName(supabase, params.workspace_name);
              if (workspace) {
                workspaceId = workspace.id;
                workspaceName = workspace.name;
              } else {
                answer += `\n\n❌ **Workspace "${params.workspace_name}" not found.**`;
                continue;
              }
            }
            
            if (!workspaceId) {
              answer += `\n\n❌ **No workspace specified.** Please provide a workspace name.`;
              continue;
            }
            
            // Resolve claims - check contractor filter first
            let resolved: { id: string; name: string }[] = [];
            
            if (params.filter_by_contractor) {
              resolved = await resolveClaimsByContractor(supabase, params.filter_by_contractor);
              if (resolved.length === 0) {
                answer += `\n\n❌ **No claims found** with contractor "${params.filter_by_contractor}".`;
                continue;
              }
            } else {
              resolved = await resolveClaimIds(supabase, params.claim_ids, params.client_names, params.filter_by_status);
              if (resolved.length === 0) {
                answer += `\n\n❌ **No claims found** to share.`;
                continue;
              }
            }
            
            const claimIds = resolved.map(c => c.id);
            const result = await bulkShareToWorkspace(supabase, claimIds, workspaceId);
            
            const filterInfo = params.filter_by_contractor 
              ? ` with contractor "${params.filter_by_contractor}"` 
              : params.filter_by_status 
                ? ` with status "${params.filter_by_status}"` 
                : "";
            answer += `\n\n✅ **Claims Shared:** ${result.success} claim(s)${filterInfo} shared to workspace "${workspaceName || 'selected workspace'}"`;
          } catch (parseErr) {
            console.error("Error in bulk_share_to_workspace:", parseErr);
            answer += `\n\n❌ **Error sharing to workspace:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "add_claim_note") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Adding claim note:", params);
            
            // Get user ID
            const authHeader = req.headers.get("authorization");
            if (!authHeader) {
              answer += `\n\n❌ **Cannot add note:** Not authenticated`;
              continue;
            }
            const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
            if (!user) {
              answer += `\n\n❌ **Cannot add note:** User not found`;
              continue;
            }
            
            // Resolve claim
            let resolvedClaimId = params.claim_id;
            let claimName = "";
            if (!resolvedClaimId && params.client_name) {
              const foundClaim = await findClaimByClientName(supabase, params.client_name);
              if (foundClaim) {
                resolvedClaimId = foundClaim.id;
                claimName = foundClaim.policyholder_name;
              }
            }
            // Also try from conversation context (claimId variable)
            if (!resolvedClaimId && claimId) {
              resolvedClaimId = claimId;
            }
            
            if (!resolvedClaimId) {
              answer += `\n\n❌ **Could not find claim** for "${params.client_name || 'unknown'}". Please specify the client name.`;
              continue;
            }
            
            const { error: noteErr } = await supabase
              .from("claim_updates")
              .insert({
                claim_id: resolvedClaimId,
                content: params.note,
                update_type: "note",
                user_id: user.id,
              });
            
            if (noteErr) {
              console.error("Failed to insert claim note:", noteErr);
              answer += `\n\n❌ **Failed to add note:** ${noteErr.message}`;
            } else {
              answer += `\n\n✅ **Note added to ${claimName || "claim"}:** "${params.note}"`;
            }
          } catch (parseErr) {
            console.error("Error in add_claim_note:", parseErr);
            answer += `\n\n❌ **Error adding claim note:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "add_notepad_item") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Adding notepad item:", params.item);
            
            // Get user ID from auth header
            const authHeader = req.headers.get("authorization");
            if (!authHeader) {
              answer += `\n\n❌ **Cannot add to notepad:** Not authenticated`;
              continue;
            }
            
            const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
            if (!user) {
              answer += `\n\n❌ **Cannot add to notepad:** User not found`;
              continue;
            }
            
            const result = await addNotepadItem(supabase, user.id, params.item);
            
            if (result.success) {
              answer += `\n\n✅ **Added to your notepad:** "${params.item}"`;
            } else {
              answer += `\n\n❌ **Failed to add to notepad:** ${result.error}`;
            }
          } catch (parseErr) {
            console.error("Error in add_notepad_item:", parseErr);
            answer += `\n\n❌ **Error adding to notepad:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "get_full_claim_context") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Getting full claim context for:", params.client_name);
            
            const contextResult = await getFullClaimContext(supabase, params.client_name);
            
            if (contextResult.success && contextResult.context) {
              // Make a follow-up AI call with the full context
              console.log("Making follow-up AI call with full claim context");
              
              const followUpMessages = [
                { 
                  role: "system", 
                  content: `You are Darwin, an expert public adjuster AI assistant with COMPLETE knowledge of this claim. You have access to all claim details, communications, files, and history. Provide expert, detailed responses based on the claim data below.

CRITICAL ARGUMENT STRATEGY - REPAIRABILITY OVER MATCHING:
- NEVER argue "matching" (that new materials must match existing materials)
- ALWAYS argue "repairability" - damaged materials CANNOT BE REPAIRED and must be replaced
- Focus on why materials are not repairable: manufacturing discontinuation, material degradation, structural integrity compromised, code compliance requirements

FORMATTING: Write in plain text only. Do NOT use markdown formatting such as ** for bold, # for headers, or * for italics.

${contextResult.context}

${knowledgeBaseContext || ''}`
                },
                ...conversationMessages.slice(1) // Skip the original system message
              ];
              
              const followUpResponse = await fetchWithTimeout("https://ai.gateway.lovable.dev/v1/chat/completions", {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${LOVABLE_API_KEY}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: "google/gemini-2.5-flash",
                  messages: followUpMessages,
                  max_tokens: 2000,
                }),
              }, AI_GATEWAY_FOLLOW_UP_TIMEOUT_MS);
              
              if (followUpResponse.ok) {
                const followUpData = await followUpResponse.json();
                answer = followUpData.choices[0].message.content || "";
              } else {
                console.error("Follow-up AI call failed:", followUpResponse.status);
                answer = `I found the claim for ${params.client_name}. ${contextResult.context.substring(0, 500)}...\n\nPlease ask your specific question about this claim.`;
              }
            } else {
              answer += `\n\n❌ **Could not find claim:** ${contextResult.error}`;
            }
          } catch (parseErr) {
            console.error("Error in get_full_claim_context:", parseErr);
            answer += `\n\n❌ **Error getting claim context:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "web_search") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Performing web search:", params.query);
            
            const searchResult = await searchWeb(params.query);
            
            if (searchResult && !searchResult.includes("unavailable")) {
              answer += `\n\n🔍 **Web Search Results for "${params.query}":**\n\n${searchResult}`;
            } else {
              answer += `\n\n❌ **Web search failed:** ${searchResult}`;
            }
          } catch (parseErr) {
            console.error("Error in web_search:", parseErr);
            answer += `\n\n❌ **Error performing web search:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "update_insurance_company") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Updating insurance company:", params.company_name);
            
            // Find the insurance company by name
            const { data: companies, error: findError } = await supabase
              .from("insurance_companies")
              .select("id, name")
              .ilike("name", `%${params.company_name}%`)
              .limit(5);
            
            if (findError || !companies || companies.length === 0) {
              answer += `\n\n❌ **Insurance company "${params.company_name}" not found in database.**`;
              continue;
            }
            
            // Update the company
            const updateData: any = {};
            if (params.phone) updateData.phone = params.phone;
            if (params.email) updateData.email = params.email;
            if (params.claims_phone) updateData.claims_phone = params.claims_phone;
            if (params.claims_email) updateData.claims_email = params.claims_email;
            
            if (Object.keys(updateData).length === 0) {
              answer += `\n\n❌ **No update data provided for ${params.company_name}.**`;
              continue;
            }
            
            const { error: updateError } = await supabase
              .from("insurance_companies")
              .update(updateData)
              .eq("id", companies[0].id);
            
            if (updateError) {
              answer += `\n\n❌ **Failed to update ${companies[0].name}:** ${updateError.message}`;
            } else {
              const updates = Object.entries(updateData).map(([k, v]) => `${k}: ${v}`).join(", ");
              answer += `\n\n✅ **Updated ${companies[0].name}:** ${updates}`;
            }
          } catch (parseErr) {
            console.error("Error in update_insurance_company:", parseErr);
            answer += `\n\n❌ **Error updating insurance company:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "lookup_building_code") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            const query = params.state 
              ? `${params.query} ${params.state} building code requirements`
              : params.query;
            console.log("Looking up building code:", query);
            
            const searchResult = await searchWeb(query);
            
            if (searchResult && !searchResult.includes("unavailable")) {
              answer += `\n\n📋 **Building Code / Manufacturer Spec Lookup:**\n\n${searchResult}`;
            } else {
              answer += `\n\n❌ **Could not find information for:** ${params.query}`;
            }
          } catch (parseErr) {
            console.error("Error in lookup_building_code:", parseErr);
            answer += `\n\n❌ **Error looking up building code:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "bulk_update_insurance_companies") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Bulk updating insurance companies");
            
            // Fetch all insurance companies or specific ones
            let query = supabase.from("insurance_companies").select("id, name, phone, email");
            
            if (params.company_names && params.company_names.length > 0) {
              // Filter to specific companies
              const filters = params.company_names.map((name: string) => `name.ilike.%${name}%`);
              query = query.or(filters.join(","));
            }
            
            const { data: companies, error: fetchError } = await query.eq("is_active", true);
            
            if (fetchError || !companies || companies.length === 0) {
              answer += `\n\n❌ **No insurance companies found to update.**`;
              continue;
            }
            
            answer += `\n\n🔄 **Processing ${companies.length} insurance companies...**\n\n`;
            
            const successfulUpdates: { name: string; phone?: string; email?: string }[] = [];
            const needsReview: { name: string; reason: string }[] = [];
            const alreadyComplete: string[] = [];
            
            // Process each company
            for (const company of companies) {
              try {
                // Search for company contact info
                const searchQuery = `${company.name} insurance company claims department phone number email contact information`;
                const searchResult = await searchWeb(searchQuery);
                
                if (!searchResult || searchResult.includes("unavailable")) {
                  needsReview.push({ name: company.name, reason: "Web search failed" });
                  continue;
                }
                
                // Extract phone and email from search results using AI
                const extractResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${LOVABLE_API_KEY}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    model: "google/gemini-2.5-flash",
                    messages: [
                      {
                        role: "system",
                        content: "Extract the main claims phone number and email from the following text. Return ONLY a JSON object with 'phone' and 'email' fields. If not found, use null. Format phone as digits only with area code."
                      },
                      {
                        role: "user",
                        content: `Extract contact info for ${company.name} from:\n\n${searchResult}`
                      }
                    ],
                    max_tokens: 200,
                  }),
                });
                
                if (!extractResponse.ok) {
                  needsReview.push({ name: company.name, reason: "AI extraction failed" });
                  continue;
                }
                
                const extractData = await extractResponse.json();
                let extracted: { phone?: string; email?: string } = {};
                
                try {
                  const content = extractData.choices[0].message.content || "";
                  const jsonMatch = content.match(/\{[\s\S]*\}/);
                  if (jsonMatch) {
                    extracted = JSON.parse(jsonMatch[0]);
                  }
                } catch (parseErr) {
                  needsReview.push({ name: company.name, reason: "Could not parse contact info" });
                  continue;
                }
                
                // Only update if we found new info
                const updateData: any = {};
                if (extracted.phone && extracted.phone !== company.phone) {
                  updateData.phone = extracted.phone;
                }
                if (extracted.email && extracted.email !== company.email) {
                  updateData.email = extracted.email;
                }
                
                if (Object.keys(updateData).length > 0) {
                  const { error: updateError } = await supabase
                    .from("insurance_companies")
                    .update(updateData)
                    .eq("id", company.id);
                  
                  if (!updateError) {
                    successfulUpdates.push({ name: company.name, ...updateData });
                  } else {
                    needsReview.push({ name: company.name, reason: "Database update failed" });
                  }
                } else if (!extracted.phone && !extracted.email) {
                  needsReview.push({ name: company.name, reason: "No contact info found online" });
                } else {
                  alreadyComplete.push(company.name);
                }
                
                // Add small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 500));
                
              } catch (companyErr) {
                console.error(`Error updating ${company.name}:`, companyErr);
                needsReview.push({ name: company.name, reason: "Unexpected error" });
              }
            }
            
            // Build comprehensive summary
            answer += `## ✅ Successfully Updated (${successfulUpdates.length})\n`;
            if (successfulUpdates.length > 0) {
              for (const u of successfulUpdates) {
                const details = [];
                if (u.phone) details.push(`📞 ${u.phone}`);
                if (u.email) details.push(`📧 ${u.email}`);
                answer += `- **${u.name}**: ${details.join(", ")}\n`;
              }
            } else {
              answer += `_None_\n`;
            }
            
            answer += `\n## ⚠️ Needs Manual Review (${needsReview.length})\n`;
            if (needsReview.length > 0) {
              for (const r of needsReview) {
                answer += `- **${r.name}**: ${r.reason}\n`;
              }
              answer += `\n_Please manually look up contact info for these companies in the Networking tab._\n`;
            } else {
              answer += `_None_\n`;
            }
            
            if (alreadyComplete.length > 0) {
              answer += `\n## ✓ Already Up to Date (${alreadyComplete.length})\n`;
              answer += alreadyComplete.join(", ") + "\n";
            }
            
            answer += `\n---\n**Summary:** ${successfulUpdates.length} updated, ${alreadyComplete.length} already complete, ${needsReview.length} need manual review.`;
            
          } catch (parseErr) {
            console.error("Error in bulk_update_insurance_companies:", parseErr);
            answer += `\n\n❌ **Error updating insurance companies:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "search_my_activity") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Searching user activity:", params);
            
            // Get user ID from auth header
            const authHeader = req.headers.get("authorization");
            if (!authHeader) {
              answer += `\n\n❌ **Cannot search activity:** Not authenticated`;
              continue;
            }
            
            const { data: { user } } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
            if (!user) {
              answer += `\n\n❌ **Cannot search activity:** User not found`;
              continue;
            }
            
            const activityResult = await searchUserActivity(supabase, user.id, params.time_period, params.action_type);
            answer = activityResult;
          } catch (parseErr) {
            console.error("Error in search_my_activity:", parseErr);
            answer += `\n\n❌ **Error searching activity:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "search_communications") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Searching communications:", params);
            
            // When in claim mode, automatically scope to the current claim
            // instead of relying on the AI to resolve claim_name
            const effectiveClaimName = (claimId && !params.claim_name && claim) 
              ? claim.claim_number || claim.policyholder_name 
              : params.claim_name;
            
            const communicationsResult = await searchCommunications(
              supabase, 
              params.search_query, 
              params.communication_type || "all",
              params.time_period || "all_time",
              effectiveClaimName,
              claimId || undefined
            );
            answer = communicationsResult;
          } catch (parseErr) {
            console.error("Error in search_communications:", parseErr);
            answer += `\n\n❌ **Error searching communications:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "search_claim_history") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Searching claim history:", params);
            
            // When in claim mode, automatically scope to the current claim
            const effectiveClaimName = (claimId && !params.claim_name && claim) 
              ? claim.claim_number || claim.policyholder_name 
              : params.claim_name;
            
            const historyResult = await searchClaimHistory(
              supabase,
              params.search_query || "",
              params.event_type || "all",
              params.time_period || "this_week",
              effectiveClaimName,
              claimId || undefined
            );
            answer = historyResult;
          } catch (parseErr) {
            console.error("Error in search_claim_history:", parseErr);
            answer += `\n\n❌ **Error searching claim history:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "get_adjuster_interactions") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Getting adjuster interactions:", params);
            
            const adjusterResult = await getAdjusterInteractions(
              supabase,
              params.adjuster_name,
              params.include_emails !== false,
              params.include_notes !== false,
              params.include_diary !== false
            );
            answer = adjusterResult;
          } catch (parseErr) {
            console.error("Error in get_adjuster_interactions:", parseErr);
            answer += `\n\n❌ **Error getting adjuster interactions:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "search_tasks") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Searching tasks with keywords:", params.keywords);
            
            const tasksResult = await searchTasksByKeywords(
              supabase,
              params.keywords,
              params.status || "pending",
              params.include_closed_claims || false
            );
            answer = tasksResult;
          } catch (parseErr) {
            console.error("Error in search_tasks:", parseErr);
            answer += `\n\n❌ **Error searching tasks:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "update_task") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Updating task:", params);
            
            const { task, error: findErr } = await resolveTask(supabase, params.task_id, params.task_title_search, claimId || undefined);
            if (!task) {
              answer += `\n\n❌ **Task not found:** ${findErr}`;
              continue;
            }
            
            const updateData: any = {};
            if (params.title) updateData.title = params.title;
            if (params.description) updateData.description = params.description;
            if (params.due_date) updateData.due_date = params.due_date;
            if (params.priority) updateData.priority = params.priority;
            if (params.assigned_to) updateData.assigned_to = params.assigned_to;
            updateData.updated_at = new Date().toISOString();
            
            if (Object.keys(updateData).length <= 1) {
              answer += `\n\n❌ **No changes specified** for task "${task.title}".`;
              continue;
            }
            
            const { error: updateError } = await supabase
              .from("tasks")
              .update(updateData)
              .eq("id", task.id);
            
            if (updateError) {
              answer += `\n\n❌ **Failed to update task:** ${updateError.message}`;
            } else {
              const changes = Object.entries(updateData)
                .filter(([k]) => k !== "updated_at")
                .map(([k, v]) => `${k}: ${v}`)
                .join(", ");
              answer += `\n\n✅ **Task updated:** "${task.title}" → ${changes}`;
            }
          } catch (parseErr) {
            console.error("Error in update_task:", parseErr);
            answer += `\n\n❌ **Error updating task:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "complete_task") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Completing task:", params);
            
            const { task, error: findErr } = await resolveTask(supabase, params.task_id, params.task_title_search, claimId || undefined);
            if (!task) {
              answer += `\n\n❌ **Task not found:** ${findErr}`;
              continue;
            }
            
            if (task.status === "completed") {
              answer += `\n\n⚠️ **Task already completed:** "${task.title}"`;
              continue;
            }
            
            const { error: updateError } = await supabase
              .from("tasks")
              .update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
              .eq("id", task.id);
            
            if (updateError) {
              answer += `\n\n❌ **Failed to complete task:** ${updateError.message}`;
            } else {
              answer += `\n\n✅ **Task completed:** "${task.title}"`;
            }
          } catch (parseErr) {
            console.error("Error in complete_task:", parseErr);
            answer += `\n\n❌ **Error completing task:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "reopen_task") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Reopening task:", params);
            
            const { task, error: findErr } = await resolveTask(supabase, params.task_id, params.task_title_search, claimId || undefined);
            if (!task) {
              answer += `\n\n❌ **Task not found:** ${findErr}`;
              continue;
            }
            
            if (task.status === "pending") {
              answer += `\n\n⚠️ **Task already pending:** "${task.title}"`;
              continue;
            }
            
            const { error: updateError } = await supabase
              .from("tasks")
              .update({ status: "pending", completed_at: null, updated_at: new Date().toISOString() })
              .eq("id", task.id);
            
            if (updateError) {
              answer += `\n\n❌ **Failed to reopen task:** ${updateError.message}`;
            } else {
              answer += `\n\n✅ **Task reopened:** "${task.title}"`;
            }
          } catch (parseErr) {
            console.error("Error in reopen_task:", parseErr);
            answer += `\n\n❌ **Error reopening task:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "delete_task") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Deleting task:", params);
            
            const { task, error: findErr } = await resolveTask(supabase, params.task_id, params.task_title_search, claimId || undefined);
            if (!task) {
              answer += `\n\n❌ **Task not found:** ${findErr}`;
              continue;
            }
            
            const { error: deleteError } = await supabase
              .from("tasks")
              .delete()
              .eq("id", task.id);
            
            if (deleteError) {
              answer += `\n\n❌ **Failed to delete task:** ${deleteError.message}`;
            } else {
              answer += `\n\n✅ **Task deleted:** "${task.title}"`;
            }
          } catch (parseErr) {
            console.error("Error in delete_task:", parseErr);
            answer += `\n\n❌ **Error deleting task:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "list_claim_tasks") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Listing claim tasks:", params);
            
            let targetClaimId = claimId;
            let targetClaimName = claim?.policyholder_name || "";
            
            if (params.client_name) {
              const foundClaim = await findClaimByClientName(supabase, params.client_name);
              if (foundClaim) {
                targetClaimId = foundClaim.id;
                targetClaimName = foundClaim.policyholder_name;
              } else {
                answer += `\n\n❌ **No claim found** for "${params.client_name}"`;
                continue;
              }
            }
            
            if (!targetClaimId) {
              answer += `\n\n❌ **No claim specified.** Please provide a client name or use this from within a claim.`;
              continue;
            }
            
            let query = supabase
              .from("tasks")
              .select("id, title, description, status, priority, due_date, assigned_to, created_at")
              .eq("claim_id", targetClaimId)
              .order("created_at", { ascending: false });
            
            if (params.status_filter && params.status_filter !== "all") {
              query = query.eq("status", params.status_filter);
            }
            
            const { data: tasks, error: tasksError } = await query.limit(50);
            
            if (tasksError) {
              answer += `\n\n❌ **Error fetching tasks:** ${tasksError.message}`;
              continue;
            }
            
            if (!tasks || tasks.length === 0) {
              answer += `\n\nNo ${params.status_filter && params.status_filter !== "all" ? params.status_filter + " " : ""}tasks found for ${targetClaimName || "this claim"}.`;
              continue;
            }
            
            const pending = tasks.filter((t: any) => t.status === "pending");
            const completed = tasks.filter((t: any) => t.status === "completed");
            
            let result = `\n\n📋 Tasks for ${targetClaimName || "this claim"} (${pending.length} pending, ${completed.length} completed):\n\n`;
            
            if (pending.length > 0) {
              result += "PENDING:\n";
              for (const t of pending) {
                const dueDate = t.due_date ? new Date(t.due_date).toLocaleDateString() : "No due date";
                const priority = t.priority ? ` [${t.priority}]` : "";
                result += `  ⏳ ${t.title}${priority} — Due: ${dueDate}\n`;
                if (t.description) result += `     ${t.description.substring(0, 100)}\n`;
              }
            }
            
            if (completed.length > 0 && (params.status_filter === "all" || params.status_filter === "completed")) {
              result += "\nCOMPLETED:\n";
              for (const t of completed) {
                result += `  ✅ ${t.title}\n`;
              }
            }
            
            answer += result;
          } catch (parseErr) {
            console.error("Error in list_claim_tasks:", parseErr);
            answer += `\n\n❌ **Error listing tasks:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "draft_email") {
          try {
            const params = JSON.parse(toolCall.function.arguments || "{}");
            console.log("Drafting email from assistant:", params);

            const claimResolution = await resolveCommunicationClaim(
              supabase,
              params,
              claimId || null,
              claim,
            );

            if (!claimResolution.claimId || !claimResolution.claim) {
              answer += `\n\n❌ **Unable to draft email:** ${claimResolution.error || "Claim could not be resolved."}`;
              continue;
            }

            const bodyText = String(params.body || "").trim();
            if (!bodyText) {
              answer += `\n\n❌ **Unable to draft email:** body is required.`;
              continue;
            }
            const subject = buildClaimNumberSubject(claimResolution.claim, claimResolution.claimId);

            const recipientInputs = collectRecipientInputs(params, "email");
            const resolvedRecipients: ResolvedEmailRecipient[] = [];
            const recipientErrors: string[] = [];

            for (const recipientInput of recipientInputs) {
              const recipientType = normalizeRecipientType(recipientInput.recipient_type);
              if (recipientType === "insurance_company" && !recipientInput.recipient_email) {
                const carrierRecipientSet = await resolveCarrierEmailRecipientsForClaim(
                  supabase,
                  claimResolution.claim,
                  claimResolution.claimId,
                  recipientInput.recipient_name,
                );
                if (carrierRecipientSet.recipients.length > 0) {
                  resolvedRecipients.push(...carrierRecipientSet.recipients);
                }
                if (carrierRecipientSet.errors.length > 0) {
                  recipientErrors.push(...carrierRecipientSet.errors);
                }
                continue;
              }

              const resolved = await resolveEmailRecipientForClaim(
                supabase,
                claimResolution.claim,
                claimResolution.claimId,
                recipientInput,
              );
              if (resolved.recipient) {
                resolvedRecipients.push(resolved.recipient);
              } else if (resolved.error) {
                recipientErrors.push(resolved.error);
              }
            }

            const dedupedRecipients = dedupeEmailRecipients(resolvedRecipients);
            if (dedupedRecipients.length === 0) {
              answer += `\n\n❌ **Unable to draft email:** ${recipientErrors[0] || "No valid recipients found."}`;
              continue;
            }
            const carrierFacing = isCarrierFacingEmailRecipients(dedupedRecipients);

            const polishedBodyText = buildProfessionalEmailBody(
              bodyText,
              claimResolution.claim,
              dedupedRecipients[0]?.name,
            );
            const shouldInjectPhotoEvidence = shouldInjectPhotoEvidenceForEmail(
              String(question || ""),
              bodyText,
              carrierFacing,
            );
            let evidenceAwareBodyText = polishedBodyText;
            let evidenceContextUsed = false;
            let evidenceContextMissing = false;
            if (shouldInjectPhotoEvidence) {
              const evidenceContext = await buildPhotoEstimateEvidenceContext(
                supabase,
                claimResolution.claimId,
              );
              if (evidenceContext.summaryText) {
                evidenceAwareBodyText = await rewriteEmailBodyWithPhotoEstimateEvidence(
                  polishedBodyText,
                  claimResolution.claim,
                  dedupedRecipients[0]?.name,
                  evidenceContext.summaryText,
                  {
                    carrierFacing,
                    conditionNarratives: evidenceContext.conditionNarratives,
                  },
                );
                evidenceContextUsed = true;
              } else {
                evidenceContextMissing = true;
              }
            }
            const claimEmailCc = params.cc_claim_mailbox === false
              ? undefined
              : buildClaimMailboxEmail(claimResolution.claim, claimResolution.claimId);

            const draftId = crypto.randomUUID();
            communicationDrafts.push({
              draftId,
              channel: "email",
              claimId: claimResolution.claimId,
              claimReference:
                String(claimResolution.claim.claim_number || "").trim() ||
                claimResolution.claimName ||
                claimResolution.claimId,
              subject,
              body: evidenceAwareBodyText,
              claimEmailCc,
              photoEstimateEvidenceApplied: evidenceContextUsed,
              recipients: dedupedRecipients.map((recipient) => ({
                name: recipient.name,
                type: recipient.type,
                email: recipient.email,
              })),
            });

            const recipientLabel = dedupedRecipients
              .map((recipient) => `${recipient.name} <${recipient.email}>`)
              .join(", ");
            answer += `\n\n📝 **Email draft ready:** ${recipientLabel} (subject: "${subject}")`;
            answer += `\nUse the draft editor below to review/edit, then click **Approve & Send** when ready.`;
            if (evidenceContextUsed) {
              answer += `\n📸 Draft includes photo-damage findings aligned to estimate scope on file.`;
            } else if (evidenceContextMissing && shouldInjectPhotoEvidence) {
              answer += `\n⚠️ No photo/estimate evidence was found to auto-include.`;
            }
            if (recipientErrors.length > 0) {
              answer += `\n⚠️ **Skipped recipients:** ${recipientErrors.join(" | ")}`;
            }
          } catch (parseErr) {
            console.error("Error in draft_email:", parseErr);
            answer += `\n\n❌ **Error drafting email:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "send_email") {
          try {
            const params = JSON.parse(toolCall.function.arguments || "{}");
            console.log("Sending email from assistant:", params);

            const authHeader = req.headers.get("authorization");
            const supabaseUrlForInvoke = Deno.env.get("SUPABASE_URL")!;
            const supabaseServiceKeyForInvoke = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

            const claimResolution = await resolveCommunicationClaim(
              supabase,
              params,
              claimId || null,
              claim,
            );

            if (!claimResolution.claimId || !claimResolution.claim) {
              answer += `\n\n❌ **Unable to send email:** ${claimResolution.error || "Claim could not be resolved."}`;
              continue;
            }

            const bodyText = String(params.body || "").trim();
            if (!bodyText) {
              answer += `\n\n❌ **Unable to send email:** body is required.`;
              continue;
            }
            const subject = buildClaimNumberSubject(claimResolution.claim, claimResolution.claimId);

            const recipientInputs = collectRecipientInputs(params, "email");
            const resolvedRecipients: ResolvedEmailRecipient[] = [];
            const recipientErrors: string[] = [];

            for (const recipientInput of recipientInputs) {
              const recipientType = normalizeRecipientType(recipientInput.recipient_type);
              if (recipientType === "insurance_company" && !recipientInput.recipient_email) {
                const carrierRecipientSet = await resolveCarrierEmailRecipientsForClaim(
                  supabase,
                  claimResolution.claim,
                  claimResolution.claimId,
                  recipientInput.recipient_name,
                );
                if (carrierRecipientSet.recipients.length > 0) {
                  resolvedRecipients.push(...carrierRecipientSet.recipients);
                }
                if (carrierRecipientSet.errors.length > 0) {
                  recipientErrors.push(...carrierRecipientSet.errors);
                }
                continue;
              }

              const resolved = await resolveEmailRecipientForClaim(
                supabase,
                claimResolution.claim,
                claimResolution.claimId,
                recipientInput,
              );
              if (resolved.recipient) {
                resolvedRecipients.push(resolved.recipient);
              } else if (resolved.error) {
                recipientErrors.push(resolved.error);
              }
            }

            const dedupedRecipients = dedupeEmailRecipients(resolvedRecipients);
            if (dedupedRecipients.length === 0) {
              answer += `\n\n❌ **Unable to send email:** ${recipientErrors[0] || "No valid recipients found."}`;
              continue;
            }
            const carrierFacing = isCarrierFacingEmailRecipients(dedupedRecipients);

            const polishedBodyText = buildProfessionalEmailBody(
              bodyText,
              claimResolution.claim,
              dedupedRecipients[0]?.name,
            );
            const shouldInjectPhotoEvidence = shouldInjectPhotoEvidenceForEmail(
              String(question || ""),
              bodyText,
              carrierFacing,
            );
            let evidenceAwareBodyText = polishedBodyText;
            if (shouldInjectPhotoEvidence) {
              const evidenceContext = await buildPhotoEstimateEvidenceContext(
                supabase,
                claimResolution.claimId,
              );
              if (evidenceContext.summaryText) {
                evidenceAwareBodyText = await rewriteEmailBodyWithPhotoEstimateEvidence(
                  polishedBodyText,
                  claimResolution.claim,
                  dedupedRecipients[0]?.name,
                  evidenceContext.summaryText,
                  {
                    carrierFacing,
                    conditionNarratives: evidenceContext.conditionNarratives,
                  },
                );
              }
            }
            if (polishedBodyText !== bodyText) {
              console.log("Auto-polished outbound email body for professional tone");
            }
            const claimEmailCc = params.cc_claim_mailbox === false
              ? undefined
              : buildClaimMailboxEmail(claimResolution.claim, claimResolution.claimId);

            const sendResult = await invokeEdgeFunction(
              supabaseUrlForInvoke,
              "send-email",
              {
                recipients: dedupedRecipients.map((r) => ({
                  email: r.email,
                  name: r.name,
                  type: r.type,
                })),
                subject,
                body: evidenceAwareBodyText,
                claimId: claimResolution.claimId,
                claimEmailCc,
              },
              authHeader,
              supabaseServiceKeyForInvoke,
            );

            if (!sendResult.success) {
              answer += `\n\n❌ **Failed to send email:** ${sendResult.error || "Unknown error"}`;
              continue;
            }

            const recipientLabel = dedupedRecipients
              .map((r) => `${r.name} <${r.email}>`)
              .join(", ");

            emailsSent.push({
              claimId: claimResolution.claimId,
              subject,
              recipients: dedupedRecipients.map((r) => r.email),
            });

            answer += `\n\n✅ **Email sent:** ${recipientLabel} (subject: "${subject}")`;

            if (recipientErrors.length > 0) {
              answer += `\n⚠️ **Skipped recipients:** ${recipientErrors.join(" | ")}`;
            }

            const attachmentErrors = Array.isArray(sendResult.data?.attachmentErrors)
              ? sendResult.data.attachmentErrors
              : [];
            if (attachmentErrors.length > 0) {
              answer += `\n⚠️ Attachment warnings: ${attachmentErrors.join(" | ")}`;
            }
          } catch (parseErr) {
            console.error("Error in send_email:", parseErr);
            answer += `\n\n❌ **Error sending email:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "draft_sms") {
          try {
            const params = JSON.parse(toolCall.function.arguments || "{}");
            console.log("Drafting SMS from assistant:", params);

            const claimResolution = await resolveCommunicationClaim(
              supabase,
              params,
              claimId || null,
              claim,
            );
            if (!claimResolution.claimId || !claimResolution.claim) {
              answer += `\n\n❌ **Unable to draft SMS:** ${claimResolution.error || "Claim could not be resolved."}`;
              continue;
            }

            const messageBody = String(params.message_body || params.body || "").trim();
            if (!messageBody) {
              answer += `\n\n❌ **Unable to draft SMS:** message_body is required.`;
              continue;
            }

            const recipientInputs = collectRecipientInputs(params, "sms");
            const resolvedRecipients: ResolvedSmsRecipient[] = [];
            const recipientErrors: string[] = [];

            for (const recipientInput of recipientInputs) {
              const resolved = await resolveSmsRecipientForClaim(
                supabase,
                claimResolution.claim,
                claimResolution.claimId,
                recipientInput,
              );
              if (resolved.recipient) {
                resolvedRecipients.push(resolved.recipient);
              } else if (resolved.error) {
                recipientErrors.push(resolved.error);
              }
            }

            const dedupedRecipients = dedupeSmsRecipients(resolvedRecipients);
            if (dedupedRecipients.length === 0) {
              answer += `\n\n❌ **Unable to draft SMS:** ${recipientErrors[0] || "No valid recipients found."}`;
              continue;
            }

            const polishedMessageBody = buildProfessionalSmsBody(
              messageBody,
              claimResolution.claim,
              dedupedRecipients[0]?.name,
            );

            const draftId = crypto.randomUUID();
            communicationDrafts.push({
              draftId,
              channel: "sms",
              claimId: claimResolution.claimId,
              claimReference:
                String(claimResolution.claim.claim_number || "").trim() ||
                claimResolution.claimName ||
                claimResolution.claimId,
              body: polishedMessageBody,
              recipients: dedupedRecipients.map((recipient) => ({
                name: recipient.name,
                type: recipient.type,
                phone: recipient.phone,
              })),
            });

            answer += `\n\n📝 **SMS draft ready:** ${dedupedRecipients.map((recipient) => `${recipient.name} (${recipient.phone})`).join(", ")}`;
            answer += `\nUse the draft editor below to review/edit, then click **Approve & Send** when ready.`;
            if (recipientErrors.length > 0) {
              answer += `\n⚠️ **Skipped recipients:** ${recipientErrors.join(" | ")}`;
            }
          } catch (parseErr) {
            console.error("Error in draft_sms:", parseErr);
            answer += `\n\n❌ **Error drafting SMS:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "send_sms") {
          try {
            const params = JSON.parse(toolCall.function.arguments || "{}");
            console.log("Sending SMS from assistant:", params);

            const authHeader = req.headers.get("authorization");
            if (!authHeader) {
              answer += `\n\n❌ **Unable to send SMS:** Not authenticated.`;
              continue;
            }

            const supabaseUrlForInvoke = Deno.env.get("SUPABASE_URL")!;
            const supabaseServiceKeyForInvoke = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
            const messageBody = String(params.message_body || "").trim();
            if (!messageBody) {
              answer += `\n\n❌ **Unable to send SMS:** message_body is required.`;
              continue;
            }

            const claimResolution = await resolveCommunicationClaim(
              supabase,
              params,
              claimId || null,
              claim,
            );

            if (!claimResolution.claimId || !claimResolution.claim) {
              answer += `\n\n❌ **Unable to send SMS:** ${claimResolution.error || "Claim could not be resolved."}`;
              continue;
            }

            const recipientInputs = collectRecipientInputs(params, "sms");
            const resolvedRecipients: ResolvedSmsRecipient[] = [];
            const recipientErrors: string[] = [];

            for (const recipientInput of recipientInputs) {
              const resolved = await resolveSmsRecipientForClaim(
                supabase,
                claimResolution.claim,
                claimResolution.claimId,
                recipientInput,
              );
              if (resolved.recipient) {
                resolvedRecipients.push(resolved.recipient);
              } else if (resolved.error) {
                recipientErrors.push(resolved.error);
              }
            }

            const dedupedRecipients = dedupeSmsRecipients(resolvedRecipients);
            if (dedupedRecipients.length === 0) {
              answer += `\n\n❌ **Unable to send SMS:** ${recipientErrors[0] || "No valid recipients found."}`;
              continue;
            }

            const sentTo: string[] = [];
            const sendErrors: string[] = [];

            for (const recipient of dedupedRecipients) {
              const sendResult = await invokeEdgeFunction(
                supabaseUrlForInvoke,
                "send-sms",
                {
                  claimId: claimResolution.claimId,
                  toNumber: recipient.phone,
                  messageBody,
                },
                authHeader,
                supabaseServiceKeyForInvoke,
              );

              if (sendResult.success) {
                sentTo.push(`${recipient.name} (${recipient.phone})`);
              } else {
                sendErrors.push(`${recipient.name} (${recipient.phone}): ${sendResult.error || "send failed"}`);
              }
            }

            if (sentTo.length > 0) {
              smsSent.push({
                claimId: claimResolution.claimId,
                recipients: dedupedRecipients.map((r) => r.phone),
                messageBody,
              });
              answer += `\n\n✅ **SMS sent:** ${sentTo.join(", ")}`;
            }

            if (recipientErrors.length > 0) {
              answer += `\n⚠️ **Skipped recipients:** ${recipientErrors.join(" | ")}`;
            }
            if (sendErrors.length > 0) {
              answer += `\n⚠️ **SMS failures:** ${sendErrors.join(" | ")}`;
            }
            if (sentTo.length === 0) {
              answer += `\n\n❌ **Failed to send SMS.**`;
            }
          } catch (parseErr) {
            console.error("Error in send_sms:", parseErr);
            answer += `\n\n❌ **Error sending SMS:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "send_portal_notification") {
          try {
            const params = JSON.parse(toolCall.function.arguments || "{}");
            console.log("Sending portal notification from assistant:", params);

            const authHeader = req.headers.get("authorization");
            const requesterUserId = await getAuthenticatedUserId(supabase, authHeader);
            const supabaseUrlForInvoke = Deno.env.get("SUPABASE_URL")!;
            const supabaseServiceKeyForInvoke = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

            const claimResolution = await resolveCommunicationClaim(
              supabase,
              params,
              claimId || null,
              claim,
            );
            if (!claimResolution.claimId || !claimResolution.claim) {
              answer += `\n\n❌ **Unable to send portal notification:** ${claimResolution.error || "Claim could not be resolved."}`;
              continue;
            }

            const message = String(params.message || "").trim();
            if (!message) {
              answer += `\n\n❌ **Unable to send portal notification:** message is required.`;
              continue;
            }

            const notifyClient = params.notify_client !== false;
            const notifyContractors = params.notify_contractors === true;
            const explicitRecipientUserIds = Array.isArray(params.recipient_user_ids)
              ? params.recipient_user_ids.map((id: any) => String(id)).filter(Boolean)
              : [];

            const recipientResolution = await resolvePortalRecipientsForClaim(
              supabase,
              claimResolution.claim,
              claimResolution.claimId,
              {
                notifyClient,
                notifyContractors,
                explicitRecipientUserIds,
              },
            );

            if (recipientResolution.recipientIds.length === 0) {
              const reason = recipientResolution.errors[0] || "No portal recipients found.";
              answer += `\n\n❌ **Unable to send portal notification:** ${reason}`;
              continue;
            }

            const { data: updateRecord, error: updateError } = await supabase
              .from("claim_updates")
              .insert({
                claim_id: claimResolution.claimId,
                content: message,
                user_id: requesterUserId,
                update_type: "notification",
                recipients: recipientResolution.recipientIds,
              })
              .select("id")
              .single();

            if (updateError || !updateRecord?.id) {
              answer += `\n\n❌ **Failed to send portal notification:** ${updateError?.message || "Could not create claim update."}`;
              continue;
            }

            const notificationRows = recipientResolution.recipientIds.map((recipientId) => ({
              user_id: recipientId,
              claim_id: claimResolution.claimId,
              update_id: updateRecord.id,
            }));

            const { error: notificationsError } = await supabase
              .from("notifications")
              .insert(notificationRows);
            if (notificationsError) {
              console.error("Failed to insert notifications:", notificationsError);
            }

            let emailCopyStatus = "not_requested";
            if (params.send_email_copy === true && notifyClient) {
              const emailCopy = await invokeEdgeFunction(
                supabaseUrlForInvoke,
                "notify-client-claim-update",
                {
                  claimId: claimResolution.claimId,
                  changeType: "general_update",
                  customMessage: message,
                },
                authHeader,
                supabaseServiceKeyForInvoke,
              );
              emailCopyStatus = emailCopy.success
                ? "sent"
                : `failed: ${emailCopy.error || "unknown error"}`;
            }

            portalNotificationsSent.push({
              claimId: claimResolution.claimId,
              recipientIds: recipientResolution.recipientIds,
              recipientLabels: recipientResolution.recipientLabels,
              emailCopyStatus,
            });

            answer += `\n\n✅ **Portal notification sent:** ${recipientResolution.recipientLabels.join(", ")}`;
            if (recipientResolution.errors.length > 0) {
              answer += `\n⚠️ **Recipient notes:** ${recipientResolution.errors.join(" | ")}`;
            }
            if (emailCopyStatus !== "not_requested") {
              answer += `\n📧 Client email copy: ${emailCopyStatus}`;
            }
          } catch (parseErr) {
            console.error("Error in send_portal_notification:", parseErr);
            answer += `\n\n❌ **Error sending portal notification:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "create_claim_letter") {
          try {
            const params = JSON.parse(toolCall.function.arguments || "{}");
            console.log("Creating claim letter from assistant:", params);

            const authHeader = req.headers.get("authorization");
            const requesterUserId = await getAuthenticatedUserId(supabase, authHeader);
            const supabaseUrlForInvoke = Deno.env.get("SUPABASE_URL")!;
            const supabaseServiceKeyForInvoke = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

            const claimResolution = await resolveCommunicationClaim(
              supabase,
              params,
              claimId || null,
              claim,
            );
            if (!claimResolution.claimId || !claimResolution.claim) {
              answer += `\n\n❌ **Unable to create letter:** ${claimResolution.error || "Claim could not be resolved."}`;
              continue;
            }

            const subject = String(params.subject || "").trim();
            const bodyText = String(params.body || "").trim();
            if (!subject || !bodyText) {
              answer += `\n\n❌ **Unable to create letter:** subject and body are required.`;
              continue;
            }

            const recipientResolution = await resolvePreferredLetterRecipient(
              supabase,
              claimResolution.claim,
              claimResolution.claimId,
              params,
            );
            const normalizedLetterRecipientType = normalizeRecipientType(params.recipient_type);
            const carrierLetterRecipients =
              normalizedLetterRecipientType === "insurance_company"
                ? await resolveCarrierEmailRecipientsForClaim(
                    supabase,
                    claimResolution.claim,
                    claimResolution.claimId,
                    params.recipient_name,
                  )
                : null;
            const letterRecipient =
              carrierLetterRecipients?.recipients?.[0] || recipientResolution.recipient;

            const claimReference = claimResolution.claim.claim_number || claimResolution.claimId;
            const outboundEmailSubject = buildClaimNumberSubject(claimResolution.claim, claimResolution.claimId);
            const toLine = letterRecipient
              ? `${letterRecipient.name}${letterRecipient.email ? ` <${letterRecipient.email}>` : ""}`
              : (params.recipient_name || "Recipient");
            const letterText = `Date: ${new Date().toLocaleDateString()}\nClaim: ${claimReference}\nTo: ${toLine}\nSubject: ${subject}\n\n${bodyText}\n`;

            const shouldSave = params.save_to_claim_files !== false;
            let savedFile: { fileId?: string; fileName?: string; filePath?: string; error?: string } | null = null;
            if (shouldSave) {
              savedFile = await saveLetterToClaimFiles(
                supabase,
                claimResolution.claimId,
                subject,
                letterText,
                requesterUserId,
              );
              if (savedFile.error) {
                answer += `\n\n❌ **Letter created but not saved:** ${savedFile.error}`;
              }
            }

            if (params.record_communication !== false) {
              const summaryPreview = bodyText.length > 320
                ? `${bodyText.substring(0, 320)}...`
                : bodyText;
              const { error: diaryError } = await supabase
                .from("claim_communications_diary")
                .insert({
                  claim_id: claimResolution.claimId,
                  communication_type: "letter",
                  direction: "outbound",
                  contact_name: letterRecipient?.name || params.recipient_name || null,
                  contact_email: letterRecipient?.email || params.recipient_email || null,
                  contact_company:
                    letterRecipient?.type === "adjuster" || letterRecipient?.type === "insurance_company"
                      ? claimResolution.claim.insurance_company || null
                      : null,
                  summary: `Letter prepared: ${subject}\n\n${summaryPreview}`,
                  follow_up_required: false,
                  created_by: requesterUserId,
                });
              if (diaryError) {
                console.error("Failed to log letter communication:", diaryError);
              }
            }

            let emailSendStatus = "not_sent";
            if (params.send_email === true) {
              const emailRecipients =
                carrierLetterRecipients && carrierLetterRecipients.recipients.length > 0
                  ? carrierLetterRecipients.recipients
                  : letterRecipient?.email
                    ? [letterRecipient]
                    : [];

              if (emailRecipients.length === 0) {
                const carrierError = carrierLetterRecipients?.errors?.[0];
                emailSendStatus = `failed: ${carrierError || recipientResolution.error || "recipient email not found"}`;
              } else {
                const claimEmailCc = buildClaimMailboxEmail(claimResolution.claim, claimResolution.claimId);
                const sendPayload: Record<string, any> = {
                  recipients: emailRecipients.map((recipient) => ({
                    email: recipient.email,
                    name: recipient.name,
                    type: recipient.type,
                  })),
                  subject: outboundEmailSubject,
                  body: bodyText,
                  claimId: claimResolution.claimId,
                  claimEmailCc,
                };
                if (savedFile?.filePath && savedFile?.fileName) {
                  sendPayload.attachments = [
                    {
                      filePath: savedFile.filePath,
                      fileName: savedFile.fileName,
                      fileType: "text/plain",
                    },
                  ];
                }

                const sendResult = await invokeEdgeFunction(
                  supabaseUrlForInvoke,
                  "send-email",
                  sendPayload,
                  authHeader,
                  supabaseServiceKeyForInvoke,
                );
                emailSendStatus = sendResult.success
                  ? "sent"
                  : `failed: ${sendResult.error || "unknown error"}`;

                if (sendResult.success) {
                  emailsSent.push({
                    claimId: claimResolution.claimId,
                    subject: outboundEmailSubject,
                    recipients: emailRecipients.map((recipient) => recipient.email),
                  });
                }
              }
            }

            lettersCreated.push({
              claimId: claimResolution.claimId,
              subject,
              fileId: savedFile?.fileId || null,
              fileName: savedFile?.fileName || null,
              recipientEmail: letterRecipient?.email || null,
              recipientEmails:
                carrierLetterRecipients && carrierLetterRecipients.recipients.length > 0
                  ? carrierLetterRecipients.recipients.map((recipient) => recipient.email)
                  : letterRecipient?.email
                    ? [letterRecipient.email]
                    : [],
              emailSendStatus,
            });

            answer += `\n\n✅ **Letter created:** "${subject}" for claim ${claimReference}`;
            if (savedFile?.fileName) {
              answer += `\n📎 Saved to claim files as ${savedFile.fileName}`;
            } else if (!shouldSave) {
              answer += `\nℹ️ Not saved to claim files (save_to_claim_files=false).`;
            }
            if (params.send_email === true) {
              answer += `\n📧 Email delivery: ${emailSendStatus}`;
            }
            if (recipientResolution.error && !letterRecipient?.email) {
              answer += `\n⚠️ Recipient note: ${recipientResolution.error}`;
            }
          } catch (parseErr) {
            console.error("Error in create_claim_letter:", parseErr);
            answer += `\n\n❌ **Error creating letter:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "schedule_claim_call") {
          try {
            const params = JSON.parse(toolCall.function.arguments || "{}");
            console.log("Scheduling claim call from assistant:", params);

            const authHeader = req.headers.get("authorization");
            const requesterUserId = await getAuthenticatedUserId(supabase, authHeader);

            const claimResolution = await resolveCommunicationClaim(
              supabase,
              params,
              claimId || null,
              claim,
            );
            if (!claimResolution.claimId || !claimResolution.claim) {
              answer += `\n\n❌ **Unable to schedule call:** ${claimResolution.error || "Claim could not be resolved."}`;
              continue;
            }

            const callSummary = String(params.summary || "").trim();
            if (!callSummary) {
              answer += `\n\n❌ **Unable to schedule call:** summary is required.`;
              continue;
            }

            const scheduledDate = params.scheduled_date && /^\d{4}-\d{2}-\d{2}$/.test(params.scheduled_date)
              ? params.scheduled_date
              : getTodayDateString();
            const scheduledTime = params.scheduled_time
              ? String(params.scheduled_time).trim()
              : "";
            const communicationDate = buildCommunicationTimestamp(scheduledDate, scheduledTime);

            const callWithType = normalizeRecipientType(params.call_with_type) || "policyholder";
            const phoneResolution = await resolveSmsRecipientForClaim(
              supabase,
              claimResolution.claim,
              claimResolution.claimId,
              {
                recipient_type: callWithType,
                recipient_name: params.call_with_name,
                recipient_phone: params.call_with_phone,
              },
            );
            const emailResolution = await resolveEmailRecipientForClaim(
              supabase,
              claimResolution.claim,
              claimResolution.claimId,
              {
                recipient_type: callWithType,
                recipient_name: params.call_with_name,
                recipient_email: params.call_with_email,
              },
            );

            const contactName = params.call_with_name
              ? String(params.call_with_name).trim()
              : phoneResolution.recipient?.name || emailResolution.recipient?.name || claimResolution.claim.policyholder_name || "Contact";
            const contactPhone = String(params.call_with_phone || phoneResolution.recipient?.phone || "").trim() || null;
            const contactEmail = String(params.call_with_email || emailResolution.recipient?.email || "").trim() || null;

            const callSummaryLine = scheduledTime
              ? `Scheduled call for ${scheduledDate} at ${scheduledTime}: ${callSummary}`
              : `Scheduled call for ${scheduledDate}: ${callSummary}`;

            const { error: diaryError } = await supabase
              .from("claim_communications_diary")
              .insert({
                claim_id: claimResolution.claimId,
                communication_date: communicationDate,
                communication_type: "phone",
                direction: "outbound",
                contact_name: contactName,
                contact_phone: contactPhone,
                contact_email: contactEmail,
                contact_company:
                  callWithType === "adjuster" || callWithType === "insurance_company"
                    ? claimResolution.claim.insurance_company || null
                    : null,
                summary: callSummaryLine,
                follow_up_required: true,
                follow_up_date: scheduledDate,
                created_by: requesterUserId,
              });

            if (diaryError) {
              answer += `\n\n❌ **Failed to schedule call:** ${diaryError.message}`;
              continue;
            }

            let createdTaskId: string | null = null;
            if (params.create_task !== false) {
              const taskTitle = `Call ${contactName}`;
              const taskDescriptionParts = [callSummary];
              if (scheduledTime) taskDescriptionParts.push(`Time: ${scheduledTime}`);
              if (contactPhone) taskDescriptionParts.push(`Phone: ${contactPhone}`);
              if (contactEmail) taskDescriptionParts.push(`Email: ${contactEmail}`);

              const { data: callTask, error: taskError } = await supabase
                .from("tasks")
                .insert({
                  claim_id: claimResolution.claimId,
                  title: taskTitle,
                  description: taskDescriptionParts.join("\n"),
                  due_date: scheduledDate,
                  priority: params.priority || "medium",
                  assigned_to: params.assigned_to || null,
                  status: "pending",
                })
                .select("id")
                .single();

              if (taskError) {
                console.error("Failed to create scheduled call task:", taskError);
              } else {
                createdTaskId = callTask?.id || null;
              }
            }

            callsScheduled.push({
              claimId: claimResolution.claimId,
              contactName,
              scheduledDate,
              scheduledTime: scheduledTime || null,
              taskId: createdTaskId,
            });

            answer += `\n\n✅ **Call scheduled:** ${contactName} on ${scheduledDate}${scheduledTime ? ` at ${scheduledTime}` : ""}`;
            if (createdTaskId) {
              answer += `\n📋 Follow-up task created.`;
            }
            if (phoneResolution.error && !contactPhone) {
              answer += `\n⚠️ Phone note: ${phoneResolution.error}`;
            }
          } catch (parseErr) {
            console.error("Error in schedule_claim_call:", parseErr);
            answer += `\n\n❌ **Error scheduling call:** Invalid parameters`;
          }
        } else if (toolCall.function.name === "run_darwin_analysis") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            let targetClaimId = claimId;
            if (params.claim_id) targetClaimId = params.claim_id;
            if (!targetClaimId && params.client_name) {
              const found = await findClaimByClientName(supabase, params.client_name);
              if (found) targetClaimId = found.id;
            }
            if (!targetClaimId) {
              answer += "\n\nNo claim specified. Open a claim or provide a client name.";
              continue;
            }
            const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
            const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
            const res = await fetch(`${supabaseUrl}/functions/v1/darwin-ai-analysis`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ claimId: targetClaimId, analysisType: params.analysis_type }),
            });
            const json = await res.json().catch(() => ({}));
            const resultText = json.result || json.analysis || (typeof json === "string" ? json : "");
            if (resultText) {
              answer = resultText.length > 8000 ? resultText.substring(0, 8000) + "\n\n[Output truncated.]" : resultText;
            } else {
              answer += "\n\nAnalysis completed. If you don't see the full output here, check the Darwin tab for saved results.";
            }
          } catch (parseErr) {
            console.error("Error in run_darwin_analysis:", parseErr);
            answer += "\n\nFailed to run Darwin analysis. Please try again from the Darwin tab.";
          }
        } else if (toolCall.function.name === "get_claim_financial_summary") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            let targetClaimId = claimId;
            if (params.claim_id) targetClaimId = params.claim_id;
            if (!targetClaimId && params.client_name) {
              const found = await findClaimByClientName(supabase, params.client_name);
              if (found) targetClaimId = found.id;
            }
            if (!targetClaimId) {
              answer += "\n\nNo claim specified. Open a claim or provide a client name.";
              continue;
            }
            const summary = await getClaimFinancialSummary(supabase, targetClaimId);
            answer = summary;
          } catch (parseErr) {
            console.error("Error in get_claim_financial_summary:", parseErr);
            answer += "\n\nFailed to load financial summary.";
          }
        } else if (toolCall.function.name === "bulk_process_tasks") {
          try {
            const params = JSON.parse(toolCall.function.arguments);
            console.log("Bulk processing tasks:", params);
            
            // Resolve claim IDs from client names
            const resolvedClaimIds: { id: string; name: string }[] = [];
            
            if (params.claim_ids && params.claim_ids.length > 0) {
              for (const cid of params.claim_ids) {
                const { data: c } = await supabase.from("claims").select("id, policyholder_name").eq("id", cid).single();
                if (c) resolvedClaimIds.push({ id: c.id, name: c.policyholder_name });
              }
            }
            
            if (params.client_names && params.client_names.length > 0) {
              for (const name of params.client_names) {
                const found = await findClaimByClientName(supabase, name);
                if (found) {
                  resolvedClaimIds.push({ id: found.id, name: found.policyholder_name });
                } else {
                  answer += `\n⚠️ Could not find claim for "${name}"`;
                }
              }
            }
            
            if (resolvedClaimIds.length === 0) {
              answer += `\n\n❌ **No claims found** to process tasks for.`;
              continue;
            }
            
            // Get user ID for claim note insertion (RLS requires user_id)
            let bulkUserId: string | null = null;
            const bulkAuthHeader = req.headers.get("authorization");
            if (bulkAuthHeader) {
              const { data: { user: bulkUser } } = await supabase.auth.getUser(bulkAuthHeader.replace("Bearer ", ""));
              bulkUserId = bulkUser?.id || null;
            }
            
            let totalProcessed = 0;
            let totalFollowUps = 0;
            let totalNotes = 0;
            const results: string[] = [];
            
            for (const claim of resolvedClaimIds) {
              // Find tasks on this claim
              let taskQuery = supabase
                .from("tasks")
                .select("id, title, description, status, claim_id")
                .eq("claim_id", claim.id)
                .eq("status", "pending");
              
              if (params.task_title_search) {
                taskQuery = taskQuery.ilike("title", `%${params.task_title_search}%`);
              }
              
              const { data: tasks, error: fetchErr } = await taskQuery.limit(50);
              
              if (fetchErr || !tasks || tasks.length === 0) {
                results.push(`⚠️ ${claim.name}: No matching pending tasks found`);
                continue;
              }
              
              let claimProcessed = 0;
              
              for (const task of tasks) {
                const updateData: any = { updated_at: new Date().toISOString() };
                
                // Add note to description
                if (params.note) {
                  const existingDesc = task.description || "";
                  const noteTimestamp = new Date().toLocaleDateString();
                  updateData.description = existingDesc 
                    ? `${existingDesc}\n\n[${noteTimestamp}] ${params.note}`
                    : `[${noteTimestamp}] ${params.note}`;
                }
                
                // Complete the task
                if (params.complete_tasks !== false) {
                  updateData.status = "completed";
                  updateData.completed_at = new Date().toISOString();
                }
                
                const { error: updateErr } = await supabase
                  .from("tasks")
                  .update(updateData)
                  .eq("id", task.id);
                
                if (!updateErr) {
                  claimProcessed++;
                  totalProcessed++;
                }
              }
              
              // Add a claim note (claim_updates) if note provided
              if (params.note && bulkUserId) {
                const { error: noteErr } = await supabase
                  .from("claim_updates")
                  .insert({
                    claim_id: claim.id,
                    content: params.note,
                    update_type: "note",
                    user_id: bulkUserId,
                  });
                if (noteErr) {
                  console.error("Failed to insert claim note:", noteErr);
                } else {
                  totalNotes++;
                }
              }

              // Create follow-up task if requested
              if (params.create_follow_up) {
                const followUpData: any = {
                  claim_id: claim.id,
                  title: params.follow_up_title || "Follow-up",
                  description: params.follow_up_description || "",
                  priority: params.follow_up_priority || "medium",
                  status: "pending",
                };
                
                if (params.follow_up_due_date) {
                  followUpData.due_date = params.follow_up_due_date;
                }
                
                const { error: createErr } = await supabase
                  .from("tasks")
                  .insert(followUpData);
                
                if (!createErr) {
                  totalFollowUps++;
                }
              }
              
              results.push(`✅ ${claim.name}: ${claimProcessed} task(s) processed${params.note ? ' + note added' : ''}${params.create_follow_up ? ' + follow-up created' : ''}`);
            }
            
            answer += `\n\n📋 **Bulk Task Processing Complete**\n`;
            answer += `Claims: ${resolvedClaimIds.length} | Tasks processed: ${totalProcessed}${totalNotes > 0 ? ` | Notes added: ${totalNotes}` : ''}${totalFollowUps > 0 ? ` | Follow-ups created: ${totalFollowUps}` : ''}\n\n`;
            answer += results.join('\n');
            
            // Flag for UI refresh
            if (totalProcessed > 0) {
              answer += `\n\nTasks updated successfully.`;
            }
          } catch (parseErr) {
            console.error("Error in bulk_process_tasks:", parseErr);
            answer += `\n\n❌ **Error processing bulk tasks:** Invalid parameters`;
          }
        }
      }
      toolCallProcessingMs = Date.now() - toolCallStartedAt;
    }

    // If this is a report, save it as a Word document
    let savedFile = null;
    if (reportType && claimId) {
      try {
        // Get the AI Assistant Reports folder
        const { data: folder } = await supabase
          .from("claim_folders")
          .select("id")
          .eq("claim_id", claimId)
          .eq("name", "AI Assistant Reports")
          .single();

        if (folder) {
          const reportNames: Record<string, string> = {
            weather: "Weather Report",
            damage: "Damage Explanation",
            estimate: "Estimate Discussion",
            photos: "Photo Documentation Guide",
          };

          const timestamp = new Date().toISOString().split("T")[0];
          const fileName = `${reportNames[reportType] || "AI Report"} - ${timestamp}.docx`;
          const filePath = `${claimId}/${folder.id}/${crypto.randomUUID()}.docx`;

          // Create a simple Word document (using Office Open XML format)
          const docContent = createWordDocument(reportNames[reportType] || "AI Report", answer, claim);
          
          // Upload to storage
          const { data: uploadData, error: uploadError } = await supabase
            .storage
            .from("claim-files")
            .upload(filePath, docContent, {
              contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              upsert: false,
            });

          if (uploadError) {
            console.error("Error uploading report:", uploadError);
          } else {
            // Create file record
            const { data: fileRecord, error: fileError } = await supabase
              .from("claim_files")
              .insert({
                claim_id: claimId,
                folder_id: folder.id,
                file_name: fileName,
                file_path: filePath,
                file_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              })
              .select()
              .single();

            if (fileError) {
              console.error("Error creating file record:", fileError);
            } else {
              savedFile = {
                id: fileRecord.id,
                fileName: fileName,
                folderId: folder.id,
              };
              console.log(`Saved report: ${fileName}`);
            }
          }
        }
      } catch (saveError) {
        console.error("Error saving report:", saveError);
      }
    }

    // === PHASE 2.5: Persist document analysis to audit trail ===
    if (hasUploadedDoc && answer) {
      persistDocumentAnalysis(
        supabase, claimId, documentName, answer, crossClaimContext, sourceMode, claim
      ).catch(err => console.error('[DocAnalysis] Persist error:', err));
    }

    const evidenceUsed = {
      sourceModeRequested: sourceMode,
      strategy: evidencePlan.strategy,
      decisionReason: evidencePlan.reason,
      internal: {
        knowledgeBaseUsed: knowledgeBaseResult.chunkCount > 0,
        knowledgeRetrievalMode: knowledgeBaseResult.retrievalMode,
        knowledgeChunkCount: knowledgeBaseResult.chunkCount,
        knowledgeSourceCount: knowledgeBaseResult.sourceCount,
        topKnowledgeSources: knowledgeBaseResult.topSources,
        crossClaimUsed: Boolean(crossClaimContext),
        playbookUsed: Boolean(playbookContext),
        escalationSignalsUsed: Boolean(escalationContext),
        uploadedDocumentUsed: Boolean(hasUploadedDoc),
        claimContextUsed: Boolean(claimId),
        claimFileCount: claim?.claim_files?.length || 0,
      },
      web: {
        searched: webSearchStatus !== "not_requested",
        query: webSearchQueryUsed,
        status: webSearchStatus,
        externalSourceCount: webSearchStatus === "success" ? 1 : 0,
      },
    };

    return new Response(
      JSON.stringify({
        answer,
        reportType,
        savedFile,
        tasksCreated,
        emailsSent,
        smsSent,
        communicationDrafts,
        portalNotificationsSent,
        lettersCreated,
        callsScheduled,
        evidenceUsed,
        aiDiagnostics: {
          toolCallsTotal,
          toolCallsProcessed,
          toolCallProcessingMs,
          toolCallCapped: toolCallsTotal > MAX_TOOL_CALLS_PER_TURN,
          requestTimeoutMs: AI_GATEWAY_REQUEST_TIMEOUT_MS,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in claims-ai-assistant:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
