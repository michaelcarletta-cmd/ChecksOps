import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import { buildEstimateItems } from "@/lib/rulesEngine";
import { DamageObservation } from "@/types";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

function extractJson(text: string): string {
  const trimmed = text.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  throw new Error("No valid JSON object found in model response");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const imageBase64 = body?.imageBase64 as string | undefined;
    const mimeType = body?.mimeType as string | undefined;

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is missing" },
        { status: 500 }
      );
    }

    if (!imageBase64 || !mimeType) {
      return NextResponse.json(
        { error: "imageBase64 and mimeType are required" },
        { status: 400 }
      );
    }

    const prompt = `
You are an insurance field estimating assistant.
Analyze the uploaded property damage image and return ONLY valid JSON.

Return this exact schema:
{
  "summary": "short summary",
  "observations": [
    {
      "category": "roof|siding|interior|window|gutter|fence|other",
      "component": "string",
      "material": "string",
      "damageType": "string",
      "severity": "low|medium|high",
      "repairability": "repair|replace|undetermined",
      "quantityBasis": "string",
      "recommendedQuantity": 1,
      "unit": "EA|SF|LF|SQ",
      "confidence": 0.0,
      "rationale": "string"
    }
  ]
}

Rules:
- Be conservative and evidence-based.
- If quantity cannot be measured from image, use a reasonable visible estimate and explain quantityBasis.
- confidence must be a number from 0 to 1.
- Return no markdown fences.
- Return an empty observations array if the image does not clearly show property damage.
`;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: prompt
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analyze this property damage photo for estimate-building."
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`
              }
            }
          ]
        }
      ]
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    const jsonText = extractJson(raw);

    const parsed = JSON.parse(jsonText) as {
      summary?: string;
      observations?: DamageObservation[];
    };

    const observations = Array.isArray(parsed.observations)
      ? parsed.observations
      : [];

    const estimateItems = buildEstimateItems(observations);

    return NextResponse.json({
      summary: parsed.summary ?? "",
      observations,
      estimateItems
    });
  } catch (error) {
    console.error("Analyze route error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to analyze image"
      },
      { status: 500 }
    );
  }
}
