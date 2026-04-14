import { callWithTools } from "../_shared/ai/generate.ts";
import { callVision } from "../_shared/ai/generate.ts";
import { MODEL_VISION } from "../_shared/ai/modelRouter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkSize = 32768;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(''));
}

function extractPlainText(bytes: Uint8Array): string {
  const rawText = new TextDecoder("latin1").decode(bytes);
  const textParts: string[] = [];
  
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
  
  if (textParts.length < 5) {
    const asciiRegex = /[A-Za-z0-9][A-Za-z0-9 ,.\-\/#:@$%&()]{4,}/g;
    let asciiMatch;
    while ((asciiMatch = asciiRegex.exec(rawText)) !== null) {
      textParts.push(asciiMatch[0].trim());
    }
  }
  
  return textParts.join(' ');
}

const extractClaimInfoTool = {
  type: "function" as const,
  function: {
    name: "extract_claim_info",
    description: "Extract structured claim information from a document",
    parameters: {
      type: "object",
      properties: {
        policyholder_name: { type: "string", description: "Full name of the policyholder/insured/claimant" },
        street_address: { type: "string", description: "Street address only (e.g., '123 Main St'). Do NOT include city, state, or zip." },
        city: { type: "string", description: "City name only" },
        state: { type: "string", description: "Two-letter state abbreviation" },
        zip_code: { type: "string", description: "ZIP code (5-digit or ZIP+4)" },
        claim_number: { type: "string", description: "The insurance claim number" },
        policy_number: { type: "string", description: "The insurance policy number" },
        loss_type: { type: "string", description: "Type of loss/peril" },
        loss_date: { type: "string", description: "Date of loss in YYYY-MM-DD format" },
        insurance_company: { type: "string", description: "Name of the insurance company or carrier" },
        loss_description: { type: "string", description: "Brief description of the loss under 200 characters" },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return new Response(JSON.stringify({ error: "No file provided" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const lowerName = file.name.toLowerCase();
    const arrayBuffer = await file.arrayBuffer();
    const isPdf = lowerName.endsWith(".pdf");
    const isImage = /\.(png|jpg|jpeg|webp|gif|bmp|tiff?)$/i.test(lowerName);

    let messages: any[];

    if (isPdf || isImage) {
      const base64 = arrayBufferToBase64(arrayBuffer);
      const mimeType = isPdf ? "application/pdf" : file.type || "image/jpeg";
      
      let supplementaryText = "";
      if (isPdf) {
        supplementaryText = extractPlainText(new Uint8Array(arrayBuffer));
        if (supplementaryText.length > 15000) supplementaryText = supplementaryText.substring(0, 15000);
      }

      messages = [
        {
          role: "system",
          content: `You are a document data extractor for insurance claims. Extract key claim information from the provided document. Be precise and extract only what is explicitly stated. Do not guess or make up values. If a field is not found, do not include it.`
        },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}` } },
            { type: "text", text: `Extract all claim information from this document.${supplementaryText ? `\n\nAdditional extracted text for reference:\n${supplementaryText}` : ''}` }
          ]
        }
      ];
    } else {
      let extractedText = "";
      const bytes = new Uint8Array(arrayBuffer);
      
      if (lowerName.endsWith(".doc") || lowerName.endsWith(".docx")) {
        const textDecoder = new TextDecoder("utf-8", { fatal: false });
        const rawText = textDecoder.decode(bytes);
        const xmlTextMatches = rawText.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
        if (xmlTextMatches) {
          extractedText = xmlTextMatches.map(m => m.replace(/<[^>]+>/g, "")).join(" ");
        } else {
          extractedText = rawText.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{3,}/g, " ").trim();
        }
      } else {
        extractedText = new TextDecoder().decode(bytes);
      }

      if (!extractedText || extractedText.trim().length < 20) {
        return new Response(JSON.stringify({ 
          error: "Could not extract text from document. It may be scanned or image-based.",
          extracted: {} 
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      extractedText = extractedText.substring(0, 30000);

      messages = [
        {
          role: "system",
          content: `You are a document data extractor for insurance claims. Extract key claim information from the provided document text. Be precise and extract only what is explicitly stated. Do not guess or make up values. If a field is not found, do not include it.`
        },
        {
          role: "user",
          content: `Extract claim information from this document:\n\n${extractedText}`
        }
      ];
    }

    // Use callWithTools from shared layer
    const result = await callWithTools({
      model: MODEL_VISION,
      messages,
      tools: [extractClaimInfoTool],
      toolChoice: { type: "function", function: { name: "extract_claim_info" } },
    });
    console.log(`[extract-claim-info] model=${result.model}`);

    let extracted: any = {};
    const toolCall = result.toolCalls?.[0];
    if (toolCall?.arguments) {
      try {
        extracted = JSON.parse(toolCall.arguments);
      } catch {
        console.error("Failed to parse tool call arguments");
      }
    }

    // Normalize casing helper
    function normalizeCase(value: string): string {
      const alphaChars = value.replace(/[^a-zA-Z]/g, '');
      if (alphaChars.length < 2) return value;
      const upperCount = (value.match(/[A-Z]/g) || []).length;
      if (upperCount / alphaChars.length < 0.7) return value;

      return value
        .toLowerCase()
        .replace(/(?:^|\s|[-/])\S/g, (ch) => ch.toUpperCase());
    }

    const titleCaseFields = ['policyholder_name', 'street_address', 'city', 'insurance_company', 'loss_type', 'loss_description'];
    const upperFields = ['state'];

    for (const key of Object.keys(extracted)) {
      const val = extracted[key];
      if (!val || typeof val !== 'string' || val.trim() === "" || 
          val.toLowerCase().includes("not found") || val.toLowerCase().includes("not available") ||
          val.toLowerCase().includes("n/a") || val.toLowerCase() === "unknown") {
        delete extracted[key];
        continue;
      }
      if (titleCaseFields.includes(key)) {
        extracted[key] = normalizeCase(val);
      } else if (upperFields.includes(key)) {
        extracted[key] = val.toUpperCase();
      }
    }

    console.log("Extracted claim info:", JSON.stringify(extracted));

    return new Response(JSON.stringify({ extracted }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("extract-claim-info error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
