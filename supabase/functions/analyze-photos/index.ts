import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { callVision, generate } from "../_shared/ai/generate.ts";
import { MODEL_VISION, MODEL_CHEAP } from "../_shared/ai/modelRouter.ts";

declare const EdgeRuntime: {
  waitUntil: (promise: Promise<any>) => void;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Batch size for processing photos - reduced for faster processing
const BATCH_SIZE = 15;
// Maximum photos to process in a single request to avoid timeouts
const MAX_PHOTOS = 30;

// Fetch historical weather data using Visual Crossing API
async function fetchWeatherData(address: string, lossDate: string): Promise<any> {
  try {
    const VISUAL_CROSSING_API_KEY = Deno.env.get("VISUAL_CROSSING_API_KEY");
    
    if (!VISUAL_CROSSING_API_KEY) {
      console.log("Visual Crossing API key not configured");
      return null;
    }
    
    const date = new Date(lossDate);
    const startDate = new Date(date);
    startDate.setDate(date.getDate() - 1);
    const endDate = new Date(date);
    endDate.setDate(date.getDate() + 1);
    
    const formatDate = (d: Date) => d.toISOString().split('T')[0];
    
    const weatherUrl = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${encodeURIComponent(address)}/${formatDate(startDate)}/${formatDate(endDate)}?unitGroup=us&include=days,hours,alerts&key=${VISUAL_CROSSING_API_KEY}&contentType=json`;
    
    console.log("Fetching weather from Visual Crossing for:", address);
    const weatherResponse = await fetch(weatherUrl);
    
    if (!weatherResponse.ok) {
      const errorText = await weatherResponse.text();
      console.log("Visual Crossing API error:", weatherResponse.status, errorText);
      return null;
    }
    
    const weatherData = await weatherResponse.json();
    
    if (!weatherData || !weatherData.days) {
      console.log("No weather data returned from Visual Crossing");
      return null;
    }
    
    const lossDateStr = formatDate(date);
    const dayIndex = weatherData.days.findIndex((d: any) => d.datetime === lossDateStr);
    
    const daily = {
      dates: weatherData.days.map((d: any) => d.datetime),
      maxTemp: weatherData.days.map((d: any) => d.tempmax),
      minTemp: weatherData.days.map((d: any) => d.tempmin),
      precipitation: weatherData.days.map((d: any) => d.precip || 0),
      rain: weatherData.days.map((d: any) => d.precip || 0),
      maxWindSpeed: weatherData.days.map((d: any) => d.windspeed || 0),
      maxWindGusts: weatherData.days.map((d: any) => d.windgust || 0),
      weatherDescription: weatherData.days.map((d: any) => d.conditions || 'Unknown'),
      humidity: weatherData.days.map((d: any) => d.humidity || 0),
      uvIndex: weatherData.days.map((d: any) => d.uvindex || 0),
      visibility: weatherData.days.map((d: any) => d.visibility || 0),
      pressure: weatherData.days.map((d: any) => d.pressure || 0),
      cloudcover: weatherData.days.map((d: any) => d.cloudcover || 0),
      severerisk: weatherData.days.map((d: any) => d.severerisk || 0),
      description: weatherData.days.map((d: any) => d.description || ''),
      icon: weatherData.days.map((d: any) => d.icon || ''),
      source: weatherData.days.map((d: any) => d.source || 'Visual Crossing')
    };
    
    const hourly: any = {
      time: [],
      temperature: [],
      precipitation: [],
      windSpeed: [],
      windGusts: [],
      conditions: [],
      humidity: [],
      cloudcover: []
    };
    
    weatherData.days.forEach((day: any) => {
      if (day.hours) {
        day.hours.forEach((hour: any) => {
          hourly.time.push(`${day.datetime}T${hour.datetime}`);
          hourly.temperature.push(hour.temp);
          hourly.precipitation.push(hour.precip || 0);
          hourly.windSpeed.push(hour.windspeed || 0);
          hourly.windGusts.push(hour.windgust || 0);
          hourly.conditions.push(hour.conditions || '');
          hourly.humidity.push(hour.humidity || 0);
          hourly.cloudcover.push(hour.cloudcover || 0);
        });
      }
    });
    
    const alerts = weatherData.alerts || [];
    
    return {
      location: weatherData.resolvedAddress || address,
      latitude: weatherData.latitude,
      longitude: weatherData.longitude,
      timezone: weatherData.timezone,
      lossDate: lossDateStr,
      daily,
      hourly,
      alerts,
      dayIndex: dayIndex >= 0 ? dayIndex : 1,
      source: 'Visual Crossing'
    };
  } catch (error) {
    console.error("Error fetching weather data:", error);
    return null;
  }
}

// Process a batch of photos with the AI using Lovable AI
async function processBatch(
  imageContents: any[],
  photoDescriptions: string[],
  batchNumber: number,
  totalBatches: number,
  systemPrompt: string,
  basePrompt: string,
): Promise<string> {
  const batchPrompt = totalBatches > 1 
    ? `${basePrompt}\n\n[BATCH ${batchNumber} of ${totalBatches}]\nThis batch contains photos ${photoDescriptions.map(d => d.split(':')[0]).join(', ')}.`
    : basePrompt;

  console.log(`[analyze-photos] Processing batch ${batchNumber}/${totalBatches} with ${imageContents.length} images, model: ${MODEL_VISION}`);

  const visionResult = await callVision({
    model: MODEL_VISION,
    maxTokens: 8192,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: batchPrompt + "\n\nPhoto Information:\n" + photoDescriptions.join('\n') },
          ...imageContents
        ]
      }
    ],
  });

  return visionResult.text;
}

// Combine batch results into a cohesive report using Lovable AI
async function combineResults(
  batchResults: string[],
  reportType: string,
  claimContext: string,
): Promise<string> {
  if (batchResults.length === 1) {
    return batchResults[0];
  }

  console.log(`[analyze-photos] Combining ${batchResults.length} batch results via shared AI layer`);

  const combinePrompt = `You are an expert forensic analyst. You have received analysis results from multiple batches of photos for the same insurance claim. 
Your task is to combine these into a single, cohesive ${reportType} report. 

IMPORTANT INSTRUCTIONS:
- Merge the analyses into one unified document
- Remove any duplicate information
- Maintain consistent photo numbering across all sections
- Ensure the final report flows naturally as if analyzing all photos together
- Keep all photo references and damage observations
- Combine similar findings into consolidated sections

${claimContext}

Here are the batch results to combine:

${batchResults.map((r, i) => `=== BATCH ${i + 1} ANALYSIS ===\n${r}\n`).join('\n')}

Create a single, unified report that incorporates all the above analyses.`;

  try {
    const result = await generate({
      task: "summary",
      system: "You are an expert at combining forensic analysis reports into cohesive documents.",
      user: combinePrompt,
      searchMode: "off",
    });
    return result.text;
  } catch (e) {
    console.error("[analyze-photos] Combine request failed, returning concatenated results");
    return batchResults.join('\n\n---\n\n');
  }
}

// Extract referenced photo numbers and their context from the AI report
async function extractPhotoReferences(
  reportContent: string,
  photoDescriptions: string[],
): Promise<{ photoNumber: number; aiContext: string }[]> {
  console.log("[analyze-photos] Extracting photo references via shared AI layer");

  const extractPrompt = `Analyze this forensic report and extract all photo references with their analysis context.

REPORT:
${reportContent}

AVAILABLE PHOTOS:
${photoDescriptions.join('\n')}

For each photo mentioned in the report (Photo 1, Photo 2, etc.), extract:
1. The photo number
2. A brief summary of what the AI said about that photo (1-2 sentences capturing the key damage/finding)

Return a JSON array like this:
[
  {"photoNumber": 1, "aiContext": "Shows severe hail impact damage on north-facing roof slope with granule loss and bruising."},
  {"photoNumber": 3, "aiContext": "Documents displaced ridge cap shingles with visible nail pops from wind uplift."}
]

Only include photos that are actually referenced and analyzed in the report. Return ONLY the JSON array, no other text.`;

  try {
    const result = await generate({
      task: "extraction",
      system: "You extract photo references from forensic reports. Return only valid JSON arrays.",
      user: extractPrompt,
      searchMode: "off",
      jsonMode: true,
    });

    const content = result.text;
    
    let jsonStr = content.trim();
    if (jsonStr.startsWith("```json")) jsonStr = jsonStr.slice(7);
    if (jsonStr.startsWith("```")) jsonStr = jsonStr.slice(3);
    if (jsonStr.endsWith("```")) jsonStr = jsonStr.slice(0, -3);
    jsonStr = jsonStr.trim();

    // Try to find array in response
    const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const references = JSON.parse(arrayMatch[0]);
      console.log(`[analyze-photos] Extracted ${references.length} photo references`);
      return references;
    }

    const references = JSON.parse(jsonStr);
    console.log(`[analyze-photos] Extracted ${references.length} photo references`);
    return references;
  } catch (error) {
    console.error("Error extracting photo references:", error);
    return [];
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { photoIds, claimId, reportType, weatherOnly, documentIds, checkJob } = await req.json();
    
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Poll for existing job result
    if (checkJob) {
      const { data: result } = await supabase
        .from("darwin_analysis_results")
        .select("*")
        .eq("id", checkJob)
        .single();
      
      if (result) {
        return new Response(
          JSON.stringify({ 
            status: "complete",
            report: result.result,
            reportType: result.analysis_type,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      return new Response(
        JSON.stringify({ status: "processing" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    // Handle weather-only preview requests
    if (weatherOnly && claimId) {
      const { data: claim } = await supabase
        .from("claims")
        .select("policyholder_address, loss_date")
        .eq("id", claimId)
        .single();
      
      if (!claim || !claim.policyholder_address || !claim.loss_date) {
        return new Response(
          JSON.stringify({ error: "Claim missing address or loss date for weather lookup" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      const weatherData = await fetchWeatherData(claim.policyholder_address, claim.loss_date);
      
      return new Response(
        JSON.stringify({ weatherData }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    if (!photoIds || !Array.isArray(photoIds) || photoIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "No photos provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Limit photos to prevent timeout
    const limitedPhotoIds = photoIds.slice(0, MAX_PHOTOS);
    const wasLimited = photoIds.length > MAX_PHOTOS;
    if (wasLimited) {
      console.log(`Photo count limited from ${photoIds.length} to ${MAX_PHOTOS} to prevent timeout`);
    }

    // Shared AI layer handles API keys internally

    // supabase client already initialized above

    // ── State detection for demand packets ────────────────────────────────
    const stateRegulationsLookup: Record<string, { stateName: string; badFaithStatute: string; adminCode: string; promptPayDays: number; acknowledgmentDays: number; decisionDays: number }> = {
      PA: { stateName: 'Pennsylvania', badFaithStatute: '42 Pa.C.S. § 8371', adminCode: '31 Pa. Code Chapter 146', promptPayDays: 15, acknowledgmentDays: 10, decisionDays: 30 },
      NJ: { stateName: 'New Jersey', badFaithStatute: 'N.J.S.A. 17:29B-4', adminCode: 'N.J.A.C. 11:2-17', promptPayDays: 30, acknowledgmentDays: 10, decisionDays: 30 },
      TX: { stateName: 'Texas', badFaithStatute: 'Texas Insurance Code Chapter 541', adminCode: '28 TAC § 21.203', promptPayDays: 5, acknowledgmentDays: 15, decisionDays: 15 },
      FL: { stateName: 'Florida', badFaithStatute: 'F.S. § 624.155', adminCode: 'Fla. Admin. Code 69O-166', promptPayDays: 20, acknowledgmentDays: 14, decisionDays: 90 },
    };

    function detectStateFromAddress(address: string | null): string | null {
      if (!address) return null;
      const upper = address.toUpperCase();
      const zipMatch = upper.match(/[,\s]([A-Z]{2})[,\s]+\d{5}/);
      if (zipMatch && stateRegulationsLookup[zipMatch[1]]) return zipMatch[1];
      const boundaryMatch = upper.match(/\b(PA|NJ|TX|FL|NY)\b/);
      if (boundaryMatch && stateRegulationsLookup[boundaryMatch[1]]) return boundaryMatch[1];
      if (/PENNSYLVANIA/.test(upper)) return 'PA';
      if (/NEW\s+JERSEY/.test(upper)) return 'NJ';
      if (/TEXAS/.test(upper)) return 'TX';
      if (/FLORIDA/.test(upper)) return 'FL';
      return null;
    }

    // Fetch claim details
    let claimContext = "";
    let weatherData: any = null;
    let weatherContext = "";
    let claimData: any = null;
    let supportingDocsContext = "";
    let supportingDocsInfo: { name: string; url: string }[] = [];
    let detectedStateCode: string | null = null;
    let stateRegContext = "";
    
    if (claimId) {
      const { data: claim } = await supabase
        .from("claims")
        .select("*")
        .eq("id", claimId)
        .single();
      
      if (claim) {
        claimData = claim;

        // Detect state: state_code column > address parse > NO default
        detectedStateCode = (claim as any).state_code || detectStateFromAddress(claim.policyholder_address) || null;
        console.log(`[analyze-photos] State detection: state_code="${(claim as any).state_code}", parsed="${detectStateFromAddress(claim.policyholder_address)}", final="${detectedStateCode}"`);

        const stateReg = detectedStateCode ? stateRegulationsLookup[detectedStateCode] : null;
        if (stateReg) {
          stateRegContext = `
JURISDICTION: ${stateReg.stateName} (${detectedStateCode})
- Bad Faith Statute: ${stateReg.badFaithStatute}
- Administrative Code: ${stateReg.adminCode}
- Prompt Pay: ${stateReg.promptPayDays} days
- Acknowledgment Required: ${stateReg.acknowledgmentDays} days
- Decision Required: ${stateReg.decisionDays} days

CRITICAL: You MUST cite ONLY ${stateReg.stateName} insurance codes and regulations. Do NOT cite regulations from any other state.`;
        } else {
          stateRegContext = `
JURISDICTION: Could not be determined from claim address.
CRITICAL: Do NOT cite any state-specific insurance codes or regulations. Use only federal/general industry standards until jurisdiction is confirmed.`;
        }

        claimContext = `
Claim Information:
- Claim Number: ${claim.claim_number || 'N/A'}
- Policyholder: ${claim.policyholder_name || 'N/A'}
- Property Address: ${claim.policyholder_address || 'N/A'}
- Jurisdiction: ${stateReg ? `${stateReg.stateName} (${detectedStateCode})` : 'UNKNOWN — do not cite state codes'}
- Loss Date: ${claim.loss_date || 'N/A'}
- Loss Type: ${claim.loss_type || 'N/A'}
- Loss Description: ${claim.loss_description || 'N/A'}
- Insurance Company: ${claim.insurance_company || 'N/A'}
${stateRegContext}
`;

        // Fetch supporting documents for demand packages
        if (reportType === 'demand-package' && documentIds && documentIds.length > 0) {
          console.log(`Fetching ${documentIds.length} supporting documents...`);
          
          const { data: docs } = await supabase
            .from("claim_files")
            .select("id, file_name, file_path, file_type")
            .in("id", documentIds);
          
          if (docs && docs.length > 0) {
            const docDescriptions: string[] = [];
            
            for (const doc of docs) {
              // Get signed URL for each document
              const { data: signedUrl } = await supabase.storage
                .from("claim-files")
                .createSignedUrl(doc.file_path, 3600);
              
              if (signedUrl?.signedUrl) {
                supportingDocsInfo.push({
                  name: doc.file_name,
                  url: signedUrl.signedUrl
                });
                docDescriptions.push(`- ${doc.file_name} (${doc.file_type || 'document'})`);
              }
            }
            
            if (docDescriptions.length > 0) {
              supportingDocsContext = `

SUPPORTING EVIDENCE DOCUMENTS INCLUDED:
The following supporting documents from the claim file are being included as exhibits:
${docDescriptions.join('\n')}

When creating the demand package, reference these supporting documents in the appropriate sections and note that they are included as exhibits.
`;
              console.log(`Added ${docDescriptions.length} supporting documents to context`);
            }
          }
        }

        // Fetch weather data for demand packages
        if (reportType === 'demand-package' && claim.policyholder_address && claim.loss_date) {
          console.log("Fetching weather data for demand package...");
          weatherData = await fetchWeatherData(claim.policyholder_address, claim.loss_date);
          
          if (weatherData && weatherData.daily) {
            const idx = weatherData.dayIndex >= 0 ? weatherData.dayIndex : 1;
            
            let alertsContext = "";
            if (weatherData.alerts && weatherData.alerts.length > 0) {
              alertsContext = `
Weather Alerts Active During Loss Period:
${weatherData.alerts.map((a: any) => `- ${a.event || 'Alert'}: ${a.headline || a.description || 'Weather alert issued'}`).join('\n')}
`;
            }
            
            weatherContext = `

HISTORICAL WEATHER DATA (Loss Date: ${weatherData.lossDate}):
Data Source: Visual Crossing Weather Services
Location: ${weatherData.location}
Coordinates: ${weatherData.latitude}, ${weatherData.longitude}
Timezone: ${weatherData.timezone || 'N/A'}
${alertsContext}
Weather on Loss Date (${weatherData.daily.dates?.[idx]}):
- Conditions: ${weatherData.daily.weatherDescription?.[idx] || 'N/A'}
- Description: ${weatherData.daily.description?.[idx] || 'N/A'}
- High Temperature: ${weatherData.daily.maxTemp?.[idx]}°F
- Low Temperature: ${weatherData.daily.minTemp?.[idx]}°F
- Precipitation: ${weatherData.daily.precipitation?.[idx]} inches
- Max Wind Speed: ${weatherData.daily.maxWindSpeed?.[idx]} mph
- Max Wind Gusts: ${weatherData.daily.maxWindGusts?.[idx]} mph
- Humidity: ${weatherData.daily.humidity?.[idx]}%
- Cloud Cover: ${weatherData.daily.cloudcover?.[idx]}%
- UV Index: ${weatherData.daily.uvIndex?.[idx]}
- Visibility: ${weatherData.daily.visibility?.[idx]} miles
- Severe Risk: ${weatherData.daily.severerisk?.[idx]}%

Day Before (${weatherData.daily.dates?.[0]}):
- Conditions: ${weatherData.daily.weatherDescription?.[0] || 'N/A'}
- Max Wind Speed: ${weatherData.daily.maxWindSpeed?.[0]} mph
- Max Wind Gusts: ${weatherData.daily.maxWindGusts?.[0]} mph
- Precipitation: ${weatherData.daily.precipitation?.[0]} inches

Day After (${weatherData.daily.dates?.[2]}):
- Conditions: ${weatherData.daily.weatherDescription?.[2] || 'N/A'}
- Max Wind Speed: ${weatherData.daily.maxWindSpeed?.[2]} mph
- Max Wind Gusts: ${weatherData.daily.maxWindGusts?.[2]} mph
- Precipitation: ${weatherData.daily.precipitation?.[2]} inches
`;
            console.log("Weather data fetched successfully from Visual Crossing");
          }
        }
      }
    }

    // Fetch photos with signed URLs (using limited list)
    const { data: photos, error: photosError } = await supabase
      .from("claim_photos")
      .select("*")
      .in("id", limitedPhotoIds);

    if (photosError || !photos || photos.length === 0) {
      return new Response(
        JSON.stringify({ error: "Photos not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Analyzing ${photos.length} photos for claim ${claimId} (batch size: ${BATCH_SIZE}, max: ${MAX_PHOTOS})`);
    if (wasLimited) {
      console.log(`Note: ${photoIds.length - MAX_PHOTOS} additional photos were excluded due to limits`);
    }

    // Get signed URLs and build image content for AI
    const allImageContents: any[] = [];
    const allPhotoDescriptions: string[] = [];
    const photoUrls: { url: string; fileName: string; category: string; description: string; photoNumber: number }[] = [];
    
    let photoNumber = 1;
    for (const photo of photos) {
      const path = photo.annotated_file_path || photo.file_path;
      const { data: signedUrl } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(path, 3600);
      
      if (signedUrl?.signedUrl) {
        allImageContents.push({
          type: "image_url",
          image_url: { url: signedUrl.signedUrl }
        });
        allPhotoDescriptions.push(`Photo ${photoNumber}: ${photo.file_name} | Category: ${photo.category} | Description: ${photo.description || 'No description'}`);
        photoUrls.push({
          url: signedUrl.signedUrl,
          fileName: photo.file_name,
          category: photo.category || 'Uncategorized',
          description: photo.description || '',
          photoNumber: photoNumber
        });
        photoNumber++;
      }
    }

    if (allImageContents.length === 0) {
      return new Response(
        JSON.stringify({ error: "Could not load any photos" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build system prompt
    const systemPrompt = `You are an expert forensic property damage analyst and licensed public adjuster preparing detailed forensic analyses for insurance claims. Your reports must be thorough, persuasive, and provide strong supporting arguments for the claim.

CRITICAL INSTRUCTIONS:
- Reference photos by their number (Photo 1, Photo 2, etc.) throughout your analysis
- For EACH photo, provide DETAILED forensic analysis including:
  * Specific damage indicators visible (cracks, displacement, missing materials, staining, etc.)
  * Measurements or size estimates when visible
  * Damage severity assessment with justification
  * How the visible damage connects to the reported loss event
  * What this specific damage means for the integrity/function of the affected component
- Reference applicable manufacturer specifications, building codes (IRC, IBC), and industry standards (ASTM, ARMA, NRCA)
- For roofing damage: restoration requires FULL REPLACEMENT of each damaged slope/section per manufacturer warranty requirements
- Provide SPECIFIC arguments for why the damage requires replacement vs repair
- Do NOT include: action items, document gathering suggestions, coverage advice, or specialist inspection recommendations
- IMPORTANT: When referencing weather data, ALWAYS attribute it to "Visual Crossing Weather Services"

CRITICAL LANGUAGE RESTRICTIONS:
- NEVER use the words "deterioration", "deteriorated", "rot", "rotted", "rotting", or "decay" in any output.
- You may use "weathering" or "weathered" ONLY when discussing depreciation amounts or age-related value reduction. Never use weathering to describe damage causation or to minimize the scope of repairs needed.
- Focus on describing damage in terms of the loss event (e.g. impact damage, wind damage, water intrusion, displacement, cracking, missing materials).

WRITING STYLE:
- Write in a professional, authoritative tone suitable for insurance claim documentation
- Use technical terminology but explain implications
- Be specific and detailed - avoid vague statements
- Build a compelling narrative connecting the loss event to the observed damage

JURISDICTION COMPLIANCE:
- When citing state insurance codes, statutes, or regulatory deadlines, you MUST use ONLY the jurisdiction specified in the claim context.
- NEVER default to Pennsylvania codes unless the claim is explicitly in Pennsylvania.
- If no jurisdiction is specified, do NOT cite any state-specific regulations — use only general industry standards.`;
    // Build user prompt based on report type
    let userPrompt = "";
    
    switch (reportType) {
      case "damage-assessment":
        userPrompt = `Analyze these photos and create a Forensic Damage Assessment Report.

${claimContext}

Please provide:
1. **Executive Summary** - Brief overview of all damage observed and restoration requirements
2. **Forensic Damage Analysis** - For each photo/area:
   - Type and extent of damage visible
   - Severity assessment (minor/moderate/severe/critical)
   - Cause of damage based on the loss type
   - Evidence of how the damage occurred
3. **Restoration Requirements** - To return the property to pre-loss condition:
   - Applicable manufacturer specifications
   - Relevant building codes and standards
   - Materials and components needed
4. **Hidden/Secondary Damage** - Potential underlying damage based on visible indicators`;
        break;
        
      case "before-after":
        userPrompt = `Analyze these before/after comparison photos and create a Forensic Progress Report.

${claimContext}

Please provide:
1. **Condition Comparison** - Overview of pre-loss vs current conditions
2. **Damage Documentation** - What damage is visible in the "before" photos
3. **Repair Analysis** - What repairs are visible in the "after" photos
4. **Code Compliance** - Whether visible repairs meet building codes
5. **Outstanding Restoration** - Any remaining work needed`;
        break;
        
      case "quick-analysis":
        userPrompt = `Quickly analyze these photos and provide a forensic summary.

${claimContext}

Please provide a brief forensic analysis including:
- Main types of damage visible and their severity
- Key restoration requirements
- Applicable building codes or manufacturer specs`;
        break;

      case "proof-of-loss":
        userPrompt = `Create a detailed Proof of Loss / Valuation Report based on these photos.

${claimContext}

Please provide a comprehensive Proof of Loss document including:

## SWORN STATEMENT IN PROOF OF LOSS

### I. PROPERTY DESCRIPTION
- Property location and type
- Age and construction type (if visible)
- Areas affected by the loss

### II. DAMAGE DOCUMENTATION
For each damaged area:
- Photo reference numbers
- Detailed description of damage observed
- Forensic indicators of cause

### III. SCOPE OF WORK REQUIRED
- Full replacement requirements per manufacturer warranty
- Building code compliance requirements
- Materials & specifications needed

### IV. VALUATION SUMMARY
- Summary of all work required`;
        break;

      case "final-demand": {
        const stateLabel = detectedStateCode && stateRegulationsLookup[detectedStateCode]
          ? `${stateRegulationsLookup[detectedStateCode].stateName} Insurance Codes (${stateRegulationsLookup[detectedStateCode].adminCode}, ${stateRegulationsLookup[detectedStateCode].badFaithStatute})`
          : 'Applicable State Insurance Codes';
        userPrompt = `Create a Final Demand Letter based on these photos documenting property damage.

${claimContext}

Please create a professional Final Demand Letter including:

## NOTICE OF FINAL DEMAND

### I. FACTUAL BACKGROUND
### II. DAMAGE ANALYSIS
### III. RESTORATION REQUIREMENTS
### IV. PROSPECTIVE LIABILITY (${stateLabel})
### V. DEMAND FOR PAYMENT
### VI. CONCLUSION`;
        break;
      }
        break;

      case "demand-package": {
        const dpStateLabel = detectedStateCode && stateRegulationsLookup[detectedStateCode]
          ? `${stateRegulationsLookup[detectedStateCode].stateName} Insurance Codes (${stateRegulationsLookup[detectedStateCode].adminCode}, ${stateRegulationsLookup[detectedStateCode].badFaithStatute})`
          : 'Applicable State Insurance Codes';
        userPrompt = `Create a COMPLETE DEMAND PACKAGE based on these photos documenting property damage.

${claimContext}
${weatherContext}
${supportingDocsContext}

Create a comprehensive demand package structured as follows:

## I. FINAL DEMAND LETTER
## II. DAMAGE ANALYSIS
## III. PROOF OF LOSS / VALUATION
## IV. RESTORATION REQUIREMENTS
## V. PROSPECTIVE LIABILITY (${dpStateLabel})
## VI. DEMAND FOR PAYMENT

${weatherData ? 'Include weather data in the analysis sections.' : ''}
${supportingDocsInfo.length > 0 ? 'Reference the supporting evidence documents in relevant sections and note they are attached as exhibits.' : ''}`;
        break;
      }
        
      default: // full-report
        userPrompt = `Create a comprehensive Forensic Photo Documentation Report with detailed analysis of each photo.

${claimContext}

## I. EXECUTIVE SUMMARY
## II. DETAILED PHOTO-BY-PHOTO FORENSIC ANALYSIS
## III. CAUSE OF LOSS CORRELATION
## IV. RESTORATION REQUIREMENTS
## V. CONSEQUENCES OF INADEQUATE RESTORATION
## VI. CONCLUSION`;
    }

    // Process photos in batches
    const totalBatches = Math.ceil(allImageContents.length / BATCH_SIZE);
    const batchResults: string[] = [];

    console.log(`Processing ${allImageContents.length} photos in ${totalBatches} batch(es)...`);

    for (let i = 0; i < totalBatches; i++) {
      const startIdx = i * BATCH_SIZE;
      const endIdx = Math.min(startIdx + BATCH_SIZE, allImageContents.length);
      
      const batchImages = allImageContents.slice(startIdx, endIdx);
      const batchDescriptions = allPhotoDescriptions.slice(startIdx, endIdx);
      
      let batchResult: string | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          batchResult = await processBatch(
            batchImages,
            batchDescriptions,
            i + 1,
            totalBatches,
            systemPrompt,
            userPrompt,
          );
          batchResults.push(batchResult);
          console.log(`Batch ${i + 1}/${totalBatches} complete, result length: ${batchResult.length}`);
          break;
        } catch (error) {
          console.error(`Batch ${i + 1} attempt ${attempt + 1} failed:`, error);
          if (attempt === 0) {
            console.log(`Retrying batch ${i + 1}...`);
            await new Promise(r => setTimeout(r, 2000));
          }
          // Continue with other batches after final attempt
        }
      }
    }

    if (batchResults.length === 0) {
      return new Response(
        JSON.stringify({ error: "All batches failed. Please try again with fewer photos." }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Combine batch results
    let reportContent: string;
    if (batchResults.length > 1) {
      reportContent = await combineResults(batchResults, reportType, claimContext);
    } else {
      reportContent = batchResults[0];
    }

    console.log("Photo analysis complete, final report length:", reportContent.length);

    // ── STATE CITATION WATCHDOG — scan for wrong-state references ──────
    const STATE_CITATION_PATTERNS: Record<string, RegExp[]> = {
      PA: [/31\s*Pa\.\s*Code/i, /40\s*P\.S\./i, /42\s*Pa\.C\.S/i, /Pennsylvania\s+(Insurance\s+Code|Unfair)/i],
      NJ: [/N\.J\.S\.A\./i, /N\.J\.A\.C\./i, /New\s+Jersey\s+(Insurance|Unfair|Admin)/i, /11:2-17/],
      TX: [/Texas\s+Insurance\s+Code/i, /28\s*TAC/i],
      FL: [/F\.S\.\s*§\s*624/i, /69O-166/i, /Florida\s+(Statute|Insurance)/i],
      NY: [/N\.Y\.\s*Ins\.\s*Law/i, /11\s*NYCRR/i],
    };
    let citationViolations: string[] = [];
    if (detectedStateCode && reportContent) {
      for (const [st, patterns] of Object.entries(STATE_CITATION_PATTERNS)) {
        if (st === detectedStateCode) continue;
        for (const pattern of patterns) {
          const matches = reportContent.match(new RegExp(pattern.source, 'gi'));
          if (matches) {
            matches.forEach(m => citationViolations.push(`Found ${st} citation "${m}" in output for ${detectedStateCode} claim`));
          }
        }
      }
      if (citationViolations.length > 0) {
        console.warn(`[WATCHDOG] ⚠️ WRONG-STATE CITATIONS in photo report (state=${detectedStateCode}):`);
        citationViolations.forEach(v => console.warn(`  → ${v}`));
      }
    }

    // Extract which photos the AI referenced in its analysis
    const referencedPhotos = await extractPhotoReferences(reportContent, allPhotoDescriptions, LOVABLE_API_KEY);
    
    // Map referenced photo numbers to their full photo data with AI context
    const referencedPhotoData = referencedPhotos.map(ref => {
      const photoData = photoUrls.find(p => p.photoNumber === ref.photoNumber);
      return photoData ? {
        ...photoData,
        aiContext: ref.aiContext
      } : null;
    }).filter(Boolean);

    console.log(`AI referenced ${referencedPhotoData.length} photos in report`);

    // Save report to darwin_analysis_results so it persists even if connection drops
    const jobId = crypto.randomUUID();
    const { error: saveError } = await supabase
      .from("darwin_analysis_results")
      .insert({
        id: jobId,
        claim_id: claimId,
        analysis_type: `photo_report_${reportType}`,
        result: reportContent,
        input_summary: `${photos.length} photos analyzed, ${referencedPhotoData.length} referenced`,
      });
    
    if (saveError) {
      console.error("Failed to save report to database:", saveError);
    } else {
      console.log("Report saved to database with jobId:", jobId);
    }

    const responseData: any = { 
      report: reportContent,
      jobId,
      photoCount: photos.length,
      reportType,
      photoUrls: photoUrls,
      referencedPhotos: referencedPhotoData,
      weatherData: weatherData,
      supportingDocs: supportingDocsInfo,
      batchesProcessed: batchResults.length,
      totalBatches,
      wasLimited,
      originalPhotoCount: photoIds.length,
      jurisdiction: detectedStateCode ? {
        state_code: detectedStateCode,
        detection_source: (claimData as any)?.state_code ? 'database' : 'address_parse',
      } : { state_code: null, detection_source: 'undetected' },
    };

    // Attach watchdog warnings if found
    if (citationViolations.length > 0) {
      responseData.citation_watchdog = {
        wrong_state_citations_found: citationViolations.length,
        violations: citationViolations,
        warning: `⚠️ Darwin detected ${citationViolations.length} citation(s) from the WRONG state in this report. Review before sending.`,
      };
    }

    return new Response(
      JSON.stringify(responseData),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Error in analyze-photos:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
