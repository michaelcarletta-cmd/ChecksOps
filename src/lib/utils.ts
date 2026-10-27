import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formats a phone number with hyphens (e.g., 123-456-7890)
 * Handles partial input for real-time formatting
 */
export function formatPhoneNumber(value: string): string {
  // Remove all non-numeric characters
  const numbers = value.replace(/\D/g, "");
  
  // Format based on length
  if (numbers.length <= 3) {
    return numbers;
  } else if (numbers.length <= 6) {
    return `${numbers.slice(0, 3)}-${numbers.slice(3)}`;
  } else {
    return `${numbers.slice(0, 3)}-${numbers.slice(3, 6)}-${numbers.slice(6, 10)}`;
  }
}

/**
 * Shows a stored phone number as XXX-XXX-XXXX. Values saved before the input
 * was formatted ("(555) 123-4567", "+1 555 123 4567", "5551234567") read the
 * same way; anything that is not a 10-digit US number is shown as stored.
 */
export function formatPhoneForDisplay(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length !== 10) return raw;
  return formatPhoneNumber(digits);
}

/**
 * Parses a date string (YYYY-MM-DD) as local time instead of UTC
 * This prevents the off-by-one-day issue when displaying dates
 */
export function parseLocalDate(dateString: string): Date {
  // Append T00:00:00 to treat the date as local time instead of UTC
  return new Date(dateString + 'T00:00:00');
}
