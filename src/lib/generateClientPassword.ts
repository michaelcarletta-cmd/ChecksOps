/**
 * Generates a readable client password from their name.
 * Format: LastName + CurrentYear + "!"
 * Example: "Patrick & Jennifer Hurley" → "Hurley2026!"
 */
export function generateClientPassword(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  const lastName = parts[parts.length - 1] || "Client";
  // Capitalize first letter, lowercase rest
  const formatted = lastName.charAt(0).toUpperCase() + lastName.slice(1).toLowerCase();
  const year = new Date().getFullYear();
  return `${formatted}${year}!`;
}
