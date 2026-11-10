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
import { Plus, Edit2, Trash2, QrCode, ExternalLink, RefreshCw, CreditCard, MessageSquare, PhoneCall } from 'lucide-react';
import { showToast } from '@/lib/toast';

export interface PaymentMethodItem {
  id: string;
  name: string;
  button_label?: string;
  link_url?: string;
  qr_image_url?: string;
  badge?: string;
  instructions?: string;
  enabled: boolean;
  sort_order: number;
}

interface BossPaymentMethodsManagerProps {
  onOpenContactLinks?: () => void;
  contactLinks?: {
    phone?: string;
    whatsapp?: string;
    telegram?: string;
    facebook?: string;
    email?: string;
  };
}

export function BossPaymentMethodsManager({ onOpenContactLinks, contactLinks }: BossPaymentMethodsManagerProps) {
  const [methods, setMethods] = useState<PaymentMethodItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMethod, setEditingMethod] = useState<PaymentMethodItem | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    button_label: 'فتح الرابط المباشر',
    link_url: '',
    qr_image_url: '',
    badge: '',
    instructions: '',
    enabled: true,
  });

  const loadMethods = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('payment_methods' as any)
        .select('*')
        .order('sort_order', { ascending: true });

      if (error) throw error;
      setMethods((data as any) || []);
    } catch (err: any) {
      showToast.error('فشل تحميل طرق الدفع: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMethods();
  }, []);

  const handleOpenAdd = () => {
    setEditingMethod(null);
    setFormData({
      name: '',
      button_label: 'فتح رابط الدفع المباشر',
      link_url: '',
      qr_image_url: '',
      badge: 'فوري ⚡',
      instructions: 'قم بالتحويل عبر الرابط أو الباركود ثم اضغط على زر إرسال الإشعار للدعم الفني.',
      enabled: true,
    });
    setDialogOpen(true);
  };

  const handleOpenEdit = (m: PaymentMethodItem) => {
    setEditingMethod(m);
    setFormData({
      name: m.name,
      button_label: m.button_label || 'فتح الرابط المباشر',
      link_url: m.link_url || '',
      qr_image_url: m.qr_image_url || '',
      badge: m.badge || '',
      instructions: m.instructions || '',
      enabled: m.enabled,
    });
    setDialogOpen(true);
  };

  const handleSaveMethod = async () => {
    if (!formData.name.trim()) {
      showToast.error('يرجى كتابة اسم طريقة الدفع');
      return;
    }

    const payload = {
      name: formData.name.trim(),
      button_label: formData.button_label.trim() || 'فتح الرابط المباشر',
      link_url: formData.link_url.trim() || null,
      qr_image_url: formData.qr_image_url.trim() || null,
      badge: formData.badge.trim() || null,
      instructions: formData.instructions.trim() || null,
      enabled: formData.enabled,
      updated_at: new Date().toISOString(),
    };

    try {
      if (editingMethod) {
        const { error } = await supabase
          .from('payment_methods' as any)
          .update(payload)
          .eq('id', editingMethod.id);
        if (error) throw error;
        showToast.success('تم تحديث طريقة الدفع بنجاح');
      } else {
        const { error } = await supabase
          .from('payment_methods' as any)
          .insert({
            ...payload,
            sort_order: methods.length + 1,
          });
        if (error) throw error;
        showToast.success('تمت إضافة طريقة الدفع الجديدة');
      }

      setDialogOpen(false);
      loadMethods();
    } catch (err: any) {
      showToast.error(err.message || 'حدث خطأ أثناء الحفظ');
    }
  };

  const handleDeleteMethod = async (id: string, name: string) => {
    if (!confirm(`هل أنت متأكد من حذف طريقة الدفع "${name}"؟`)) return;
    try {
      const { error } = await supabase
        .from('payment_methods' as any)
        .delete()
        .eq('id', id);
      if (error) throw error;
      showToast.success('تم حذف طريقة الدفع');
      loadMethods();
    } catch (err: any) {
      showToast.error('فشل الحذف: ' + err.message);
    }
  };

  return (
    <div className="space-y-4">
      {/* قسم قنوات التواصل والدعم الفني المباشرة */}
      <Card className="p-4 bg-muted/40 border-primary/20 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <PhoneCall className="w-4 h-4 text-primary" />
            <span className="font-bold text-sm">قنوات التواصل والدعم الفني للمطور</span>
            <Badge variant="outline" className="text-[11px] bg-background">نشطة دائماً</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            تستقبل إشعارات التحويل وطلبات التجديد مباشرة عبر واتساب وتليجرام والهاتف.
          </p>
          {contactLinks && (
            <div className="flex flex-wrap items-center gap-3 pt-1 text-xs font-mono text-muted-foreground">
              {contactLinks.whatsapp && <span>واتساب: <strong className="text-foreground">{contactLinks.whatsapp}</strong></span>}
              {contactLinks.telegram && <span>تليجرام: <strong className="text-foreground">{contactLinks.telegram}</strong></span>}
              {contactLinks.phone && <span>هاتف: <strong className="text-foreground">{contactLinks.phone}</strong></span>}
            </div>
          )}
        </div>
        {onOpenContactLinks && (
          <Button size="sm" variant="default" onClick={onOpenContactLinks} className="gap-1.5 shrink-0 bg-primary">
            <MessageSquare className="w-4 h-4" />
            تعديل أرقام وقنوات التواصل
          </Button>
        )}
      </Card>

      {/* رأس إدارة طرق الدفع */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <CreditCard className="w-5 h-5 text-primary" />
            إدارة أزرار وطرق الدفع والباركود
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            إضافة أزرار وروابط الدفع وصور الـ QR والباركود للعملاء دون طلب حسابات معقدة.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={loadMethods} className="gap-1.5">
            <RefreshCw className="w-3.5 h-3.5" />
            تحديث
          </Button>
          <Button size="sm" onClick={handleOpenAdd} className="gap-1.5 bg-primary text-primary-foreground">
            <Plus className="w-4 h-4" />
            إضافة طريقة دفع
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="p-8 text-center text-muted-foreground text-sm">جاري التحميل...</div>
      ) : methods.length === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          لا توجد طرق دفع مضافة. انقر على «إضافة طريقة دفع» للبدء.
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {methods.map((method) => (
            <Card key={method.id} className="p-4 border flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-base">{method.name}</span>
                    {method.badge && <Badge variant="secondary" className="text-[11px]">{method.badge}</Badge>}
                  </div>
                  <Badge variant={method.enabled ? 'default' : 'outline'}>
                    {method.enabled ? 'مفعّلة' : 'معطلة'}
                  </Badge>
                </div>

                {method.instructions && (
                  <p className="text-xs text-muted-foreground mb-3 line-clamp-2">
                    {method.instructions}
                  </p>
                )}

                <div className="space-y-1 text-xs border-t pt-2 mb-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">نص الزر:</span>
                    <span>{method.button_label || 'فتح الرابط المباشر'}</span>
                  </div>
                  {method.link_url && (
                    <div className="flex items-center gap-1.5 text-primary truncate">
                      <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate" dir="ltr">{method.link_url}</span>
                    </div>
                  )}
                  {method.qr_image_url && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <QrCode className="w-3.5 h-3.5 shrink-0 text-emerald-600" />
                      <span className="truncate">يحتوي على باركود / QR: {method.qr_image_url.substring(0, 24)}...</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 border-t pt-3">
                <Button size="sm" variant="outline" onClick={() => handleOpenEdit(method)} className="gap-1 h-8">
                  <Edit2 className="w-3.5 h-3.5" />
                  تعديل
                </Button>
                <Button size="sm" variant="ghost" className="text-destructive h-8 px-2" onClick={() => handleDeleteMethod(method.id, method.name)}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* حوار إضافة / تعديل طريقة دفع */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle>{editingMethod ? 'تعديل طريقة الدفع' : 'إضافة طريقة دفع جديدة'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3.5 text-sm py-2">
            <div className="space-y-1.5">
              <Label>اسم الطريقة</Label>
              <Input value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })} placeholder="مثال: شام كاش، USDT TRC20، الهرم" />
            </div>

            <div className="space-y-1.5">
              <Label>نص الزر التفاعلي</Label>
              <Input value={formData.button_label} onChange={e => setFormData({ ...formData, button_label: e.target.value })} placeholder="مثال: فتح محفظة شام كاش أو فتح رابط الدفع" />
            </div>

            <div className="space-y-1.5">
              <Label>رابط الدفع المباشر (اختياري)</Label>
              <Input value={formData.link_url} onChange={e => setFormData({ ...formData, link_url: e.target.value })} placeholder="https://..." dir="ltr" />
            </div>

            <div className="space-y-1.5">
              <Label>رابط أو كود صورة الـ QR / الباركود (اختياري)</Label>
              <Input value={formData.qr_image_url} onChange={e => setFormData({ ...formData, qr_image_url: e.target.value })} placeholder="رابط الصورة أو عنوان المحفظة" dir="ltr" />
            </div>

            <div className="space-y-1.5">
              <Label>شارة تمييز الزر (اختياري)</Label>
              <Input value={formData.badge} onChange={e => setFormData({ ...formData, badge: e.target.value })} placeholder="مثال: فوري ⚡ أو بدون عمولة" />
            </div>

            <div className="space-y-1.5">
              <Label>تعليمات الدفع المختصرة للعميل</Label>
              <Textarea rows={2} value={formData.instructions} onChange={e => setFormData({ ...formData, instructions: e.target.value })} placeholder="مثال: بعد التحويل، اضغط الزر أدناه لإرسال صورة الإيصال مباشرة للدعم الفني." />
            </div>

            <div className="flex items-center justify-between border rounded-xl p-3">
              <Label className="cursor-pointer">حالة التفعيل للعملاء</Label>
              <Switch checked={formData.enabled} onCheckedChange={v => setFormData({ ...formData, enabled: v })} />
            </div>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>إلغاء</Button>
            <Button onClick={handleSaveMethod}>حفظ الطريقة</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
