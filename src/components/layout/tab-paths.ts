/**
 * استخراج المسار الأساسي للتبويبات الرئيسية
 */
export function getBaseTabPath(pathname: string): string | null {
  if (pathname === '/products' || pathname.startsWith('/products/')) return '/products';
  if (pathname === '/invoices' || pathname.startsWith('/invoices/')) return '/invoices';
  if (pathname === '/customers' || pathname.startsWith('/customers/')) return '/customers';
  if (pathname === '/services' || pathname.startsWith('/services/')) return '/services';
  if (pathname === '/expenses' || pathname.startsWith('/expenses/')) return '/expenses';
  if (pathname === '/purchases' || pathname.startsWith('/purchases/')) return '/purchases';
  if (pathname === '/reports' || pathname.startsWith('/reports/')) return '/reports';
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return '/settings';
  if (pathname === '/appearance' || pathname.startsWith('/appearance/')) return '/appearance';
  return null;
}
