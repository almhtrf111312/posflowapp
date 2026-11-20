/**
 * Native Print Utility for Capacitor/Android & Web & Thermal Bluetooth/USB
 * =========================================================================
 * يوفر طباعة حقيقية تعمل على:
 * 1. طابعات حرارية مقترنة (Bluetooth ESC/POS على Android أو Web Serial/USB على الكمبيوتر)
 * 2. الأندرويد/Capacitor عبر Android PrintManager أو WebView Print
 * 3. المتصفح عبر window.print() أو نافذة طباعة نظيفة
 * 4. fallback لمشاركة الفاتورة في حالة عدم توفر طابعة
 */

import { Capacitor } from '@capacitor/core';
import { formatCurrency, formatNumber } from './utils';
import { resolveInvoiceCurrencySymbol } from './currencies';
import { getDefaultPrinter, ThermalPrinterDevice } from './thermal-printer';
import { buildReceiptESCPOS, printToThermalPrinter, ReceiptPrintData } from './escpos-builder';
import { showToast } from './toast-config';
import { isGuestDemoMode } from './demo-data';

export interface PrintReceiptData {
  invoiceNumber: string;
  date: string;
  time: string;
  storeName: string;
  storePhone?: string;
  storeAddress?: string;
  storeEmail?: string;
  storeLogo?: string;
  customerName?: string;
  customerPhone?: string;
  items: Array<{
    name: string;
    quantity: number;
    unitPrice: number;
    total: number;
    unit?: string;
    expiryDate?: string;
    batchNumber?: string;
  }>;
  subtotal: number;
  discount?: number;
  taxAmount?: number;
  taxRate?: number;
  total: number;
  currencySymbol: string;
  currencyCode?: string;
  currencyName?: string;
  paymentType: 'cash' | 'debt' | 'split' | string;
  downPayment?: number;
  debtRemaining?: number;
  cashierName?: string;
  notes?: string;
  footer?: string;
  welcomeMessage?: string;
  paperSize?: '58mm' | '80mm' | 'A4';
  showStoreName?: boolean;
  showLogo?: boolean;
  showAddress?: boolean;
  showPhone?: boolean;
  showEmail?: boolean;
  showInvoiceNumber?: boolean;
  showDateTime?: boolean;
  showCashierName?: boolean;
  showCustomerInfo?: boolean;
  showAlternativeCurrencies?: boolean;
  alternativeTotals?: Array<{ symbol: string; amount: number; code?: string }>;
  copies?: number;
  /** عند تمريرها يتم توجيه الطباعة لطابعة حرارية محددة */
  printerDevice?: ThermalPrinterDevice | null;
  /** عند true نتجاوز الطابعة الحرارية ونستخدم طباعة النظام العادية */
  forceSystemPrint?: boolean;
}

/**
 * قراءة إعدادات الطباعة المحفوظة
 */
export function getSavedPrintSettings() {
  try {
    const raw = localStorage.getItem('posflow_settings_v1');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.printSettings) {
        return parsed.printSettings;
      }
    }
  } catch {
    // ignore
  }
  return {
    autoPrint: false,
    showStoreName: true,
    showLogo: true,
    showAddress: true,
    showPhone: true,
    showEmail: false,
    showInvoiceNumber: true,
    showDateTime: true,
    showCashierName: true,
    showAlternativeCurrencies: true,
    paperSize: '80mm',
    copies: '1',
    welcomeMessage: '',
    footer: 'شكراً لزيارتكم!',
  };
}

/**
 * التحقق مما إذا كان هناك طابعة حرارية افتراضية مهيّأة
 */
export function hasDefaultThermalPrinter(): boolean {
  const printer = getDefaultPrinter();
  return !!(printer && (printer.type === 'bluetooth' || printer.type === 'usb' || printer.type === 'network'));
}

/**
 * التحقق من دعم الطباعة في البيئة الحالية
 */
export function isPrintSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (hasDefaultThermalPrinter()) return true;
  if (Capacitor.isNativePlatform()) {
    return typeof (window as any).AndroidPrinter?.print === 'function' || typeof window.print === 'function';
  }
  return typeof window.print === 'function';
}

/**
 * تحويل بيانات الإيصال إلى صيغة ESC/POS وإرسالها للطابعة الحرارية المقترنة
 */
export async function printReceiptThermal(
  data: PrintReceiptData,
  device?: ThermalPrinterDevice
): Promise<{ success: boolean; error?: string }> {
  const targetPrinter = device || data.printerDevice || getDefaultPrinter();
  if (!targetPrinter) {
    return { success: false, error: 'لا توجد طابعة حرارية افتراضية مقترنة' };
  }

  const saved = getSavedPrintSettings();
  const paperWidth = (data.paperSize === '58mm' || targetPrinter.paperWidth === '58mm') ? '58mm' : '80mm';
  const currencySymbol = resolveInvoiceCurrencySymbol(data.currencyCode, data.currencySymbol);
  const copies = Math.max(1, Number(data.copies || saved.copies || 1));

  const escData: ReceiptPrintData = {
    storeName: (data.showStoreName ?? saved.showStoreName ?? true) ? data.storeName : '',
    storeAddress: (data.showAddress ?? saved.showAddress ?? true) ? data.storeAddress : undefined,
    storePhone: (data.showPhone ?? saved.showPhone ?? true) ? data.storePhone : undefined,
    welcomeMessage: data.welcomeMessage ?? saved.welcomeMessage,
    invoiceNumber: data.invoiceNumber,
    date: data.date,
    time: data.time,
    cashierName: (data.showCashierName ?? saved.showCashierName ?? true) ? data.cashierName : undefined,
    customerName: data.customerName,
    customerPhone: data.customerPhone,
    paymentType: data.paymentType,
    items: data.items.map(it => ({
      name: it.name,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      total: it.total,
      unit: it.unit,
    })),
    subtotal: data.subtotal,
    discount: data.discount,
    taxAmount: data.taxAmount,
    taxRate: data.taxRate,
    total: data.total,
    currencySymbol,
    currencyCode: data.currencyCode,
    currencyName: data.currencyName,
    downPayment: data.downPayment,
    debtRemaining: data.debtRemaining,
    alternativeTotals: (data.showAlternativeCurrencies ?? saved.showAlternativeCurrencies ?? true)
      ? data.alternativeTotals
      : undefined,
    notes: data.notes,
    footer: data.footer ?? saved.footer ?? 'شكراً لزيارتكم!',
    paperWidth,
  };

  try {
    const bytes = buildReceiptESCPOS(escData);
    for (let copy = 0; copy < copies; copy++) {
      const res = await printToThermalPrinter(targetPrinter, bytes);
      if (!res.success) {
        return res;
      }
      if (copy < copies - 1) {
        await new Promise(r => setTimeout(r, 400));
      }
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || 'فشل الطباعة الحرارية' };
  }
}

/**
 * توليد HTML نظيف واحترافي للفاتورة جاهز للطباعة على ورق حراري (58mm / 80mm) أو A4
 */
export function generateReceiptHTML(data: PrintReceiptData): string {
  const saved = getSavedPrintSettings();
  const paperSize = data.paperSize || saved.paperSize || '80mm';
  const is58 = paperSize === '58mm';
  const isA4 = paperSize === 'A4';
  const widthCss = isA4 ? '210mm' : is58 ? '54mm' : '74mm';
  const fontSize = is58 ? '11px' : isA4 ? '14px' : '12.5px';
  const currencySymbol = resolveInvoiceCurrencySymbol(data.currencyCode, data.currencySymbol);
  const fmt = (val: number) => formatCurrency(val, currencySymbol, undefined, data.currencyCode, data.currencyName);

  const showStoreName = data.showStoreName ?? saved.showStoreName ?? true;
  const showLogo = data.showLogo ?? saved.showLogo ?? true;
  const showAddress = data.showAddress ?? saved.showAddress ?? true;
  const showPhone = data.showPhone ?? saved.showPhone ?? true;
  const showEmail = data.showEmail ?? saved.showEmail ?? false;
  const showInvoiceNumber = data.showInvoiceNumber ?? saved.showInvoiceNumber ?? true;
  const showDateTime = data.showDateTime ?? saved.showDateTime ?? true;
  const showCashierName = data.showCashierName ?? saved.showCashierName ?? true;
  const showAlt = data.showAlternativeCurrencies ?? saved.showAlternativeCurrencies ?? true;
  const welcomeMessage = data.welcomeMessage ?? saved.welcomeMessage ?? '';
  const footerText = data.footer ?? saved.footer ?? 'شكراً لزيارتكم!';

  const paymentLabel = data.paymentType === 'cash'
    ? 'نقدي'
    : (data.paymentType === 'split' || (data.downPayment && data.downPayment > 0))
      ? 'بيع مركب (نقدي + آجل)'
      : 'آجل (دين)';

  const itemsRows = data.items.map((item, idx) => `
    <tr>
      <td style="text-align: right; padding: 5px 2px; border-bottom: 1px dashed #ccc; word-break: break-word;">
        <div style="font-weight: 600;">${idx + 1}. ${escapeHtml(item.name)}</div>
        ${item.unit ? `<div style="font-size: 0.82em; color: #666;">${escapeHtml(item.unit)}</div>` : ''}
        ${item.expiryDate || item.batchNumber ? `<div style="font-size: 0.78em; color: #666;">${item.batchNumber ? `دفعة: ${escapeHtml(item.batchNumber)} ` : ''}${item.expiryDate ? `صلاحية: ${escapeHtml(item.expiryDate)}` : ''}</div>` : ''}
      </td>
      <td style="text-align: center; padding: 5px 2px; border-bottom: 1px dashed #ccc; white-space: nowrap;">
        ${formatNumber(item.quantity)}
      </td>
      <td style="text-align: center; padding: 5px 2px; border-bottom: 1px dashed #ccc; white-space: nowrap;">
        ${fmt(item.unitPrice)}
      </td>
      <td style="text-align: left; padding: 5px 2px; border-bottom: 1px dashed #ccc; font-weight: 700; white-space: nowrap;">
        ${fmt(item.total)}
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>فاتورة #${escapeHtml(data.invoiceNumber)}</title>
  <style>
    @page {
      size: ${isA4 ? 'A4' : `${paperSize} auto`};
      margin: ${isA4 ? '12mm' : '2mm'};
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: 'Cairo', 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif;
      direction: rtl;
      background: #ffffff;
      color: #000000;
      font-size: ${fontSize};
      line-height: 1.45;
      width: ${widthCss};
      margin: 0 auto;
      padding: ${isA4 ? '10px' : '4px'};
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .header {
      text-align: center;
      padding-bottom: 8px;
      border-bottom: 2px solid #000;
      margin-bottom: 8px;
    }
    .logo {
      max-height: ${is58 ? '40px' : '56px'};
      max-width: 120px;
      object-fit: contain;
      margin-bottom: 4px;
    }
    .store-name {
      font-size: ${is58 ? '15px' : isA4 ? '22px' : '17px'};
      font-weight: 800;
      margin-bottom: 2px;
    }
    .store-meta {
      font-size: 0.85em;
      color: #333;
    }
    .welcome {
      margin-top: 4px;
      font-size: 0.85em;
      font-style: italic;
      color: #444;
    }
    .meta-grid {
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px dashed #666;
      font-size: 0.9em;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 2px;
    }
    .meta-label {
      color: #444;
    }
    .meta-val {
      font-weight: 700;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 8px;
    }
    thead th {
      background: #f0f0f0;
      border-top: 1px solid #000;
      border-bottom: 1px solid #000;
      padding: 5px 2px;
      font-size: 0.85em;
      font-weight: 700;
    }
    .totals {
      border-top: 2px solid #000;
      padding-top: 6px;
      margin-top: 4px;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 3px;
      font-size: 0.95em;
    }
    .grand-total {
      display: flex;
      justify-content: space-between;
      font-size: ${is58 ? '14px' : isA4 ? '18px' : '15.5px'};
      font-weight: 800;
      border-top: 1px solid #000;
      border-bottom: 2px double #000;
      padding: 6px 0;
      margin: 5px 0;
    }
    .alt-currencies {
      background: #f7f7f7;
      padding: 4px 6px;
      border-radius: 4px;
      margin-top: 4px;
      font-size: 0.85em;
    }
    .notes-box {
      margin-top: 6px;
      padding: 5px;
      border: 1px dashed #666;
      font-size: 0.85em;
    }
    .footer {
      text-align: center;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px dashed #000;
      font-size: 0.88em;
    }
    @media print {
      body { width: 100%; }
      .no-print { display: none !important; }
    }
    ${isGuestDemoMode() ? `
      .receipt { position: relative; overflow: hidden; }
      .receipt::before {
        content: "نسخة تجريبية - POS Flow App";
        position: absolute;
        top: 35%;
        left: -10%;
        width: 120%;
        text-align: center;
        font-size: ${is58 ? '18px' : '26px'};
        font-weight: 900;
        color: rgba(225, 29, 72, 0.14);
        transform: rotate(-30deg);
        pointer-events: none;
        z-index: 999;
        white-space: nowrap;
      }
    ` : ''}
  </style>
</head>
<body>
  <div class="receipt">
    <div class="header">
      ${showLogo && data.storeLogo ? `<img src="${escapeHtml(data.storeLogo)}" class="logo" alt="logo" />` : ''}
      ${showStoreName ? `<div class="store-name">${escapeHtml(data.storeName)}</div>` : ''}
      ${showAddress && data.storeAddress ? `<div class="store-meta">${escapeHtml(data.storeAddress)}</div>` : ''}
      ${showPhone && data.storePhone ? `<div class="store-meta" dir="ltr">${escapeHtml(data.storePhone)}</div>` : ''}
      ${showEmail && data.storeEmail ? `<div class="store-meta" dir="ltr">${escapeHtml(data.storeEmail)}</div>` : ''}
      ${welcomeMessage ? `<div class="welcome">${escapeHtml(welcomeMessage)}</div>` : ''}
    </div>

    <div class="meta-grid">
      ${showInvoiceNumber ? `
      <div class="meta-row">
        <span class="meta-label">رقم الفاتورة:</span>
        <span class="meta-val" dir="ltr">#${escapeHtml(data.invoiceNumber)}</span>
      </div>` : ''}
      ${showDateTime ? `
      <div class="meta-row">
        <span class="meta-label">التاريخ والوقت:</span>
        <span class="meta-val" dir="ltr">${escapeHtml(data.date)} ${escapeHtml(data.time)}</span>
      </div>` : ''}
      ${data.customerName ? `
      <div class="meta-row">
        <span class="meta-label">العميل:</span>
        <span class="meta-val">${escapeHtml(data.customerName)}</span>
      </div>` : ''}
      ${data.customerPhone ? `
      <div class="meta-row">
        <span class="meta-label">هاتف العميل:</span>
        <span class="meta-val" dir="ltr">${escapeHtml(data.customerPhone)}</span>
      </div>` : ''}
      ${showCashierName && data.cashierName ? `
      <div class="meta-row">
        <span class="meta-label">الكاشير:</span>
        <span class="meta-val">${escapeHtml(data.cashierName)}</span>
      </div>` : ''}
      <div class="meta-row">
        <span class="meta-label">طريقة الدفع:</span>
        <span class="meta-val">${paymentLabel}</span>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th style="text-align: right;">الصنف</th>
          <th style="text-align: center;">الكمية</th>
          <th style="text-align: center;">السعر</th>
          <th style="text-align: left;">الإجمالي</th>
        </tr>
      </thead>
      <tbody>
        ${itemsRows}
      </tbody>
    </table>

    <div class="totals">
      <div class="total-row">
        <span>المجموع الفرعي:</span>
        <span>${fmt(data.subtotal)}</span>
      </div>
      ${data.discount && data.discount > 0 ? `
      <div class="total-row">
        <span>الخصم:</span>
        <span>-${fmt(data.discount)}</span>
      </div>` : ''}
      ${data.taxAmount && data.taxAmount > 0 ? `
      <div class="total-row">
        <span>الضريبة${data.taxRate ? ` (${data.taxRate}%)` : ''}:</span>
        <span>${fmt(data.taxAmount)}</span>
      </div>` : ''}

      <div class="grand-total">
        <span>الإجمالي النهائي:</span>
        <span>${fmt(data.total)}</span>
      </div>

      ${(data.paymentType === 'split' || data.paymentType === 'debt' || (data.downPayment && data.downPayment > 0)) ? `
        ${data.downPayment && data.downPayment > 0 ? `
        <div class="total-row">
          <span>المدفوع نقداً:</span>
          <span>${fmt(data.downPayment)}</span>
        </div>` : ''}
        <div class="total-row" style="font-weight: 700;">
          <span>المتبقي كدين:</span>
          <span>${fmt(data.debtRemaining !== undefined ? data.debtRemaining : (data.total - (data.downPayment || 0)))}</span>
        </div>
      ` : ''}

      ${showAlt && data.alternativeTotals && data.alternativeTotals.length > 0 ? `
      <div class="alt-currencies">
        ${data.alternativeTotals.map(alt => `
          <div class="total-row" style="margin-bottom: 1px;">
            <span>المعادل (${escapeHtml(alt.code || alt.symbol)}):</span>
            <span>${formatCurrency(alt.amount, resolveInvoiceCurrencySymbol(alt.code, alt.symbol), undefined, alt.code)}</span>
          </div>
        `).join('')}
      </div>` : ''}
    </div>

    ${data.notes ? `<div class="notes-box"><strong>ملاحظات:</strong> ${escapeHtml(data.notes)}</div>` : ''}

    <div class="footer">
      <div>${escapeHtml(footerText)}</div>
      <small style="color: #999;">PosFlow</small>
      ${isGuestDemoMode() ? `
        <div style="margin-top: 10px; padding: 6px; border: 2px dashed #e11d48; color: #e11d48; font-weight: bold; font-size: 13px; text-align: center; border-radius: 4px; background: #fff1f2;">
          ⚠️ نسخة تجريبية - POS Flow App ⚠️
          <div style="font-size: 10px; font-weight: normal; color: #be123c; margin-top: 2px;">غير معتمدة كفاتورة رسمية أو محاسبية</div>
        </div>
      ` : ''}
    </div>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * طباعة HTML مباشر عبر iframe مخفي أو Android PrintManager
 */
export async function printHtmlDocument(html: string, jobName: string = 'PosFlow_Receipt'): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  // 1. على أندرويد (Capacitor): إذا توفّر AndroidPrinter.printHtml أو AndroidPrinter.print
  if (Capacitor.isNativePlatform()) {
    const androidPrinter = (window as any).AndroidPrinter;
    if (androidPrinter && typeof androidPrinter.printHtml === 'function') {
      try {
        androidPrinter.printHtml(html, jobName);
        return true;
      } catch (err) {
        console.warn('[NativePrint] AndroidPrinter.printHtml failed:', err);
      }
    }

    // استخدام iframe ثم AndroidPrinter.print() أو window.print()
    return await printViaHiddenIframe(html, () => {
      if (androidPrinter && typeof androidPrinter.print === 'function') {
        androidPrinter.print();
      } else {
        window.print();
      }
    });
  }

  // 2. على المتصفح / Electron: طباعة عبر iframe معزول (بدون popups محجوبة)
  return await printViaHiddenIframe(html);
}

/**
 * طباعة معزولة عبر iframe مخفي (لا يفتح نافذة منبثقة ولا يعيد تحميل التطبيق)
 */
function printViaHiddenIframe(html: string, customPrintTrigger?: (win: Window) => void): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const existing = document.getElementById('posflow-print-iframe');
      if (existing) existing.remove();

      const iframe = document.createElement('iframe');
      iframe.id = 'posflow-print-iframe';
      iframe.style.position = 'fixed';
      iframe.style.right = '0';
      iframe.style.bottom = '0';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = '0';
      iframe.style.opacity = '0';
      iframe.style.pointerEvents = 'none';

      document.body.appendChild(iframe);

      const frameWin = iframe.contentWindow;
      const frameDoc = iframe.contentDocument || frameWin?.document;

      if (!frameWin || !frameDoc) {
        iframe.remove();
        resolve(false);
        return;
      }

      frameDoc.open();
      frameDoc.write(html);
      frameDoc.close();

      // انتظار تحميل الصور والخطوط داخل الإطار
      const triggerPrint = () => {
        try {
          frameWin.focus();
          if (customPrintTrigger) {
            customPrintTrigger(frameWin);
          } else {
            frameWin.print();
          }
          setTimeout(() => {
            try { iframe.remove(); } catch { /* ignore */ }
          }, 3000);
          resolve(true);
        } catch (err) {
          console.error('[NativePrint] Print trigger error:', err);
          try { iframe.remove(); } catch { /* ignore */ }
          resolve(false);
        }
      };

      setTimeout(triggerPrint, 350);
    } catch (err) {
      console.error('[NativePrint] Hidden iframe print failed:', err);
      resolve(false);
    }
  });
}

/**
 * طباعة إيصال الفاتورة:
 * - أولاً: يحاول الطباعة المباشرة على الطابعة الحرارية الافتراضية المقترنة (Bluetooth/USB) إن وجدت
 * - ثانياً: إذا لم توجد طابعة حرارية أو تم اختيار طباعة النظام، يطبع عبر printHtmlDocument (Android PrintManager / Browser Print)
 */
export async function printReceipt(data: PrintReceiptData): Promise<boolean> {
  // 1. إذا كان هناك طابعة حرارية افتراضية (ولم يُطلب تجاوزها)
  if (!data.forceSystemPrint) {
    const defaultThermal = data.printerDevice || getDefaultPrinter();
    if (defaultThermal && (defaultThermal.type === 'bluetooth' || defaultThermal.type === 'usb' || defaultThermal.type === 'network')) {
      const res = await printReceiptThermal(data, defaultThermal);
      if (res.success) {
        return true;
      }
      console.warn('[NativePrint] Thermal print failed, falling back to system print:', res.error);
      showToast.warning(`تعذرت الطباعة الحرارية (${res.error || 'خطأ اتصال'})، جاري التحويل لطباعة النظام...`);
    }
  }

  // 2. طباعة النظام (HTML -> PrintManager / Browser Print)
  const html = generateReceiptHTML(data);
  const copies = Math.max(1, Number(data.copies || getSavedPrintSettings().copies || 1));
  let ok = false;
  for (let i = 0; i < copies; i++) {
    ok = await printHtmlDocument(html, `Invoice_${data.invoiceNumber}`);
    if (i < copies - 1) {
      await new Promise(r => setTimeout(r, 600));
    }
  }
  return ok;
}

/**
 * طباعة عنصر HTML موجود في الصفحة (للمكونات القديمة)
 */
export async function printElement(element: HTMLElement | null, title: string = 'طباعة'): Promise<boolean> {
  if (!element) {
    window.print();
    return true;
  }

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body {
      font-family: 'Cairo', 'Tajawal', 'Segoe UI', Tahoma, Arial, sans-serif;
      direction: rtl;
      background: #fff;
      color: #000;
      padding: 12px;
    }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 6px; text-align: right; }
    @media print { .no-print { display: none !important; } }
  </style>
</head>
<body>
  ${element.innerHTML}
</body>
</html>`;

  return printHtmlDocument(html, title);
}

/**
 * طباعة صفحة الفاتورة / ملصق باركود بسيط
 */
export async function printBarcodeLabelsHTML(labelsHtml: string, title: string = 'ملصقات باركود'): Promise<boolean> {
  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    @page { margin: 4mm; }
    body {
      font-family: 'Cairo', 'Segoe UI', Arial, sans-serif;
      direction: rtl;
      margin: 0;
      padding: 0;
      background: #fff;
      color: #000;
    }
    .labels-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-start;
    }
    .label-card {
      border: 1px dashed #ccc;
      padding: 6px;
      text-align: center;
      page-break-inside: avoid;
      break-inside: avoid;
    }
  </style>
</head>
<body>
  <div class="labels-grid">
    ${labelsHtml}
  </div>
</body>
</html>`;

  return printHtmlDocument(html, title);
}

/**
 * توليد HTML فاتورة صيانة جاهز للطباعة
 */
export function generateMaintenanceReceiptHTML(data: {
  orderNumber: string;
  date: string;
  storeName: string;
  storePhone?: string;
  storeAddress?: string;
  customerName: string;
  customerPhone?: string;
  deviceType?: string;
  deviceModel?: string;
  problemDescription: string;
  estimatedCost?: number;
  paidAmount?: number;
  currencySymbol: string;
  currencyCode?: string;
  notes?: string;
  paperSize?: '58mm' | '80mm' | 'A4';
}): string {
  const saved = getSavedPrintSettings();
  const paperSize = data.paperSize || saved.paperSize || '80mm';
  const is58 = paperSize === '58mm';
  const widthCss = paperSize === 'A4' ? '210mm' : is58 ? '54mm' : '74mm';
  const currencySymbol = resolveInvoiceCurrencySymbol(data.currencyCode, data.currencySymbol);
  const fmt = (val: number) => formatCurrency(val, currencySymbol, undefined, data.currencyCode);

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8" />
  <title>إيصال صيانة #${escapeHtml(data.orderNumber)}</title>
  <style>
    @page { size: ${paperSize === 'A4' ? 'A4' : `${paperSize} auto`}; margin: 3mm; }
    body {
      font-family: 'Cairo', 'Tajawal', Arial, sans-serif;
      direction: rtl;
      width: ${widthCss};
      margin: 0 auto;
      font-size: ${is58 ? '11px' : '12.5px'};
      line-height: 1.5;
      color: #000;
      background: #fff;
    }
    .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 6px; margin-bottom: 8px; }
    .title { font-size: 16px; font-weight: 800; }
    .badge { display: inline-block; border: 1px solid #000; padding: 2px 8px; margin-top: 4px; font-weight: 700; }
    .row { display: flex; justify-content: space-between; margin-bottom: 4px; border-bottom: 1px dashed #ddd; padding-bottom: 2px; }
    .box { border: 1px solid #000; padding: 6px; margin: 8px 0; }
    .footer { text-align: center; border-top: 1px dashed #000; margin-top: 10px; padding-top: 6px; font-size: 0.85em; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">${escapeHtml(data.storeName)}</div>
    ${data.storeAddress ? `<div>${escapeHtml(data.storeAddress)}</div>` : ''}
    ${data.storePhone ? `<div dir="ltr">${escapeHtml(data.storePhone)}</div>` : ''}
    <div class="badge">إيصال استلام صيانة #${escapeHtml(data.orderNumber)}</div>
  </div>
  <div class="row"><span>التاريخ:</span><span dir="ltr">${escapeHtml(data.date)}</span></div>
  <div class="row"><span>العميل:</span><strong>${escapeHtml(data.customerName)}</strong></div>
  ${data.customerPhone ? `<div class="row"><span>الهاتف:</span><span dir="ltr">${escapeHtml(data.customerPhone)}</span></div>` : ''}
  ${data.deviceType || data.deviceModel ? `<div class="row"><span>الجهاز:</span><strong>${escapeHtml([data.deviceType, data.deviceModel].filter(Boolean).join(' - '))}</strong></div>` : ''}
  <div class="box">
    <strong>وصف العطل / الخدمة:</strong>
    <div>${escapeHtml(data.problemDescription)}</div>
  </div>
  ${data.estimatedCost !== undefined ? `<div class="row"><span>التكلفة:</span><strong>${fmt(data.estimatedCost)}</strong></div>` : ''}
  ${data.paidAmount !== undefined && data.paidAmount > 0 ? `<div class="row"><span>الدفعة المقدمة:</span><strong>${fmt(data.paidAmount)}</strong></div>` : ''}
  ${data.notes ? `<div class="box"><strong>ملاحظات:</strong> ${escapeHtml(data.notes)}</div>` : ''}
  <div class="footer">
    <div>يرجى الاحتفاظ بهذا الإيصال عند الاستلام</div>
    <div>${escapeHtml(saved.footer || 'شكراً لثقتكم بنا')}</div>
  </div>
</body>
</html>`;
}

/**
 * طباعة إيصال صيانة مباشر
 */
export async function printMaintenanceReceipt(data: Parameters<typeof generateMaintenanceReceiptHTML>[0]): Promise<boolean> {
  const html = generateMaintenanceReceiptHTML(data);
  return printHtmlDocument(html, `Maintenance_${data.orderNumber}`);
}

/**
 * اختبار الطباعة السريع (يطبع على الطابعة الحرارية الافتراضية إن وجدت، وإلا عبر النظام)
 */
export async function printTestPage(storeName: string = 'PosFlow'): Promise<boolean> {
  const now = new Date();
  return printReceipt({
    invoiceNumber: 'TEST-001',
    date: now.toLocaleDateString('en-GB'),
    time: now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    storeName,
    customerName: 'عميل تجريبي',
    items: [
      { name: 'اختبار طباعة صنف تجريبي', quantity: 1, unitPrice: 10, total: 10 },
    ],
    subtotal: 10,
    total: 10,
    currencySymbol: '$',
    currencyCode: 'USD',
    paymentType: 'cash',
    notes: 'هذه صفحة اختبار للتأكد من جاهزية الطابعة.',
    copies: 1,
  });
}
