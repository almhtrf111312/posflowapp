// =========================================================================
// المكون البرمجي: كبسولة إدارة الباقات والتراخيص داخل لوحة المدير العام
// =========================================================================
import React, { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Plus, Edit2, Trash2, Layers, RefreshCw, Eye, EyeOff } from 'lucide-react';
import { showToast } from '@/lib/toast';

export interface PlanItem {
  id: string;
  name: string;
  audience: string;
  duration_days: number;
  price_usd: number;
  max_products: number;
  max_cashiers: number;
  badge?: string;
  features: string[];
  activation_message?: string;
  allow_images_above_limit: boolean;
  enabled: boolean;
  sort_order: number;
}

export function BossPlansManager() {
  const [plans, setPlans] = useState<PlanItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<PlanItem | null>(null);

  // حقول نموذج الباقة
  const [formData, setFormData] = useState({
    name: '',
    audience: 'standard',
    duration_days: 180,
    price_usd: 25,
    max_products: 600,
    max_cashiers: 1,
    badge: '',
    featuresText: '',
    activation_message: '',
    allow_images_above_limit: false,
    enabled: true,
  });

  const loadPlans = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('subscription_plans' as any)
        .select('*')
        .order('sort_order', { ascending: true });

      if (error) throw error;
      setPlans((data as any) || []);
    } catch (err: any) {
      showToast.error('فشل تحميل الباقات: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadPlans();
  }, []);

  const handleOpenAdd = () => {
    setEditingPlan(null);
    setFormData({
      name: '',
      audience: 'standard',
      duration_days: 180,
      price_usd: 25,
      max_products: 600,
      max_cashiers: 1,
      badge: 'جديد',
      featuresText: 'سعة 600 منتج\nطباعة فواتير حرارية وسحابية\nنسخ احتياطي يومي',
      activation_message: 'تم تفعيل باقتك بنجاح! نتمنى لك تجارة رابحة.',
      allow_images_above_limit: false,
      enabled: true,
    });
    setDialogOpen(true);
  };

  const handleOpenEdit = (plan: PlanItem) => {
    setEditingPlan(plan);
    setFormData({
      name: plan.name,
      audience: plan.audience || 'standard',
      duration_days: plan.duration_days,
      price_usd: Number(plan.price_usd),
      max_products: plan.max_products,
      max_cashiers: plan.max_cashiers || 1,
      badge: plan.badge || '',
      featuresText: (plan.features || []).join('\n'),
      activation_message: plan.activation_message || '',
      allow_images_above_limit: plan.allow_images_above_limit,
      enabled: plan.enabled,
    });
    setDialogOpen(true);
  };

  const handleSavePlan = async () => {
    if (!formData.name.trim()) {
      showToast.error('يرجى كتابة اسم الباقة');
      return;
    }

    const payload = {
      name: formData.name.trim(),
      audience: formData.audience,
      duration_days: Number(formData.duration_days),
      price_usd: Number(formData.price_usd),
      max_products: Number(formData.max_products),
      max_cashiers: Number(formData.max_cashiers),
      badge: formData.badge.trim() || null,
      features: formData.featuresText.split('\n').map(f => f.trim()).filter(Boolean),
      activation_message: formData.activation_message.trim() || null,
      allow_images_above_limit: formData.allow_images_above_limit,
      enabled: formData.enabled,
      updated_at: new Date().toISOString(),
    };

    try {
      if (editingPlan) {
        const { error } = await supabase
          .from('subscription_plans' as any)
          .update(payload)
          .eq('id', editingPlan.id);
        if (error) throw error;
        showToast.success('تم تحديث الباقة بنجاح');
      } else {
        const { error } = await supabase
          .from('subscription_plans' as any)
          .insert({
            ...payload,
            sort_order: plans.length + 1,
          });
        if (error) throw error;
        showToast.success('تمت إضافة الباقة الجديدة بنجاح');
      }

      setDialogOpen(false);
      loadPlans();
    } catch (err: any) {
      showToast.error(err.message || 'حدث خطأ أثناء الحفظ');
    }
  };

  const handleToggleVisibility = async (plan: PlanItem) => {
    const nextState = !plan.enabled;
    try {
      const { error } = await supabase
        .from('subscription_plans' as any)
        .update({ enabled: nextState, updated_at: new Date().toISOString() })
        .eq('id', plan.id);
      if (error) throw error;
      showToast.success(
        nextState 
          ? `تم إظهار باقة "${plan.name}" للعملاء في شاشة التجديد` 
          : `تم إخفاء باقة "${plan.name}" عن العملاء (متاحة للتفعيل المباشر فقط)`
      );
      setPlans(prev => prev.map(p => p.id === plan.id ? { ...p, enabled: nextState } : p));
    } catch (err: any) {
      showToast.error('فشل تحديث حالة الباقة: ' + err.message);
    }
  };

  const handleDeletePlan = async (id: string, name: string) => {
    if (!confirm(`هل أنت متأكد من حذف الباقة "${name}"؟`)) return;
    try {
      const { error } = await supabase
        .from('subscription_plans' as any)
        .delete()
        .eq('id', id);
      if (error) throw error;
      showToast.success('تم حذف الباقة');
      loadPlans();
    } catch (err: any) {
      showToast.error('فشل حذف الباقة: ' + err.message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Layers className="w-5 h-5 text-primary" />
            إدارة باقات التراخيص والأسعار
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            تحديد الأسعار بالدولار، مدة التفعيل بالأيام، حد المنتجات والكاشيرات، ورسائل التفعيل المخصصة.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={loadPlans} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" />
            تحديث
          </Button>
          <Button size="sm" onClick={handleOpenAdd} className="gap-1.5 bg-primary text-primary-foreground">
            <Plus className="w-4 h-4" />
            إضافة باقة جديدة
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-muted-foreground text-sm">جاري جلب الباقات...</div>
      ) : plans.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          لا توجد باقات حالياً. انقر على «إضافة باقة جديدة» لإنشاء أول باقة.
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {plans.map((plan) => (
            <Card key={plan.id} className="p-4 border relative flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-base">{plan.name}</span>
                    {plan.badge && <Badge variant="secondary" className="text-[11px]">{plan.badge}</Badge>}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggleVisibility(plan)}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold transition-all cursor-pointer shadow-xs ${
                      plan.enabled 
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/25' 
                        : 'bg-muted text-muted-foreground border border-border hover:bg-muted/80'
                    }`}
                    title={plan.enabled ? 'الباقة مرئية للعملاء في شاشة التجديد (انقر للإخفاء)' : 'الباقة مخفية عن العملاء (انقر للإظهار)'}
                  >
                    {plan.enabled ? (
                      <>
                        <Eye className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                        <span>مرئية للعملاء</span>
                      </>
                    ) : (
                      <>
                        <EyeOff className="w-3.5 h-3.5 text-muted-foreground" />
                        <span>مخفية (خاصة)</span>
                      </>
                    )}
                  </button>
                </div>

                {!plan.enabled && (
                  <div className="mb-2 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 text-[11px] font-medium flex items-center gap-1.5">
                    <span>🔒</span>
                    <span>عرض داخلي مخفي عن العملاء (متاح للتفعيل المباشر فقط)</span>
                  </div>
                )}

                <div className="text-2xl font-black text-primary font-mono mb-3">
                  ${plan.price_usd} <span className="text-xs font-normal text-muted-foreground">/ {plan.duration_days} يوماً</span>
                </div>

                <div className="space-y-1.5 text-xs text-muted-foreground border-t pt-3 mb-3">
                  <div>📦 الحد الأقصى للمنتجات: <strong className="text-foreground">{plan.max_products} منتج</strong></div>
                  <div>👥 عدد الكاشيرات المسموح: <strong className="text-foreground">{plan.max_cashiers || 1} كاشير</strong></div>
                  {plan.activation_message && (
                    <div className="mt-2 p-2 rounded-lg bg-muted/60 text-[11px]">
                      ✉️ <strong>رسالة التفعيل:</strong> {plan.activation_message}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t pt-3">
                <Button size="sm" variant="outline" onClick={() => handleOpenEdit(plan)} className="gap-1 h-8">
                  <Edit2 className="w-3.5 h-3.5" />
                  تعديل
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive h-8 px-2" onClick={() => handleDeletePlan(plan.id, plan.name)}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* حوار إضافة / تعديل باقة */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle>{editingPlan ? 'تعديل بيانات الباقة' : 'إضافة باقة اشتراك جديدة'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3.5 text-sm py-2">
            <div className="space-y-1.5">
              <Label>اسم الباقة</Label>
              <Input value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="مثال: الباقة الذهبية (12 شهر)" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>السعر بالدولار ($)</Label>
                <Input type="number" min="0" step="0.5" value={formData.price_usd} onChange={e => setFormData({ ...formData, price_usd: Number(e.target.value) })} />
              </div>
              <div className="space-y-1.5">
                <Label>المدة بالأيام</Label>
                <Input type="number" min="1" value={formData.duration_days} onChange={e => setFormData({ ...formData, duration_days: Number(e.target.value) })} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>أقصى عدد منتجات</Label>
                <Input type="number" min="10" value={formData.max_products} onChange={e => setFormData({ ...formData, max_products: Number(e.target.value) })} />
              </div>
              <div className="space-y-1.5">
                <Label>عدد الكاشيرات</Label>
                <Input type="number" min="1" value={formData.max_cashiers} onChange={e => setFormData({ ...formData, max_cashiers: Number(e.target.value) })} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>شارة تمييز الباقة (اختياري)</Label>
              <Input value={formData.badge} onChange={e => setFormData({ ...formData, badge: e.target.value })} placeholder="مثال: الأكثر طلباً ⭐ أو خصم 20%" />
            </div>

            <div className="space-y-1.5">
              <Label>ميزات الباقة (كل ميزة في سطر منفصل)</Label>
              <Textarea rows={3} value={formData.featuresText} onChange={e => setFormData({ ...formData, featuresText: e.target.value })} placeholder="ميزة 1&#10;ميزة 2&#10;ميزة 3" />
            </div>

            <div className="space-y-1.5">
              <Label>رسالة التفعيل المخصصة (تصل العميل عند التفعيل)</Label>
              <Textarea rows={2} value={formData.activation_message} onChange={e => setFormData({ ...formData, activation_message: e.target.value })} placeholder="تم تفعيل باقتك بنجاح! شكراً لاختيارك FlowPOS Pro." />
            </div>

            <div className="flex items-center justify-between border rounded-xl p-3">
              <Label className="cursor-pointer">حالة الباقة (تظهر في صفحة التجديد)</Label>
              <Switch checked={formData.enabled} onCheckedChange={v => setFormData({ ...formData, enabled: v })} />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>إلغاء</Button>
            <Button onClick={handleSavePlan}>حفظ الباقة</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
