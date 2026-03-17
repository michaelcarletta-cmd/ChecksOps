export const PRICE_BOOK: Record<string, number> = {
  RFG240: 525,
  RFG220: 85,
  RFG300: 8.5,
  RFGST: 4.5,
  RFGFELTSYN: 45,
  RFGICE: 1.85,
  RFGDRIP: 4.25,
  RFGVENT: 16,
  SIDVINYL: 74,
  SIDVINYLREP: 38,
  SIDFIBER: 96,
  SIDDROP: 1.65,
  DRYWALL: 3.8,
  PAINT: 1.95,
  INSUL: 1.45,
  WINREPL: 850,
  GUT5K: 18,
  DWN23: 16,
  FNCREP: 42
};

export function getUnitPrice(code: string): number {
  return PRICE_BOOK[code] ?? 0;
}
