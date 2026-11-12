/**
 * حماية الطباعة من حقن السكربتات (XSS):
 * أسماء المنتجات، تذييل الفاتورة، بيانات المتجر والعميل كلها نصوص يكتبها مستخدمون،
 * وتُدمج في HTML يُكتب داخل iframe على نفس النطاق، فأي <script> أو onerror فيها كان يُنفَّذ
 * بصلاحيات التطبيق. هنا: escapeHtml لكل نص، و sanitizePrintHtml كخط دفاع أخير لكل طباعة.
 */

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** رابط صورة آمن: صور data/http(s)/blob فقط */
export function safeImageSrc(src: unknown): string {
  const s = String(src ?? '').trim();
  if (/^(data:image\/|https?:\/\/|blob:)/i.test(s)) return escapeHtml(s);
  return '';
}

const BLOCKED_TAGS = 'script, iframe, frame, frameset, object, embed, applet, base, form, input, button, textarea, select, link:not([rel="stylesheet"]), meta[http-equiv]';

/**
 * تنظيف مستند HTML كامل قبل الطباعة: حذف الوسوم التنفيذية، وكل خصائص on*،
 * والروابط من نوع javascript: — مع الإبقاء على التنسيق (style) والصور.
 */
export function sanitizePrintHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll(BLOCKED_TAGS).forEach(el => el.remove());
    doc.querySelectorAll('*').forEach(el => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim().toLowerCase();
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
        } else if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action' || name === 'formaction')
          && (value.startsWith('javascript:') || value.startsWith('vbscript:') || value.startsWith('data:text/html'))) {
          el.removeAttribute(attr.name);
        } else if (name === 'style' && /expression\s*\(|javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    });
    const dir = doc.documentElement.getAttribute('dir');
    return `<!DOCTYPE html>${doc.documentElement.outerHTML}`.replace('<html>', dir ? `<html dir="${dir}">` : '<html>');
  } catch {
    // إن فشل التحليل نُسقط أي وسم script على الأقل
    return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  }
}
