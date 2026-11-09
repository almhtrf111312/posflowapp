import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Check, Copy, ExternalLink, ShieldCheck, ArrowRight, MessageSquareQuote, Sparkles } from 'lucide-react';
import { showToast } from '@/lib/toast';

const DEFAULT_PLANS = [
  {
    id: 'plan_standard',
    name: 'الباقة القياسية (Standard)',
    price_usd: 25,
    duration_days: 180,
    max_products: 600,
    badge: 'اقتصادية',
    features: ['سعة حتى 600 منتج مع الصور', 'إدارة فواتير غير محدودة', 'إدارة الديون والصندوق والتقارير', 'طباعة فواتير حرارية وسحابية'],
    equivalents: [{ text: 'معادل العملات حسب سعر الصرف اليومي' }]
  },
  {
    id: 'plan_pro',
    name: 'الباقة الاحترافية (Pro)',
    price_usd: 45,
    duration_days: 365,
    max_products: 1000,
    badge: 'الأكثر طلباً ⭐',
    features: ['سعة حتى 1000 منتج (فوق 600 بدون صور)', 'كافة ميزات الباقة القياسية', 'نسخ احتياطي سحابي تلقائي', 'دعم فني سريع وأولوية بالتحديثات'],
    equivalents: [{ text: 'معادل العملات حسب سعر الصرف اليومي' }]
  },
  {
    id: 'plan_institution',
    name: 'باقة المؤسسات (Institution)',
    price_usd: 80,
    duration_days: 365,
    max_products: 5000,
    badge: 'غير محدودة',
    features: ['سعة ضخمة حتى 5000 منتج بصور كاملة', 'تزامن عالي السرعة بين الفروع والأجهزة', 'دعم فني VIP مخصص على مدار الساعة', 'أعلى أداء لقواعد البيانات الكبيرة'],
    equivalents: [{ text: 'معادل العملات حسب سعر الصرف اليومي' }]
  }
];

const DEFAULT_METHODS = [
  {
    id: 'method_sham',
    name: 'حوالة شام كاش / محفظة إلكترونية',
    holder_name: 'إدارة هايبر بوس',
    account_number: 'SHAM-7729104',
    instructions: 'يرجى تحويل المبلغ وتصوير الإشعار أو كتابة رقم العملية المرجعية في الحقل أدناه ليتم التفعيل مباشرة.'
  },
  {
    id: 'method_usdt',
    name: 'USDT (TRC20)',
    holder_name: 'HyperPOS Crypto Wallet',
    account_number: 'TXyZ8829KmnPQ11234flowposproTRC20',
    instructions: 'قم بتحويل المبلغ بالدولار الرقمي عبر شبكة Tron (TRC20)، ثم الصق معرف المعاملة (TxID) في رقم العملية أدناه.'
  },
  {
    id: 'method_direct',
    name: 'حوالة هرم / فؤاد / كاش',
    holder_name: 'قسم المبيعات والاشتراكات',
    account_number: 'دمشق - سوريا (أو التواصل المباشر)',
    instructions: 'أرسل الحوالة بالاسم المعتمد ثم سجل رقم الحوالة هنا أو تواصل معنا لتزويدك بأقرب وكيل دفع معتمد.'
  }
];

export default function RenewPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [plans, setPlans] = useState<any[]>(DEFAULT_PLANS);
  const [methods, setMethods] = useState<any[]>(DEFAULT_METHODS);
  const [selectedPlan, setSelectedPlan] = useState<any>(DEFAULT_PLANS[1]);
  const [selectedMethod, setSelectedMethod] = useState<any>(DEFAULT_METHODS[0]);
  const [payerName, setPayerName] = useState('');
  const [payerRef, setPayerRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeRequest, setActiveRequest] = useState<any>(null);

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

      if (!methodsErr && methodsData && methodsData.length > 0) {
        setMethods(methodsData);
        setSelectedMethod(methodsData[0]);
      }

      // 3. التحقق من وجود طلب مفتوح
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

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    showToast.success(`تم نسخ ${label}`);
  };

  const handleClaimPayment = async () => {
    if (!selectedPlan || !selectedMethod) return;
    if (!payerRef.trim()) {
      showToast.error('يرجى كتابة رقم العملية أو رقم الحوالة');
      return;
    }
    setSubmitting(true);
    try {
      let requestId: string | null = null;

      // محاولة استدعاء دالة الخادم الذرية
      const { data, error: rpcError } = await supabase.rpc('create_subscription_request', {
        p_plan_id: selectedPlan.id,
        p_method_id: selectedMethod.id,
      });

      if (!rpcError && data) {
        requestId = (data as any)?.request_id || (data as any);
      } else {
        // احتياطي في حال عدم توفر الـ RPC: إنشاء الطلب مباشرة في الجدول
        const refCode = `REQ-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
        const { data: insertData, error: insertError } = await supabase
          .from('subscription_requests')
          .insert({
            user_id: user?.id,
            plan_id: selectedPlan.id,
            plan_name: selectedPlan.name,
            price_usd: selectedPlan.price_usd,
            method_id: selectedMethod.id,
            method_name: selectedMethod.name,
            ref_code: refCode,
            payer_name: payerName.trim(),
            payer_ref: payerRef.trim(),
            status: 'paid_claimed',
          })
          .select('id')
          .single();

        if (insertError) throw insertError;
        requestId = insertData?.id;
      }

      // إذا تم الحصول على معرف الطلب من RPC، قم بتحديث بيانات الحوالة
      if (requestId && !payerRef.trim()) {
        await supabase
          .from('subscription_requests')
          .update({
            payer_name: payerName.trim(),
            payer_ref: payerRef.trim(),
            status: 'paid_claimed',
          })
          .eq('id', requestId);
      }

      showToast.success('تم إرسال طلب التجديد بنجاح، بانتظار التأكيد من الإدارة');
      loadData();
    } catch (e: any) {
      showToast.error(e.message || 'فشل إرسال الطلب، يرجى المحاولة لاحقاً أو التواصل مع الدعم');
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
          <p className="text-muted-foreground text-sm mt-1">اختر باقة الاشتراك وطريقة الدفع المناسبة لمتجرك وسعة منتجاتك</p>
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
                  طريقة التحويل: {activeRequest.method_name} | رقم العملية: {activeRequest.payer_ref || 'غير مسجل'}
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
                  {/* المعادل المكتوب بالعملات */}
                  {Array.isArray(p.equivalents) && p.equivalents.map((eq: any, idx: number) => (
                    <div key={idx} className="text-xs text-muted-foreground font-medium mt-1">
                      {eq.text}
                    </div>
                  ))}
                </CardHeader>
                <CardContent className="text-xs space-y-2 pt-2 border-t">
                  <div className="text-foreground font-semibold">سعة المنتجات: {p.max_products} منتج</div>
                  {p.features?.map((f: string, i: number) => (
                    <div key={i} className="flex items-center gap-1.5 text-muted-foreground">
                      <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span>{f}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* 2. طرق الدفع والتحويل */}
      {selectedPlan && (
        <div className="space-y-6">
          <h2 className="text-lg font-semibold">2. اختر طريقة التحويل والدفع</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {methods.map((m) => {
              const isSelected = selectedMethod?.id === m.id;
              return (
                <Button
                  key={m.id}
                  variant={isSelected ? 'default' : 'outline'}
                  onClick={() => setSelectedMethod(m)}
                  className="h-auto py-3 px-4 flex flex-col gap-1 items-center justify-center text-center whitespace-normal"
                >
                  <span className="font-semibold">{m.name}</span>
                </Button>
              );
            })}
          </div>

          {/* تفاصيل طريقة الدفع المحددة */}
          {selectedMethod && (
            <Card className="bg-card border-border">
              <CardContent className="pt-6 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* بيانات الحساب والنسخ */}
                  <div className="space-y-3">
                    <div className="text-sm font-semibold text-primary">تفاصيل الحساب للتحويل:</div>
                    {selectedMethod.holder_name && (
                      <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted">
                        <span className="text-xs text-muted-foreground">اسم المستلم:</span>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm">{selectedMethod.holder_name}</span>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleCopy(selectedMethod.holder_name, 'اسم المستلم')}>
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    )}

                    {selectedMethod.account_number && (
                      <div className="flex items-center justify-between p-2.5 rounded-lg bg-muted">
                        <span className="text-xs text-muted-foreground">رقم الحساب / المحفظة:</span>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-bold text-sm">{selectedMethod.account_number}</span>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleCopy(selectedMethod.account_number, 'رقم الحساب')}>
                            <Copy className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    )}

                    {selectedMethod.instructions && (
                      <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
                        {selectedMethod.instructions}
                      </p>
                    )}
                  </div>

                  {/* صورة الباركود إن وجدت */}
                  {selectedMethod.qr_image_path && (
                    <div className="flex flex-col items-center justify-center p-4 border rounded-xl bg-background">
                      <img src={selectedMethod.qr_image_path} alt="QR Code" className="w-40 h-40 object-contain rounded-lg" />
                      <span className="text-xs text-muted-foreground mt-2">امسح الباركود مباشرة من تطبيق محفظتك</span>
                    </div>
                  )}
                </div>

                {/* نموذج تأكيد التحويل */}
                <div className="pt-4 border-t space-y-3">
                  <div className="text-sm font-semibold">تأكيد عملية التحويل:</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <Input
                      placeholder="اسم المحوّل أو رقم هاتفه (اختياري)"
                      value={payerName}
                      onChange={(e) => setPayerName(e.target.value)}
                    />
                    <Input
                      placeholder="رقم العملية / رقم الإشعار (مطلوب)"
                      value={payerRef}
                      onChange={(e) => setPayerRef(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
                    <Button variant="outline" onClick={() => navigate('/contact')} className="gap-2 w-full sm:w-auto">
                      <MessageSquareQuote className="w-4 h-4" /> طريقة أخرى (تواصل مع الدعم)
                    </Button>
                    <Button onClick={handleClaimPayment} disabled={submitting} className="gap-2 px-6 w-full sm:w-auto">
                      <ShieldCheck className="w-4 h-4" /> تم التحويل، إرسال الطلب
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
