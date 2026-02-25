
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
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

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

    console.log(`Weather search query: ${searchQuery}`);

    // Use Lovable AI to search for and synthesize weather data
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-3-flash-preview',
        messages: [
          {
            role: 'system',
            content: `You are a weather research assistant for insurance claims. Your task is to provide accurate historical weather data for a specific date and location.

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

Be accurate and cite real historical weather data. If you cannot find exact data, provide reasonable estimates based on regional weather patterns and note this in the summary. Focus on weather conditions relevant to insurance claims.`
          },
          {
            role: 'user',
            content: `Find historical weather data for:
Location: ${locationQuery}
Date: ${formattedDate}
Loss Type (focus area): ${lossType || 'General property damage'}

Search for: ${searchQuery}

Provide the weather conditions in the specified JSON format.`
          }
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI Gateway error:', response.status, errorText);
      
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: 'API credits exhausted. Please add funds.' }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      
      throw new Error(`AI Gateway error: ${response.status}`);
    }

    const aiResponse = await response.json();
    const content = aiResponse.choices?.[0]?.message?.content;

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
