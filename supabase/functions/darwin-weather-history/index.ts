
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface WeatherRequest {
  claimId: string;
  lossDate: string;
  address: string;
  lossType?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { generate } = await import("../_shared/ai/generate.ts");

    const { claimId, lossDate, address, lossType }: WeatherRequest = await req.json();
    console.log(`Weather History - Claim: ${claimId}, Date: ${lossDate}, Address: ${address}`);

    if (!lossDate || !address) {
      return new Response(
        JSON.stringify({ error: 'Loss date and address are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract city/state from address for more accurate weather lookup
    const addressParts = address.split(',').map((p: string) => p.trim());
    const city = addressParts[addressParts.length - 3] || addressParts[0];
    const state = addressParts[addressParts.length - 2]?.split(' ')[0] || 'NJ';
    const locationQuery = `${city}, ${state}`;

    // Format the date
    const dateObj = new Date(lossDate);
    const formattedDate = dateObj.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });

    // Build a comprehensive weather query based on loss type
    let weatherFocus = 'temperature, precipitation, wind speed and gusts';
    if (lossType) {
      const lossTypeLower = lossType.toLowerCase();
      if (lossTypeLower.includes('hail')) {
        weatherFocus = 'hail storms, hail size, storm severity, wind gusts';
      } else if (lossTypeLower.includes('wind')) {
        weatherFocus = 'wind speed, wind gusts, storm damage, severe weather warnings';
      } else if (lossTypeLower.includes('water') || lossTypeLower.includes('flood')) {
        weatherFocus = 'rainfall amounts, flooding, flash flood warnings, precipitation totals';
      } else if (lossTypeLower.includes('fire')) {
        weatherFocus = 'temperature, humidity, wind conditions, fire weather warnings';
      } else if (lossTypeLower.includes('snow') || lossTypeLower.includes('ice')) {
        weatherFocus = 'snowfall totals, ice accumulation, winter storm warnings, freezing rain';
      }
    }

    const searchQuery = `Historical weather ${locationQuery} on ${formattedDate}: ${weatherFocus}, severe weather alerts, storm reports. Include specific measurements and any NWS reports.`;

    const systemContent = `You are a weather research assistant for insurance claims. Your task is to provide accurate historical weather data for a specific date and location.

ALWAYS respond in valid JSON format with this exact structure:
{
  "date": "YYYY-MM-DD",
  "location": "City, State",
  "summary": "A 2-3 sentence summary of the weather conditions that day",
  "conditions": {
    "temperature_high": number or null,
    "temperature_low": number or null,
    "precipitation": "description of any precipitation",
    "wind_speed": number (mph) or null,
    "wind_gusts": number (mph) or null,
    "hail_reported": boolean,
    "tornado_warning": boolean,
    "severe_storm_warning": boolean
  },
  "sources": ["list of sources like NWS, Weather Underground, etc"],
  "relevantEvents": ["list of specific weather events that occurred"]
}

Be accurate and cite real historical weather data. If you cannot find exact data, provide reasonable estimates based on regional weather patterns and note this in the summary. Focus on weather conditions relevant to insurance claims.`;

    const userContent = `Find historical weather data for:
Location: ${locationQuery}
Date: ${formattedDate}
Loss Type (focus area): ${lossType || 'General property damage'}

Search for: ${searchQuery}

Provide the weather conditions in the specified JSON format.`;

    const aiResult = await generate({
      task: 'extraction',
      system: systemContent,
      user: userContent,
      searchMode: 'off',
      jsonMode: true,
    });

    console.log(`[darwin-weather-history] model=${aiResult.model}, cached=${aiResult.cached}`);

    const content = aiResult.text;

    if (!content) {
      throw new Error('No content in AI response');
    }

    console.log('AI Response:', content);

    // Parse the JSON response
    let weatherData;
    try {
      // Extract JSON from the response (handle markdown code blocks)
      let jsonStr = content;
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      weatherData = JSON.parse(jsonStr.trim());
    } catch (parseError) {
      console.error('Failed to parse weather JSON:', parseError);
      // Return a structured response even if parsing fails
      weatherData = {
        date: lossDate,
        location: locationQuery,
        summary: content,
        conditions: {},
        sources: ['AI Analysis'],
        relevantEvents: [],
      };
    }

    return new Response(
      JSON.stringify({ weatherData }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Weather history error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Weather lookup failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
