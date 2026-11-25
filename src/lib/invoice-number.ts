// A sale made on the device gets a local number (INV-<year>-<n>) at once; the server assigns the official one
// (YYYYMMDD-NNNNN) when the sale syncs. Until then the number on screen is provisional.
const LOCAL_NUMBER = /^#?INV-\d{4}-\d+$/;

const PROVISIONAL_LABEL: Record<string, string> = {
  ar: 'رقم مؤقت',
  en: 'provisional no.',
  tr: 'geçici no',
  fa: 'شماره موقت',
  ku: 'ژمارەی کاتی',
};

export const isLocalInvoiceNumber = (value?: string | null): boolean => LOCAL_NUMBER.test(String(value ?? '').trim());

/** "#INV-2026-001" -> "#INV-2026-001 · رقم مؤقت"; any other number is returned unchanged. */
export function markIfProvisional(value: string, language: string = 'ar'): string {
  if (!isLocalInvoiceNumber(value)) return value;
  return `${value} · ${PROVISIONAL_LABEL[language] || PROVISIONAL_LABEL.ar}`;
}
