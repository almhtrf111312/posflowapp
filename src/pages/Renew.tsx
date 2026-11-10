import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  Check,
  Copy,
  ExternalLink,
  ShieldCheck,
  ArrowRight,
  MessageSquareQuote,
  Sparkles,
  QrCode,
  Send,
  MessageCircle,
  PhoneCall,
  CheckCircle2,
  CreditCard,
  Download,
} from 'lucide-react';
import { showToast } from '@/lib/toast';
import { sendBossTelegramChatAlert } from '@/lib/telegram-alerts';

const DEFAULT_PLANS = [
  {
    id: 'plan_standard',
    name: 'الباقة القياسية (Standard)',
    price_usd: 25,
    duration_days: 180,
    max_products: 600,
    max_cashiers: 1,
    badge: 'اقتصادية',
    features: ['سعة حتى 600 منتج مع الصور', 'كاشير واحد معتمد', 'إدارة فواتير غير محدودة', 'إدارة الديون والصندوق والتقارير', 'طباعة فواتير حرارية وسحابية'],
    equivalents: [{ text: 'معادل العملات حسب سعر الصرف اليومي' }],
  },
  {
    id: 'plan_pro',
    name: 'الباقة الاحترافية (Pro)',
    price_usd: 45,
    duration_days: 365,
    max_products: 1000,
    max_cashiers: 3,
    badge: 'الأكثر طلباً ⭐',
    features: ['سعة حتى 1000 منتج (فوق 600 بدون صور)', 'حتى 3 كاشيرات للمتجر', 'كافة ميزات الباقة القياسية', 'نسخ احتياطي سحابي تلقائي', 'دعم فني سريع وأولوية بالتحديثات'],
    equivalents: [{ text: 'معادل العملات حسب سعر الصرف اليومي' }],
  },
  {
    id: 'plan_institution',
    name: 'باقة المؤسسات (Institution)',
    price_usd: 80,
    duration_days: 365,
    max_products: 5000,
    max_cashiers: 10,
    badge: 'غير محدودة',
    features: ['سعة ضخمة حتى 5000 منتج بصور كاملة', 'حتى 10 كاشيرات وموزعين', 'تزامن عالي السرعة بين الفروع والأجهزة', 'دعم فني VIP مخصص على مدار الساعة'],
    equivalents: [{ text: 'معادل العملات حسب سعر الصرف اليومي' }],
  },
];

const DEFAULT_METHODS = [
  {
    id: 'method_sham',
    name: 'شام كاش / محفظة إلكترونية',
    account_number: 'SHAM-7729104',
    button_label: 'فتح محفظة شام كاش',
    link_url: '',
    qr_image_url: '',
    badge: 'فوري ⚡',
    instructions: 'قم بالتحويل إلى رقم المحفظة أو امسح الباركود، ثم اضغط زر إرسال الإشعار للدعم الفني.',
  },
  {
    id: 'method_usdt',
    name: 'USDT (TRC20)',
    account_number: 'TXyZ8829KmnPQ11234flowposproTRC20',
    button_label: 'نسخ عنوان المحفظة',
    link_url: '',
    qr_image_url: '',
    badge: 'دولي 🌐',
    instructions: 'حول المبلغ بالدولار الرقمي عبر شبكة Tron (TRC20)، ثم اضغط زر إرسال الإشعار للدعم الفني.',
  },
  {
    id: 'method_direct',
    name: 'حوالة هرم / فؤاد / كاش',
    account_number: 'اسم المستلم معتمد لدى الإدارة',
    button_label: 'طلب بيانات الحوالة المباشرة',
    link_url: '',
    qr_image_url: '',
    badge: 'وكيل معتمد',
    instructions: 'أرسل الحوالة باسم المستلم المعتمد ثم أرسل إشعار التحويل للدعم الفني لتفعيل الترخيص فورياً.',
  },
];

interface ContactLinks {
  phone?: string;
  whatsapp?: string;
  telegram?: string;
  facebook?: string;
}

export default function RenewPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [plans, setPlans] = useState<any[]>(DEFAULT_PLANS);
  const [methods, setMethods] = useState<any[]>(DEFAULT_METHODS);
  const [selectedPlan, setSelectedPlan] = useState<any>(DEFAULT_PLANS[1]);
  const [selectedMethod, setSelectedMethod] = useState<any>(DEFAULT_METHODS[0]);
  const [contactLinks, setContactLinks] = useState<ContactLinks>({});
  const [payerName, setPayerName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeRequest, setActiveRequest] = useState<any>(null);

  // حوار تأكيد الإرسال للعميل
  const [successDialog, setSuccessDialog] = useState<{
    open: boolean;
    refCode: string;
    messageText: string;
    whatsappUrl?: string;
    telegramUrl?: string;
  }>({
    open: false,
    refCode: '',
    messageText: '',
  });

  useEffect(() => {
    loadData();
  }, [user]);

  async function loadData() {
    try {
      // 1. جلب الباقات المفعّلة
      const { data: plansData, error: plansErr } = await supabase
        .from('subscription_plans' as any)
        .select('*')
        .eq('enabled', true)
        .order('sort_order', { ascending: true });

      if (!plansErr && plansData && plansData.length > 0) {
        setPlans(plansData);
        setSelectedPlan(plansData[0]);
      }

      // 2. جلب طرق الدفع المفعّلة
      const { data: methodsData, error: methodsErr } = await supabase
        .from('payment_methods' as any)
        .select('*')
        .eq('enabled', true)
        .order('sort_order', { ascending: true });

      if (!methodsErr && methodsData && methodsData.length > 0) {
        setMethods(methodsData);
        setSelectedMethod(methodsData[0]);
      }

      // 3. جلب قنوات التواصل من إعدادات النظام
      const { data: settingsData } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'contact_links')
        .maybeSingle();

      if (settingsData?.value) {
        try {
          const parsed = JSON.parse(settingsData.value);
          setContactLinks(parsed);
        } catch { /* ignore parse error */ }
      }

      // 4. التحقق من وجود طلب مفتوح
      if (user?.id) {
        const { data: reqData } = await supabase
          .from('subscription_requests' as any)
          .select('*')
          .eq('user_id', user.id)
          .in('status', ['pending', 'paid_claimed'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (reqData) {
          setActiveRequest(reqData);
        }
      }
    } catch (err) {
      console.warn('Using default renewal configuration:', err);
    }
  }

  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [isDownloadingQR, setIsDownloadingQR] = useState(false);

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(text);
    showToast.success(`تم نسخ ${label} بنجاح`);
    setTimeout(() => {
      setCopiedField(prev => (prev === text ? null : prev));
    }, 2500);
  };

  const handleDownloadQR = async (imageUrl: string, methodName: string) => {
    setIsDownloadingQR(true);
    try {
      const cleanName = (methodName || 'payment').replace(/[^\w\u0600-\u06FF-]/g, '_');
      const filename = `${cleanName}-QR.png`;

      if (imageUrl.startsWith('data:')) {
        const link = document.createElement('a');
        link.href = imageUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast.success('تم تنزيل صورة الباركود وحفظها بنجاح');
        return;
      }

      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);
      showToast.success('تم تنزيل صورة الباركود وحفظها بنجاح');
    } catch (err) {
      console.warn('Direct download fallback:', err);
      window.open(imageUrl, '_blank');
      showToast.info('تم فتح الصورة، يمكنك حفظها بالضغط المطول عليها');
    } finally {
      setIsDownloadingQR(false);
    }
  };

  const isImageUrl = (url?: string) => {
    if (!url) return false;
    const clean = url.toLowerCase();
    return clean.startsWith('http') || clean.startsWith('data:image') || clean.endsWith('.png') || clean.endsWith('.jpg') || clean.endsWith('.jpeg') || clean.endsWith('.webp');
  };

  const handleClaimPayment = async () => {
    if (!selectedPlan || !selectedMethod) return;
    setSubmitting(true);

    try {
      // توليد كود مرجعي رسمي سهل القراءة (مثال: FP-9281)
      const refCode = `FP-${Math.floor(1000 + Math.random() * 9000)}`;

      const { data: insertData, error: insertError } = await supabase
        .from('subscription_requests' as any)
        .insert({
          user_id: user?.id,
          plan_id: selectedPlan.id,
          plan_name: selectedPlan.name,
          plan_days: selectedPlan.duration_days,
          plan_audience: selectedPlan.audience || 'standard',
          price_usd: selectedPlan.price_usd,
          method_id: selectedMethod.id,
          method_name: selectedMethod.name,
          ref_code: refCode,
          payer_name: payerName.trim() || user?.email || 'عميل المتجر',
          payer_ref: refCode,
          status: 'paid_claimed',
        })
        .select('id')
        .single();

      if (insertError) throw insertError;

      // إرسال إشعار تليجرام فوري للمدير العام كإشعار احتياطي
      sendBossTelegramChatAlert(
        payerName.trim() || user?.email || 'عميل المتجر',
        (user as any)?.phone || '',
        `طلب تجديد: ${selectedPlan.name} ($${selectedPlan.price_usd}) - طريقة التحويل: ${selectedMethod.name}`,
        refCode
      ).catch(() => {});

      // إعداد نص الرسالة المعتمد للدعم الفني
      const messageText =
        `مرحباً، قمت بتحويل قيمة اشتراك ${selectedPlan.name} ($${selectedPlan.price_usd}).\n` +
        `رقم مرجع الطلب: ${refCode}\n` +
        `طريقة التحويل: ${selectedMethod.name}\n` +
        `أرفق لكم صورة إشعار التحويل للتفعيل.`;

      // روابط التوجيه المباشرة
      let whatsappUrl: string | undefined;
      let telegramUrl: string | undefined;

      const rawWhatsapp = contactLinks.whatsapp || contactLinks.phone;
      if (rawWhatsapp) {
        const cleanPhone = rawWhatsapp.replace(/[^0-9]/g, '');
        whatsappUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(messageText)}`;
      }

      if (contactLinks.telegram) {
        let tg = contactLinks.telegram.trim();
        if (tg.startsWith('@')) tg = `https://t.me/${tg.substring(1)}`;
        else if (!tg.startsWith('http')) tg = `https://t.me/${tg}`;
        telegramUrl = tg;
      }

      // إذا كان واتساب متاحاً، نفتحه تلقائياً في نافذة جديدة
      if (whatsappUrl) {
        window.open(whatsappUrl, '_blank');
      }

      setSuccessDialog({
        open: true,
        refCode,
        messageText,
        whatsappUrl,
        telegramUrl,
      });

      showToast.success('تم تسجيل طلبك وتجهيز إشعار التحويل للدعم الفني');
      loadData();
    } catch (e: any) {
      showToast.error(e.message || 'فشل إرسال الطلب، يرجى التواصل مع الدعم الفني مباشرة');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="container max-w-4xl mx-auto py-8 px-4 font-sans dir-rtl" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-primary" />
            تجديد وترقية الاشتراك
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            اختر باقة الاشتراك وطريقة الدفع المفضلة لمتجرك وسعة منتجاتك
          </p>
        </div>
        <Button variant="outline" onClick={() => navigate(-1)} className="gap-2">
          <ArrowRight className="w-4 h-4" /> العودة
        </Button>
      </div>

      {/* في حال وجود طلب قيد المراجعة */}
      {activeRequest && (
        <Card className="mb-8 border-amber-500/30 bg-amber-500/10">
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <Badge variant="outline" className="bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-500">
                  طلبك قيد المراجعة: {activeRequest.ref_code}
                </Badge>
                <h3 className="font-semibold text-lg mt-2">{activeRequest.plan_name} — {activeRequest.price_usd}$</h3>
                <p className="text-sm text-muted-foreground">
                  طريقة التحويل: {activeRequest.method_name} | رقم المرجع: {activeRequest.ref_code}
                </p>
              </div>
              <Button variant="secondary" onClick={() => navigate('/contact')} className="gap-2 shrink-0">
                <MessageSquareQuote className="w-4 h-4" /> محادثة الدعم الفني
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 1. شبكة الباقات */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-4">1. اختر الباقة المناسبة</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {plans.map((p) => {
            const isSelected = selectedPlan?.id === p.id;
            return (
              <Card
                key={p.id}
                onClick={() => setSelectedPlan(p)}
                className={`cursor-pointer transition-all border-2 ${
                  isSelected ? 'border-primary shadow-md bg-primary/5' : 'border-border hover:border-primary/40'
                }`}
              >
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-base">{p.name}</CardTitle>
                    {p.badge && <Badge variant={isSelected ? 'default' : 'secondary'}>{p.badge}</Badge>}
                  </div>
                  <div className="mt-2">
                    <span className="text-2xl font-bold">${p.price_usd}</span>
                    <span className="text-xs text-muted-foreground mr-1">/ {p.duration_days} يوماً</span>
                  </div>
                  {Array.isArray(p.equivalents) && p.equivalents.map((eq: any, idx: number) => (
                    <div key={idx} className="text-xs text-muted-foreground font-medium mt-1">
                      {eq.text}
                    </div>
                  ))}
                </CardHeader>
                <CardContent className="text-xs space-y-1.5 pt-2 border-t">
                  <div className="text-foreground font-semibold flex items-center justify-between">
                    <span>📦 سعة المنتجات:</span>
                    <span>{p.max_products} منتج</span>
                  </div>
                  <div className="text-foreground font-semibold flex items-center justify-between">
                    <span>👥 عدد الكاشيرات:</span>
                    <span>{p.max_cashiers || 1} كاشير</span>
                  </div>
                  <div className="pt-1 space-y-1">
                    {p.features?.map((f: string, i: number) => (
                      <div key={i} className="flex items-center gap-1.5 text-muted-foreground">
                        <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                        <span>{f}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* 2. أزرار وطرق الدفع الديناميكية والـ QR */}
      {selectedPlan && (
        <div className="space-y-6">
          <h2 className="text-lg font-semibold">2. اختر طريقة التحويل</h2>

          {/* أزرار طرق الدفع */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {methods.map((m) => {
              const isSelected = selectedMethod?.id === m.id;
              return (
                <Button
                  key={m.id}
                  variant={isSelected ? 'default' : 'outline'}
                  onClick={() => setSelectedMethod(m)}
                  className={`h-auto py-3 px-4 flex flex-col gap-1 items-center justify-center text-center whitespace-normal border-2 ${
                    isSelected ? 'border-primary shadow-sm' : 'border-border'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-sm">{m.name}</span>
                    {m.badge && <Badge variant="secondary" className="text-[10px]">{m.badge}</Badge>}
                  </div>
                </Button>
              );
            })}
          </div>

          {/* بطاقة تفاصيل الدفع والـ QR والأزرار التفاعلية */}
          {selectedMethod && (() => {
            const transferCode = selectedMethod.account_number || (!isImageUrl(selectedMethod.qr_image_url) ? selectedMethod.qr_image_url : null);
            const qrImage = isImageUrl(selectedMethod.qr_image_url) ? selectedMethod.qr_image_url : null;
            const isCodeCopied = Boolean(transferCode && copiedField === transferCode);

            return (
              <Card className="bg-card border-border shadow-xs">
                <CardContent className="pt-6 space-y-6">
                  {/* رأس طريقة الدفع والتعليمات */}
                  <div className="space-y-1.5 border-b pb-4">
                    <div className="text-base font-bold text-primary flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CreditCard className="w-5 h-5 text-primary" />
                        <span>طريقة الدفع: {selectedMethod.name}</span>
                      </div>
                      {selectedMethod.badge && (
                        <Badge variant="secondary" className="font-medium text-xs px-2.5 py-0.5">
                          {selectedMethod.badge}
                        </Badge>
                      )}
                    </div>
                    {selectedMethod.instructions && (
                      <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
                        {selectedMethod.instructions}
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
                    {/* العمود الأول: كود / عنوان التحويل ورابط الدفع */}
                    <div className="space-y-4">
                      {transferCode && (
                        <div className="space-y-1.5">
                          <Label className="text-xs font-bold text-foreground">
                            كود / عنوان التحويل أو المحفظة:
                          </Label>
                          <div className="flex items-center justify-between p-3 rounded-xl bg-muted/70 border border-primary/20 gap-2">
                            <span className="font-mono font-bold text-sm truncate select-all text-foreground" dir="ltr">
                              {transferCode}
                            </span>
                            <Button
                              size="sm"
                              variant={isCodeCopied ? "default" : "outline"}
                              className={`gap-1.5 shrink-0 h-9 px-3 font-semibold transition-all ${
                                isCodeCopied ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''
                              }`}
                              onClick={() => handleCopy(transferCode, 'كود التحويل / المحفظة')}
                            >
                              {isCodeCopied ? (
                                <>
                                  <Check className="w-4 h-4 text-white" />
                                  <span>تم النسخ بنجاح</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-4 h-4" />
                                  <span>نسخ الكود</span>
                                </>
                              )}
                            </Button>
                          </div>
                          <span className="text-[11px] text-muted-foreground block">
                            انقر فوق نسخ لأخذ رقم الحساب أو كود المحفظة ولصقه مباشرة في تطبيق التحويل.
                          </span>
                        </div>
                      )}

                      {/* زر فتح الرابط المباشر إن وُجد */}
                      {selectedMethod.link_url && (
                        <div className="space-y-1.5 pt-1">
                          <Button
                            onClick={() => window.open(selectedMethod.link_url, '_blank')}
                            className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold h-11 text-sm shadow-xs"
                          >
                            <ExternalLink className="w-4 h-4" />
                            {selectedMethod.button_label || 'فتح رابط الدفع المباشر'}
                          </Button>
                          <span className="text-[11px] text-muted-foreground block text-center">
                            يفتح بوابة الدفع أو التطبيق المعتمد مباشرة في نافذة جديدة.
                          </span>
                        </div>
                      )}
                    </div>

                    {/* العمود الثاني: صورة الباركود / QR مع زر التنزيل المباشر */}
                    {qrImage ? (
                      <div className="flex flex-col items-center justify-center p-4 border rounded-2xl bg-muted/20 space-y-3">
                        <img
                          src={qrImage}
                          alt="QR Code"
                          className="w-44 h-44 object-contain rounded-xl border p-2 bg-white shadow-xs"
                        />
                        <div className="w-full space-y-1.5 text-center">
                          <Button
                            onClick={() => handleDownloadQR(qrImage, selectedMethod.name)}
                            variant="secondary"
                            className="w-full gap-2 h-9 text-xs font-semibold bg-background hover:bg-muted border shadow-xs"
                            disabled={isDownloadingQR}
                          >
                            <Download className="w-4 h-4 text-primary" />
                            {isDownloadingQR ? 'جاري التحميل...' : '📥 تحميل وحفظ في المعرض'}
                          </Button>
                          <span className="text-[11px] text-muted-foreground block">
                            يتم حفظ الصورة في مجلد التنزيلات لتتمكن من مسحها من تطبيق محفظتك أو بنكك.
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center p-6 border border-dashed rounded-2xl bg-muted/10 text-center space-y-2 text-muted-foreground">
                        <QrCode className="w-8 h-8 opacity-40" />
                        <span className="text-xs">
                          طريقة الدفع هذه تعتمد على كود التحويل أعلاه مباشرة دون الحاجة لمسح باركود.
                        </span>
                      </div>
                    )}
                  </div>

                  {/* قسم إرسال الإشعار للدعم الفني (بدون تعقيد الحسابات البنكية) */}
                  <div className="pt-4 border-t space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center">
                      <div className="sm:col-span-2 space-y-1">
                        <Input
                          placeholder="اسم المحوّل أو ملاحظة اختيارية (اختياري)"
                          value={payerName}
                          onChange={(e) => setPayerName(e.target.value)}
                          className="h-11"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          لا داعي لتعبئة تفاصيل معقدة؛ سيتم توليد رقم مرجع فوري وإرسال إشعار الدفع مباشرة للدعم.
                        </p>
                      </div>

                      <Button
                        onClick={handleClaimPayment}
                        disabled={submitting}
                        className="gap-2 h-11 w-full bg-primary font-bold text-sm shadow-md"
                      >
                        <Send className="w-4 h-4" />
                        {submitting ? 'جاري التسجيل...' : '📲 تم التحويل - إرسال الإشعار للدعم'}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })()}
        </div>
      )}

      {/* حوار تأكيد الطلب وتوجيه العميل للدعم الفني */}
      <Dialog open={successDialog.open} onOpenChange={(open) => setSuccessDialog(prev => ({ ...prev, open }))}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <div className="flex items-center gap-2 text-emerald-600 mb-1">
              <CheckCircle2 className="w-6 h-6" />
              <DialogTitle className="text-lg">تم تسجيل طلب التجديد بنجاح!</DialogTitle>
            </div>
          </DialogHeader>

          <div className="space-y-4 py-2 text-sm">
            <div className="p-4 rounded-2xl bg-muted/60 border text-center space-y-1.5">
              <span className="text-xs text-muted-foreground block">رقم مرجع الطلب الرسمي:</span>
              <div className="flex items-center justify-center gap-2">
                <span className="font-mono text-2xl font-black text-primary tracking-wider">
                  {successDialog.refCode}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => handleCopy(successDialog.refCode, 'رقم المرجع')}
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                احتفظ بهذا الرقم أو أرسله مباشرة عبر واتساب / تليجرام مع صورة الإيصال.
              </p>
            </div>

            <div className="space-y-2">
              <span className="font-bold text-xs block text-foreground">قنوات إرسال إشعار التحويل للدعم:</span>
              <div className="grid grid-cols-1 gap-2">
                {successDialog.whatsappUrl && (
                  <Button
                    onClick={() => window.open(successDialog.whatsappUrl, '_blank')}
                    className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold h-11 justify-center"
                  >
                    <MessageCircle className="w-5 h-5" />
                    إرسال الإشعار عبر واتساب
                  </Button>
                )}
                {successDialog.telegramUrl && (
                  <Button
                    variant="outline"
                    onClick={() => window.open(successDialog.telegramUrl, '_blank')}
                    className="gap-2 font-bold h-11 justify-center border-primary/30"
                  >
                    <Send className="w-4 h-4 text-sky-500" />
                    محادثة تليجرام
                  </Button>
                )}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" className="w-full" onClick={() => setSuccessDialog(prev => ({ ...prev, open: false }))}>
              تم، العودة للشاشة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
