/**
 * Business-hours gate for cron-triggered edge functions.
 * Returns true if the current time is within the operating window (6 AM – 10 PM US Eastern).
 * All cron-triggered functions should call this at the top and return early if outside window.
 */
export function isWithinBusinessHours(): boolean {
  const now = new Date();
  // Convert to US Eastern time
  const eastern = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hour = eastern.getHours();
  // 6 AM (inclusive) to 10 PM (exclusive)
  return hour >= 6 && hour < 22;
}

/**
 * Standard early-return response for functions called outside business hours.
 */
export function outsideBusinessHoursResponse(corsHeaders: Record<string, string>): Response {
  return new Response(
    JSON.stringify({ skipped: true, reason: "Outside business hours (6 AM – 10 PM ET)" }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}
