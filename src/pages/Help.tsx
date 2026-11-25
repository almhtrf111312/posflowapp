import { capsuleOuter, capsuleOuterScroll, capsuleItem, capsuleActive, capsuleIdle } from '@/components/ui/SegmentedCapsule';
import { useState } from 'react';
import { 
  BookOpen, ChevronDown, ChevronUp,
  Barcode, Package, FileText, Shield, Warehouse, Users, CreditCard, 
  BarChart3, Receipt, Wrench, HelpCircle, Sparkles, Search
} from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { useLanguage } from '@/hooks/language-context';
import { useUserRole } from '@/hooks/user-role-context';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { PageHeader } from '@/components/layout/PageHeader';

interface FAQItem {
  question: string;
  answer: string;
  adminOnly?: boolean;
}

interface FeatureItem {
  icon: React.ElementType;
  titleAr: string;
  titleEn: string;
  descAr: string;
  descEn: string;
  adminOnly?: boolean;
}

const features: FeatureItem[] = [
  { icon: Barcode, titleAr: 'باركود متعدد', titleEn: 'Multi-Barcode', descAr: 'دعم حتى 3 باركودات لكل منتج لتسهيل الجرد والبيع', descEn: 'Support up to 3 barcodes per product for easy inventory and sales' },
  { icon: Package, titleAr: 'نظام الأصناف المرن', titleEn: 'Flexible Variants', descAr: 'إضافة خيارات متعددة (حجم، لون، نوع) بأسعار وكميات مختلفة', descEn: 'Add multiple options (size, color, type) with different prices and quantities' },
  { icon: BarChart3, titleAr: 'تقارير ذكية', titleEn: 'Smart Reports', descAr: 'تقارير جرد ومبيعات وأرباح تفصيلية مع فلترة متقدمة', descEn: 'Detailed inventory, sales, and profit reports with advanced filtering', adminOnly: true },
  { icon: Shield, titleAr: 'أمان البيانات', titleEn: 'Data Security', descAr: 'نسخ احتياطي محلي وسحابي مع تشفير وربط بالجهاز', descEn: 'Local and cloud backup with encryption and device binding' },
  { icon: Users, titleAr: 'إدارة العملاء', titleEn: 'Customer Management', descAr: 'سجل عملاء متكامل مع تتبع المشتريات والديون', descEn: 'Complete customer records with purchase and debt tracking' },
  { icon: CreditCard, titleAr: 'نظام الديون', titleEn: 'Debt System', descAr: 'تسجيل ديون نقدية وآجلة مع تتبع الأقساط والتنبيهات', descEn: 'Cash and credit debts with installment tracking and alerts' },
  { icon: Receipt, titleAr: 'الفوترة', titleEn: 'Invoicing', descAr: 'فواتير بيع وشراء مع طباعة ومشاركة عبر واتساب', descEn: 'Sales and purchase invoices with print and WhatsApp sharing' },
  { icon: Wrench, titleAr: 'خدمات الصيانة', titleEn: 'Maintenance', descAr: 'تسجيل ومتابعة أوامر الصيانة وحساب الأرباح', descEn: 'Track maintenance orders and calculate profits', adminOnly: true },
  { icon: FileText, titleAr: 'وحدات مزدوجة', titleEn: 'Dual Units', descAr: 'دعم وحدات القياس المتعددة (قطعة، كرتونة، كيلو، متر)', descEn: 'Support multiple units (piece, carton, kilo, meter)' },
];

const faqsAr: FAQItem[] = [
  { question: 'كيف أضيف منتج بباركودات متعددة؟', answer: 'من صفحة المنتجات، أضف منتج جديد واملأ حقل الباركود الأساسي، ثم أضف باركود 2 و3 في الحقول الإضافية. يمكن البحث بأي منها في نقطة البيع.' },
  { question: 'كيف أفرّق بين أصناف نفس المنتج؟', answer: 'استخدم حقل "المتغير/الوصف" لتمييز كل صنف (مثل: حجم كبير، لون أحمر). عند مسح باركود مشترك، ستظهر نافذة اختيار الصنف مع السعر والكمية.' },
  { question: 'كيف أصدّر تقارير المبيعات؟', answer: 'من صفحة التقارير، اختر نوع التقرير وحدد الفترة الزمنية، ثم اضغط "تصدير" لتحميل التقرير بصيغة Excel أو PDF.', adminOnly: true },
  { question: 'كيف أضمن سلامة النسخة الاحتياطية؟', answer: 'من الإعدادات > النسخ الاحتياطي، فعّل النسخ التلقائي السحابي. يتم تشفير البيانات قبل الرفع. يمكنك أيضاً عمل نسخة محلية.' },
  { question: 'كيف أدير مستودعات متعددة؟', answer: 'من صفحة المستودعات، أضف مستودعات رئيسية ومخازن موزعين. استخدم "تحويل العهدة" لنقل البضاعة بين المخازن مع إيصال استلام.', adminOnly: true },
  { question: 'كيف أسجّل دين على عميل؟', answer: 'عند البيع في نقطة البيع، اختر "دفع آجل" وأدخل بيانات العميل. أو من صفحة الديون، أضف "دين نقدي" بدون فاتورة.' },
  { question: 'كيف أغيّر لغة التطبيق؟', answer: 'من الإعدادات > اللغة، اختر بين العربية والإنجليزية. سيتم تغيير اتجاه الواجهة تلقائياً.' },
  { question: 'ما الفرق بين المشرف والكاشير؟', answer: 'المشرف يملك صلاحيات كاملة (منتجات، تقارير، إعدادات). الكاشير يقتصر على نقطة البيع والفواتير والعملاء.' },
];

const faqsEn: FAQItem[] = [
  { question: 'How do I add a product with multiple barcodes?', answer: 'From Products page, add a new product and fill the main barcode field, then add barcode 2 and 3 in the additional fields. You can search by any of them in POS.' },
  { question: 'How do I differentiate variants of the same product?', answer: 'Use the "Variant/Description" field to distinguish each variant (e.g., large size, red color). When scanning a shared barcode, a variant picker will appear with price and quantity.' },
  { question: 'How do I export sales reports?', answer: 'From Reports page, choose the report type and select the date range, then click "Export" to download as Excel or PDF.', adminOnly: true },
  { question: 'How do I ensure backup safety?', answer: 'From Settings > Backup, enable automatic cloud backup. Data is encrypted before upload. You can also create a local backup.' },
  { question: 'How do I record a customer debt?', answer: 'When selling in POS, choose "Credit" payment and enter customer details. Or from Debts page, add a "Cash Debt" without an invoice.' },
  { question: 'How do I change the app language?', answer: 'From Settings > Language, choose between Arabic and English. The interface direction will change automatically.' },
  { question: 'What\'s the difference between Admin and Cashier?', answer: 'Admin has full access (products, reports, settings). Cashier is limited to POS, invoices, and customers.' },
];

export default function HelpPage() {
  const { t, language, isRTL } = useLanguage();
  const { isOwner } = useUserRole();
  const isAr = language === 'ar';
  const allFaqs = isAr ? faqsAr : faqsEn;
  const faqs = allFaqs.filter(f => !f.adminOnly || isOwner);
  const displayFeatures = features.filter(f => !f.adminOnly || isOwner);

  const [expandedFaq, setExpandedFaq] = useState<number | null>(null);

  const [activeTab, setActiveTab] = useState<'features' | 'faq'>('features');
  const [faqSearch, setFaqSearch] = useState('');

  const filteredFaqs = faqs.filter(f => 
    !faqSearch.trim() || 
    f.question.toLowerCase().includes(faqSearch.toLowerCase()) || 
    f.answer.toLowerCase().includes(faqSearch.toLowerCase())
  );

  return (
    <MainLayout>
      <div className="p-3 sm:p-4 md:p-6 max-w-5xl mx-auto space-y-4 md:space-y-6">
        {/* Page Header */}
        <PageHeader
          title={isAr ? 'مركز التعليمات والمساعدة' : 'Help & Documentation Center'}
          subtitle={isAr ? 'دليل الاستخدام والأسئلة الشائعة' : 'User guide and FAQs'}
          icon={<BookOpen className="w-5 h-5 text-primary" />}

        />

        {/* Modern 2-Button Segmented Navigation Tabs — Unified Capsule */}
        <div className={capsuleOuter}>
          <button
            type="button"
            onClick={() => setActiveTab('features')}
            className={cn(
              capsuleItem,
              activeTab === 'features'
                ? "bg-gradient-primary text-primary-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground hover:bg-card/60"
            )}
          >
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            <span>{isAr ? 'ميزات النظام' : 'Features'}</span>
            <Badge variant="secondary" className="bg-background/30 text-current tabular-nums">{displayFeatures.length}</Badge>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('faq')}
            className={cn(
              capsuleItem,
              activeTab === 'faq'
                ? "bg-gradient-primary text-primary-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground hover:bg-card/60"
            )}
          >
            <HelpCircle className="w-3.5 h-3.5 shrink-0" />
            <span>{isAr ? 'الأسئلة الشائعة' : 'FAQs'}</span>
            <Badge variant="secondary" className="bg-background/30 text-current tabular-nums">{faqs.length}</Badge>
          </button>
        </div>

        {/* Tab 1: Features */}
        {activeTab === 'features' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              {displayFeatures.map((f, i) => (
                <div key={i} className="bg-card rounded-xl border border-border p-3.5 hover:border-primary/40 transition-all hover:shadow-sm">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 mt-0.5">
                      <f.icon className="w-4 h-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{isAr ? f.titleAr : f.titleEn}</h3>
                      <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{isAr ? f.descAr : f.descEn}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tab 2: FAQ */}
        {activeTab === 'faq' && (
          <div className="space-y-3">
            <div className="relative flex-1 min-w-0">
              <Search className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={faqSearch}
                onChange={e => setFaqSearch(e.target.value)}
                placeholder={isAr ? 'ابحث في الأسئلة الشائعة...' : 'Search FAQs...'}
                className="ps-9 pe-3"
              />
            </div>

            <div className="space-y-1.5">
              {filteredFaqs.map((faq, i) => (
                <div
                  key={i}
                  className={cn(
                    "bg-card rounded-xl border transition-all overflow-hidden",
                    expandedFaq === i ? "border-primary/40 shadow-sm" : "border-border hover:border-border/80"
                  )}
                >
                  <button
                    className="w-full p-3 flex items-center justify-between text-start"
                    onClick={() => setExpandedFaq(expandedFaq === i ? null : i)}
                  >
                    <span className="font-semibold text-xs text-foreground">{faq.question}</span>
                    {expandedFaq === i ? (
                      <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                    )}
                  </button>
                  {expandedFaq === i && (
                    <div className="px-3 pb-3 pt-2 border-t border-border/40 mt-1">
                      <p className="text-xs text-muted-foreground leading-relaxed">{faq.answer}</p>
                    </div>
                  )}
                </div>
              ))}
              {filteredFaqs.length === 0 && (
                <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
                  <HelpCircle className="w-12 h-12 text-muted-foreground/50 mb-3" />
                  <p className="text-sm sm:text-base font-semibold text-foreground">
                    {isAr ? 'لم يتم العثور على نتائج مطابقة' : 'No matching FAQs found'}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
