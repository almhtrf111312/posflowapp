import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogBody } from '@/components/ui/dialog';
import {
  Check,
  Copy,
  ExternalLink,
  ShieldCheck,
  ArrowLeft,
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
import { toast as showToast } from '@/lib/sonner-bridge';
import { PageHeader } from '@/components/layout/PageHeader';
import { useLanguage } from '@/hooks/use-language';
import { compressImage } from '@/lib/image-upload';
import { sendBossTelegramChatAlert } from '@/lib/telegram-alerts';

import type { Tables } from '@/integrations/supabase/types';

type PlanRow = Tables<'subscription_plans'>;
type PlanView = Partial<PlanRow> & Pick<PlanRow, 'id' | 'name' | 'price_usd' | 'duration_days' | 'max_products' | 'max_cashiers'>;
type MethodRow = Tables<'payment_methods'>;
type RequestRow = Tables<'subscription_requests'>;

const DEFAULT_PLANS: PlanView[] = [
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


interface ContactLinks {
  phone?: string;
  whatsapp?: string;
  telegram?: string;
  facebook?: string;
}

export default function RenewPage() {
  const { user } = useAuth();
  const { direction } = useLanguage();
  const navigate = useNavigate();
  const [plans, setPlans] = useState<PlanView[]>(DEFAULT_PLANS);
  const [methods, setMethods] = useState<MethodRow[]>([]);
  const [selectedPlan, setSelectedPlan] = useState<PlanView>(DEFAULT_PLANS[1]);
  const [selectedMethod, setSelectedMethod] = useState<MethodRow | null>(null);
  const [contactLinks, setContactLinks] = useState<ContactLinks>({});
  const [payerName, setPayerName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [proofImage, setProofImage] = useState<string | null>(null);
  const [proofLoading, setProofLoading] = useState(false);

  const handleProofPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (isPdf && file.size > 512 * 1024) {
      showToast.error('ملف PDF أكبر من 512 كيلوبايت، اختر ملفاً أصغر أو أرسل صورة');
      return;
    }
    setProofLoading(true);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const raw = ev.target?.result as string;
        setProofImage(isPdf ? raw.replace(/^data:[^;]*;/, 'data:application/pdf;') : await compressImage(raw, 120, 1200, 1200));
      } catch {
        showToast.error('تعذر قراءة الصورة، اختر صورة أخرى');
      } finally {
        setProofLoading(false);
      }
    };
    reader.onerror = () => setProofLoading(false);
    reader.readAsDataURL(file);
  };
  const [activeRequest, setActiveRequest] = useState<RequestRow | null>(null);

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
        .from('subscription_plans')
        .select('*')
        .eq('enabled', true)
        .order('sort_order', { ascending: true });

      if (!plansErr && plansData && plansData.length > 0) {
        setPlans(plansData);
        setSelectedPlan(plansData[0]);
      }

      // 2. جلب طرق الدفع المفعّلة
      const { data: methodsData, error: methodsErr } = await supabase
        .from('payment_methods')
        .select('*')
        .eq('enabled', true)
        .order('sort_order', { ascending: true });

      if (!methodsErr && methodsData) {
        setMethods(methodsData);
        setSelectedMethod((prev) => methodsData.find((m) => m.id === prev?.id) || methodsData[0] || null);
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
          .from('subscription_requests')
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

  const isValidUUID = (str?: string | null): boolean => {
    if (!str) return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
  };

  const handleClaimPayment = async () => {
    if (!selectedPlan || !selectedMethod || !user?.id || submitting || proofLoading) return;
    if (!proofImage) {
      showToast.error('يرجى إرفاق صورة إشعار التحويل أولاً');
      return;
    }
    setSubmitting(true);

    try {
      // توليد كود مرجعي رسمي سهل القراءة (مثال: FP-9281)
      let refCode = `FP-${Math.floor(1000 + Math.random() * 9000)}`;

      const planUuid = isValidUUID(selectedPlan.id) ? selectedPlan.id : null;
      const methodUuid = isValidUUID(selectedMethod.id) ? selectedMethod.id : null;

      const { data: insertData, error: insertError } = await supabase
        .from('subscription_requests')
        .insert({
          user_id: user?.id,
          plan_id: planUuid,
          plan_name: selectedPlan.name,
          plan_days: selectedPlan.duration_days,
          plan_audience: selectedPlan.audience || 'standard',
          price_usd: selectedPlan.price_usd,
          method_id: methodUuid,
          method_name: selectedMethod.name,
          ref_code: refCode,
          payer_name: payerName.trim() || user?.email || 'عميل المتجر',
          status: 'pending',
          equivalents_snapshot: selectedPlan.equivalents || [],
        })
        .select('id')
        .single();

      let requestId = (insertData as unknown as { id?: string } | null)?.id;
      if (insertError) {
        // يوجد طلب مفتوح للمستخدم مسبقاً (فهرس idx_one_open_sub_request_per_user):
        // نعيد استخدامه ونرسل الإيصال الجديد بدل إظهار خطأ تقني
        if (insertError.code === '23505' && user?.id) {
          const { data: existing } = await supabase
            .from('subscription_requests')
            .select('id, ref_code')
            .eq('user_id', user.id)
            .in('status', ['pending', 'paid_claimed'])
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (existing && existing.ref_code) {
            refCode = existing.ref_code;
            requestId = existing.id;
          } else {
            throw insertError;
          }
        } else {
          throw insertError;
        }
      }

      if (!requestId) throw new Error('لم يتم العثور على معرّف طلب التجديد');

      // إرسال صورة إثبات التحويل إلى محادثة الدعم
      // الاستدعاء يرجع {error} ولا يرمي استثناء، لذلك نفحصه صراحةً ونُعلم العميل إذا فشل الإرسال
      let proofSent = false;
      try {
        const { error: proofError } = await supabase.rpc('send_support_message', {
          _message: `[IMAGE]${proofImage}[/IMAGE]\nإشعار تحويل - مرجع ${refCode} - طلب ${requestId} - ${selectedPlan.name} - ${selectedMethod.name}`,
          _conversation_id: null,
        });
        if (proofError) throw proofError;
        proofSent = true;
      } catch (e) {
        console.warn('proof send failed', e);
      }
      if (proofSent) {
        setProofImage(null);
      } else {
        showToast.error('تم تسجيل الطلب لكن تعذر إرسال صورة الإيصال، أرسلها من محادثة الدعم الفني');
      }

      // إرسال إشعار تليجرام فوري للمدير العام كإشعار احتياطي
      sendBossTelegramChatAlert(
        payerName.trim() || user?.email || 'عميل المتجر',
        user?.phone || '',
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

      if (proofSent) showToast.success('تم تسجيل الطلب وإرسال إشعار التحويل للدعم الفني');
      loadData();
    } catch (e: unknown) {
      const msg = typeof e === 'object' && e !== null && 'message' in e && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : '';
      showToast.error(msg || 'فشل إرسال الطلب، يرجى التواصل مع الدعم الفني مباشرة');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-3 sm:p-4 md:p-6 space-y-4 md:space-y-6 font-sans" dir={direction}>
      <PageHeader
        title="تجديد وترقية الاشتراك"
        subtitle="اختر باقة الاشتراك وطريقة الدفع المفضلة لمتجرك وسعة منتجاتك"
        icon={<Sparkles className="w-5 h-5" />}
        actions={
          <Button variant="outline" onClick={() => navigate(-1)} className="gap-2">
            <ArrowLeft className="w-4 h-4 rtl:rotate-180" /> العودة
          </Button>
        }
      />

      {/* في حال وجود طلب قيد المراجعة */}
      {activeRequest && (
        <Card className="border-warning/30 bg-warning/10">
          <CardContent className="pt-6">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div>
                <Badge variant="outline" className="bg-warning/15 text-warning border-warning/30">
                  طلبك قيد المراجعة: <span dir="ltr" className="inline-block tabular-nums">{activeRequest.ref_code}</span>
                </Badge>
                <h3 className="text-sm sm:text-base font-semibold text-foreground mt-2">{activeRequest.plan_name} — <span dir="ltr" className="inline-block tabular-nums">${activeRequest.price_usd}</span></h3>
                <p className="text-sm text-muted-foreground">
                  طريقة التحويل: {activeRequest.method_name} | رقم المرجع: <span dir="ltr" className="inline-block tabular-nums">{activeRequest.ref_code}</span>
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
      <div className="space-y-4">
        <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight">1. اختر الباقة المناسبة</h2>
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
                    <span dir="ltr" className="inline-block tabular-nums text-2xl font-bold">${p.price_usd}</span>
                    <span className="text-xs text-muted-foreground ms-1">/ {p.duration_days} يوماً</span>
                  </div>
                  {Array.isArray(p.equivalents) && p.equivalents.map((eq: { text?: string }, idx: number) => (
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
                        <Check className="w-3.5 h-3.5 text-success shrink-0" />
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
          <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight">2. اختر طريقة التحويل</h2>

          {methods.length === 0 && (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              لا توجد طرق دفع متاحة حالياً، يرجى التواصل مع الدعم الفني.
            </div>
          )}
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
                    {m.badge && <Badge variant="secondary">{m.badge}</Badge>}
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
                                isCodeCopied ? 'bg-success hover:bg-success/90 text-success-foreground' : ''
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
                            className="w-full gap-2 bg-success hover:bg-success/90 text-success-foreground font-bold h-11 text-sm shadow-xs"
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

                      <div className="sm:col-span-3 space-y-2">
                        <Label className="text-xs font-bold">صورة أو PDF لإشعار التحويل (إلزامي)</Label>
                        <Input type="file" accept="image/*,application/pdf" onChange={handleProofPick} className="h-11 pt-2" />
                        {proofLoading && <p className="text-[11px] text-muted-foreground">جاري تجهيز الصورة...</p>}
                        {proofImage && proofImage.startsWith('data:application/pdf') && <p className="text-xs font-bold">📄 ملف PDF جاهز للإرسال</p>}
                        {proofImage && !proofImage.startsWith('data:application/pdf') && <img src={proofImage} alt="إشعار التحويل" className="max-h-40 rounded-lg border" />}
                      </div>

                      <Button
                        onClick={handleClaimPayment}
                        disabled={submitting || proofLoading || !proofImage}
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
        <DialogContent className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]" dir={direction}>
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 className="w-6 h-6 shrink-0" />
              <DialogTitle>تم تسجيل طلب التجديد بنجاح!</DialogTitle>
            </div>
          </DialogHeader>

          <DialogBody className="space-y-4 text-sm">
            <div className="p-4 rounded-2xl bg-muted/60 border text-center space-y-1.5">
              <span className="text-xs text-muted-foreground block">رقم مرجع الطلب الرسمي:</span>
              <div className="flex items-center justify-center gap-2">
                <span dir="ltr" className="inline-block tabular-nums font-mono text-2xl font-bold text-primary tracking-wider">
                  {successDialog.refCode}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="نسخ رقم المرجع"
                  onClick={() => handleCopy(successDialog.refCode, 'رقم المرجع')}
                >
                  <Copy className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                احتفظ بهذا الرقم أو أرسله مباشرة عبر واتساب / تليجرام مع صورة الإيصال.
              </p>
            </div>

            <div className="space-y-2">
              <span className="font-bold text-xs block text-foreground">قنوات إرسال إشعار التحويل للدعم:</span>
              <div className="grid grid-cols-1 gap-2">
                {successDialog.whatsappUrl && (
                  <Button
                    onClick={() => window.open(successDialog.whatsappUrl, '_blank')}
                    className="gap-2 bg-success hover:bg-success/90 text-success-foreground font-bold h-11 justify-center"
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
                    <Send className="w-4 h-4 text-info" />
                    محادثة تليجرام
                  </Button>
                )}
              </div>
            </div>
          </DialogBody>

          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" className="w-full" onClick={() => setSuccessDialog(prev => ({ ...prev, open: false }))}>
              تم، العودة للشاشة
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
