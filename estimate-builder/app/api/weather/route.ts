import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const dateOfLoss = body?.dateOfLoss;
    const address = body?.address;

    return NextResponse.json({
      verified: true,
      address: address ?? "",
      dateOfLoss: dateOfLoss ?? "",
      peril: "wind/hail review placeholder",
      findings: [
        "Weather verification module placeholder",
        "Connect NOAA/storm vendor data here",
        "Store result with claim file after verification"
      ]
    });
  } catch (error) {
    console.error("Weather route error:", error);
    return NextResponse.json(
      { error: "Failed to verify weather" },
      { status: 500 }
    );
  }
}
