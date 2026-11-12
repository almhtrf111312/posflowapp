/**
 * ألوان ودلالات موحّدة لملفات PDF و Excel (دالة نقية بلا اعتماد على مكتبات).
 *
 * - المبالغ: الربح أخضر والخسارة حمراء، المتبقي من الدين أحمر (وأخضر إن صار صفراً)،
 *   المدفوع/المحصّل أخضر، الخسائر والمرتجعات والخصومات حمراء، وأي مبلغ سالب أحمر.
 * - الحالات: مسدد/مكتمل أخضر مع ✓، غير مسدد/متأخر/ملغى أحمر مع ✗، جزئي/معلّق برتقالي، مشطوب رمادي.
 */

export type Tone = 'positive' | 'negative' | 'warning' | 'muted' | 'neutral';

export interface ToneColors {
  /** لون النص RGB */
  text: [number, number, number];
  /** خلفية خفيفة للخلية RGB */
  fill: [number, number, number];
}

export const TONE_COLORS: Record<Exclude<Tone, 'neutral'>, ToneColors> = {
  positive: { text: [21, 128, 61], fill: [220, 252, 231] },   // أخضر
  negative: { text: [185, 28, 28], fill: [254, 226, 226] },   // أحمر
  warning: { text: [180, 83, 9], fill: [254, 243, 199] },     // برتقالي
  muted: { text: [100, 116, 139], fill: [241, 245, 249] },    // رمادي
};

export const toArgb = ([r, g, b]: [number, number, number]) =>
  'FF' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();

type MoneyRole = 'loss' | 'paid' | 'outstanding' | 'profit' | 'plain';

/** نوع عمود المبلغ من مفتاحه وعنوانه */
export function moneyRole(key: string, header: string): MoneyRole {
  const k = (key || '').toLowerCase();
  const h = header || '';
  if (/خسار|خسائر|مشطوب|معدوم|مرتجع|مسترد|خصم|مصروف|مصاريف/.test(h) || /loss|writeoff|written|refund|discount|expense/.test(k)) return 'loss';
  if (/المتبقي|متبقي|غير مسدد|للتحصيل|مستحق/.test(h) || /remaining|outstanding|due/.test(k)) return 'outstanding';
  if (/المدفوع|مدفوع|مسدد|المسدد|محصل|المحصل|تحصيل/.test(h) || /paid|collected/.test(k)) return 'paid';
  if (/ربح|أرباح|هامش/.test(h) || /profit|margin/.test(k)) return 'profit';
  return 'plain';
}

/** لون المبلغ حسب نوع العمود وقيمته */
export function moneyTone(key: string, header: string, value: number): Tone {
  if (!Number.isFinite(value)) return 'neutral';
  const role = moneyRole(key, header);
  if (value < 0) return role === 'loss' ? 'neutral' : 'negative';
  switch (role) {
    case 'profit': return value > 0 ? 'positive' : 'neutral';
    case 'paid': return value > 0 ? 'positive' : 'neutral';
    case 'outstanding': return value > 0 ? 'negative' : 'positive';
    case 'loss': return value > 0 ? 'negative' : 'neutral';
    default: return 'neutral';
  }
}

const STATUS_WORDS: Record<Exclude<Tone, 'neutral'>, string[]> = {
  positive: [
    'مسدد', 'مسدد بالكامل', 'مسددة', 'مدفوع', 'مدفوعة', 'مكتمل', 'مكتملة', 'مؤكد', 'مؤكدة', 'معتمدة',
    'معتمدة ومكتملة', 'تمت المطابقة', 'تم التسليم', 'مسلّم', 'مسلم', 'جاهز', 'مُعاد', 'تمت الإعادة', 'فعال', 'فعّال', 'نشط',
    'paid', 'fully_paid', 'completed', 'confirmed', 'finalized', 'delivered', 'returned', 'active',
  ],
  negative: [
    'غير مسدد', 'غير مدفوع', 'مستحق', 'متأخر', 'متأخرة', 'ملغى', 'ملغاة', 'ملغي', 'مستردة', 'مسترد', 'مرفوض', 'مرفوضة', 'مفقود', 'منتهي',
    'unpaid', 'due', 'overdue', 'cancelled', 'canceled', 'refunded', 'rejected', 'lost', 'expired',
  ],
  warning: [
    'مسدد جزئياً', 'مسدد جزئيا', 'جزئي', 'معلق', 'معلّق', 'مسودة', 'مراجعة', 'قيد الانتظار', 'قيد التنفيذ', 'قيد الإصلاح', 'بانتظار',
    'partially_paid', 'partial', 'pending', 'draft', 'in_progress', 'reconciled',
  ],
  muted: ['مشطوب', 'معدوم', 'written_off'],
};

const STATUS_INDEX: Map<string, Exclude<Tone, 'neutral'>> = (() => {
  const m = new Map<string, Exclude<Tone, 'neutral'>>();
  (Object.keys(STATUS_WORDS) as Exclude<Tone, 'neutral'>[]).forEach(tone => {
    STATUS_WORDS[tone].forEach(w => m.set(w.toLowerCase(), tone));
  });
  return m;
})();

/** يزيل علامات ✓/✗ المضافة سابقاً قبل المطابقة */
const stripMarks = (s: string) => s.replace(/[✓✔✗✘◐–—]/g, '').trim();

/** لون الحالة النصية (مطابقة تامة لقاموس الحالات حتى لا تتلون أسماء العملاء مثلاً) */
export function statusTone(value: unknown): Tone {
  if (typeof value !== 'string') return 'neutral';
  const v = stripMarks(value).toLowerCase();
  if (!v || v.length > 30) return 'neutral';
  return STATUS_INDEX.get(v) ?? 'neutral';
}

/** الرمز الذي يوضع بجانب الحالة */
export function statusMark(tone: Tone): string {
  switch (tone) {
    case 'positive': return '✔';
    case 'negative': return '✘';
    case 'warning': return '◐';
    case 'muted': return '—';
    default: return '';
  }
}

/**
 * قراءة مبلغ من نص منسَّق مسبقاً (مثل "$1,250.00" أو "-35 ل.س") حتى يتلون أيضاً.
 * يقبل رقماً واحداً فقط مع رمز عملة، فلا يلتقط التواريخ أو الأرقام المركبة.
 */
export function amountFromText(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = s.match(/^[^\d-]*(-?)[^\d-]*([\d,]+(?:\.\d+)?)[^\d]*$/);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  return Number.isFinite(n) ? (m[1] === '-' ? -n : n) : null;
}

/** لون أي خلية: مبلغ رقمي، أو مبلغ نصي في عمود مالي، أو حالة نصية */
export function cellTone(key: string, header: string, value: unknown, isMoneyColumn: boolean): Tone {
  if (typeof value === 'number') return isMoneyColumn ? moneyTone(key, header, value) : 'neutral';
  if (moneyRole(key, header) !== 'plain') {
    const n = amountFromText(value);
    if (n !== null) return moneyTone(key, header, n);
  }
  return 'neutral';
}
