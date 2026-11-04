import { useState, useEffect } from 'react';
import {
  Search,
  Plus,
  Phone,
  Mail,
  DollarSign,
  TrendingUp,
  Wallet,
  Eye,
  Edit,
  Trash2,
  ArrowDownLeft,
  ArrowUpRight,
  Save,
  UserCheck,
  Percent,
  Tag,
  Banknote,
  PiggyBank,
  Receipt,
  Loader2
} from 'lucide-react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { getEquivalentCurrencies } from '@/lib/currencies';
import { getCurrencyDef, getEnabledCurrencies, fromUsd, toUsd, roundForCurrency } from '@/lib/money-engine';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
// ✅ استخدام الدوال السحابية بدلاً من المحلية
import {
  loadPartnersCloud,
  addPartnerCloud,
  updatePartnerCloud,
  deletePartnerCloud,
  withdrawProfitCloud,
  withdrawCapitalCloud,
  addCapitalWithCashboxCloud,
  Partner,
} from '@/lib/cloud/partners-cloud';
import { ExpenseRecord } from '@/lib/partners-store';
import { EVENTS } from '@/lib/events';
import { cn, formatNumber, formatCurrency } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from '@/lib/sonner-bridge';
import { getCategoryNames } from '@/lib/categories-store';
import { CategoryManager } from '@/components/CategoryManager';
import { loadProducts } from '@/lib/products-store';
import { useLanguage } from '@/hooks/use-language';

interface CategoryShare {
  categoryId: string;
  categoryName: string;
  percentage: number;
  enabled: boolean;
}

export default function Partners() {
  const { t } = useLanguage();
  const [partners, setPartners] = useState<Partner[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCategoryManager, setShowCategoryManager] = useState(false);

  // Load categories from shared store
  const [categories, setCategories] = useState(() =>
    getCategoryNames().map((name, idx) => ({ id: `cat_${idx}`, label: name }))
  );

  // Get used categories from products
  const usedCategories = [...new Set(loadProducts().map(p => p.category))];

  // Reload categories from store
  const reloadCategories = () => {
    setCategories(getCategoryNames().map((name, idx) => ({ id: `cat_${idx}`, label: name })));
  };

  // ✅ تحميل الشركاء من Cloud
  const loadPartnersData = async () => {
    setIsLoading(true);
    try {
      const cloudPartners = await loadPartnersCloud();
      setPartners(cloudPartners);
    } catch (error) {
      console.error('Error loading partners:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // تحميل البيانات عند فتح الصفحة والاستماع للتحديثات
  useEffect(() => {
    loadPartnersData();

    const handleUpdate = () => loadPartnersData();
    window.addEventListener(EVENTS.PARTNERS_UPDATED, handleUpdate);

    return () => {
      window.removeEventListener(EVENTS.PARTNERS_UPDATED, handleUpdate);
    };
  }, []);

  // Dialogs
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showViewDialog, setShowViewDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showWithdrawDialog, setShowWithdrawDialog] = useState(false);
  const [showAddCapitalDialog, setShowAddCapitalDialog] = useState(false);
  const [selectedPartner, setSelectedPartner] = useState<Partner | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [viewCurrencyCode, setViewCurrencyCode] = useState<string>('USD');

  const convertForView = (usdAmount: number) => {
    if (viewCurrencyCode === 'USD') {
      return '$' + formatNumber(usdAmount);
    }
    const currDef = getCurrencyDef(viewCurrencyCode);
    const converted = fromUsd(usdAmount, viewCurrencyCode, currDef.rate);
    return formatNumber(converted) + ' ' + currDef.symbol;
  };

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    email: '',
    accessAll: true,
    sharesExpenses: false,
    expenseSharePercentage: 0,
    categoryShares: categories.map(c => ({
      categoryId: c.id,
      categoryName: c.label,
      percentage: 0,
      enabled: true,
    })),
  });
  const [withdrawAmount, setWithdrawAmount] = useState(0);
  const [withdrawType, setWithdrawType] = useState<'profit' | 'capital' | 'auto'>('auto');
  const [withdrawNotes, setWithdrawNotes] = useState('');
  const [withdrawCurrency, setWithdrawCurrency] = useState<string>('USD');
  const [capitalAmount, setCapitalAmount] = useState(0);
  const [capitalNotes, setCapitalNotes] = useState('');
  const [depositTarget, setDepositTarget] = useState<'capital' | 'balance'>('capital');
  const [depositCurrency, setDepositCurrency] = useState<string>('USD');

  // Update form when categories change
  useEffect(() => {
    setFormData(prev => ({
      ...prev,
      categoryShares: categories.map(c => {
        const existing = prev.categoryShares.find(cs => cs.categoryName === c.label);
        return existing || {
          categoryId: c.id,
          categoryName: c.label,
          percentage: 0,
          enabled: true,
        };
      }),
    }));
  }, [categories]);

  const filteredPartners = partners.filter(partner =>
    partner.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    partner.phone.includes(searchQuery)
  );

  const stats = {
    totalPartners: partners.length,
    totalShare: partners.reduce((sum, p) => sum + p.sharePercentage, 0),
    totalBalance: partners.reduce((sum, p) => sum + p.currentBalance, 0),
    totalProfit: partners.reduce((sum, p) => sum + p.totalProfitEarned, 0),
  };

  // تم استبدالها بدوال Cloud
  const refreshPartners = async () => {
    await loadPartnersData();
  };

  const resetForm = () => {
    setFormData({
      name: '',
      phone: '',
      email: '',
      accessAll: true,
      sharesExpenses: false,
      expenseSharePercentage: 0,
      categoryShares: categories.map(c => ({
        categoryId: c.id,
        categoryName: c.label,
        percentage: 0,
        enabled: true,
      })),
    });
  };

  const calculateMainShare = () => {
    if (formData.accessAll) {
      const firstEnabled = formData.categoryShares.find(c => c.enabled);
      return firstEnabled?.percentage || 0;
    }
    const enabledShares = formData.categoryShares.filter(c => c.enabled && c.percentage > 0);
    if (enabledShares.length === 0) return 0;
    return Math.max(...enabledShares.map(c => c.percentage));
  };

  const handleAddPartner = async () => {
    if (isSubmitting) return;

    const cleanName = formData.name.trim();
    if (!cleanName || !formData.phone) {
      toast.error(t('partners.fillRequiredFields'));
      return;
    }

    // 🔒 التحقق من عدم وجود الاسم محلياً وسحابياً لمنع التكرار
    const isDuplicate = partners.some(
      p => p.name.trim().toLowerCase() === cleanName.toLowerCase()
    );
    if (isDuplicate) {
      toast.error('يوجد شريك مسجل بهذا الاسم مسبقاً');
      return;
    }

    const mainShare = calculateMainShare();
    if (mainShare <= 0) {
      toast.error(t('partners.invalidSharePercentage'));
      return;
    }

    setIsSubmitting(true);
    try {
      // ✅ استخدام الدالة السحابية
      const newPartner = await addPartnerCloud({
        name: cleanName,
        phone: formData.phone.trim(),
        email: formData.email?.trim() || undefined,
        sharePercentage: mainShare,
        expenseSharePercentage: formData.expenseSharePercentage || 0,
        categoryShares: formData.categoryShares,
        accessAll: formData.accessAll,
        sharesExpenses: formData.sharesExpenses,
        joinedDate: new Date().toISOString().split('T')[0],
        totalProfitEarned: 0,
        totalWithdrawn: 0,
        totalExpensesPaid: 0,
        currentBalance: 0,
        initialCapital: 0,
        currentCapital: 0,
        confirmedProfit: 0,
        pendingProfit: 0,
      });

      if (newPartner) {
        await refreshPartners();
        setShowAddDialog(false);
        resetForm();
        toast.success(t('partners.partnerAdded'));
        import('@/lib/activity-log').then(({ logActivity }) => logActivity('partner_added', `إضافة شريك: ${newPartner.name}`, { id: newPartner.id }));
      } else {
        toast.error(t('partners.error'));
      }
    } catch (err) {
      console.error('Error adding partner:', err);
      toast.error(t('partners.error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEditPartner = async () => {
    if (isSubmitting) return;

    const cleanName = formData.name.trim();
    if (!selectedPartner || !cleanName) {
      toast.error(t('partners.fillRequiredFields'));
      return;
    }

    // 🔒 التحقق من عدم تكرار الاسم مع شريك آخر
    const isDuplicate = partners.some(
      p => p.id !== selectedPartner.id && p.name.trim().toLowerCase() === cleanName.toLowerCase()
    );
    if (isDuplicate) {
      toast.error('يوجد شريك مسجل بهذا الاسم مسبقاً');
      return;
    }

    const mainShare = calculateMainShare();

    setIsSubmitting(true);
    try {
      // ✅ استخدام الدالة السحابية
      const success = await updatePartnerCloud(selectedPartner.id, {
        name: cleanName,
        phone: formData.phone.trim(),
        email: formData.email?.trim() || undefined,
        sharePercentage: mainShare,
        expenseSharePercentage: formData.sharesExpenses ? Number(formData.expenseSharePercentage || 0) : 0,
        categoryShares: formData.categoryShares,
        accessAll: formData.accessAll,
        sharesExpenses: formData.sharesExpenses,
      });

      if (success) {
        const editedName = cleanName;
        const editedId = selectedPartner.id;
        await refreshPartners();
        setShowEditDialog(false);
        setSelectedPartner(null);
        toast.success(t('partners.partnerUpdated'));
        import('@/lib/activity-log').then(({ logActivity }) => logActivity('partner_updated', `تعديل شريك: ${editedName}`, { id: editedId }));
      } else {
        toast.error(t('partners.error'));
      }
    } catch (err) {
      console.error('Error updating partner:', err);
      toast.error(t('partners.error'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeletePartner = async () => {
    if (!selectedPartner) return;

    const deletedName = selectedPartner.name;
    const deletedId = selectedPartner.id;
    const success = await deletePartnerCloud(selectedPartner.id);

    if (success) {
      await refreshPartners();
      setShowDeleteDialog(false);
      setSelectedPartner(null);
      toast.success(t('partners.partnerDeleted'));
      import('@/lib/activity-log').then(({ logActivity }) => logActivity('partner_deleted', `حذف شريك: ${deletedName}`, { id: deletedId }));
    } else {
      toast.error(t('partners.error'));
    }
  };

  const handleWithdraw = async () => {
    if (isSubmitting) return;
    if (!selectedPartner || withdrawAmount <= 0) {
      toast.error(t('partners.enterValidAmount'));
      return;
    }

    const profitAvailableUsd = selectedPartner.currentBalance || 0;
    const capitalAvailableUsd = selectedPartner.currentCapital || 0;
    const totalAvailableUsd = profitAvailableUsd + capitalAvailableUsd;

    // تحويل المبلغ المدخل من العملة المختارة إلى الدولار للمقارنة المحاسبية
    const withdrawUsdAmount = Math.round(toUsd(withdrawAmount, withdrawCurrency) * 100) / 100;

    if (withdrawType === 'profit' && withdrawUsdAmount > profitAvailableUsd + 0.001) {
      toast.error(t('partners.amountExceedsProfit'));
      return;
    }
    if (withdrawType === 'capital' && withdrawUsdAmount > capitalAvailableUsd + 0.001) {
      toast.error(t('partners.amountExceedsCapital'));
      return;
    }
    if (withdrawType === 'auto' && withdrawUsdAmount > totalAvailableUsd + 0.001) {
      toast.error(t('partners.amountExceedsTotal'));
      return;
    }

    let success = false;
    let resultMessage = '';

    if (withdrawType === 'profit' || withdrawType === 'auto') {
      const profitToWithdrawUsd = Math.min(withdrawUsdAmount, profitAvailableUsd);
      const profitToWithdrawOrig = withdrawCurrency === 'USD' ? profitToWithdrawUsd : fromUsd(profitToWithdrawUsd, withdrawCurrency);

      if (profitToWithdrawUsd > 0) {
        success = await withdrawProfitCloud(
          selectedPartner.id,
          profitToWithdrawUsd,
          withdrawNotes,
          false,
          withdrawCurrency,
          profitToWithdrawOrig
        );
        resultMessage = `${t('partners.withdrawnFromProfit')} ${formatCurrency(profitToWithdrawUsd)}`;
        if (withdrawCurrency !== 'USD') {
          resultMessage += ` (${formatNumber(profitToWithdrawOrig)} ${withdrawCurrency})`;
        }
      } else {
        success = true;
      }

      if (withdrawType === 'auto' && withdrawUsdAmount > profitAvailableUsd) {
        const fromCapitalUsd = Math.round((withdrawUsdAmount - profitAvailableUsd) * 100) / 100;
        const fromCapitalOrig = withdrawCurrency === 'USD' ? fromCapitalUsd : fromUsd(fromCapitalUsd, withdrawCurrency);
        const capitalSuccess = await withdrawCapitalCloud(
          selectedPartner.id,
          fromCapitalUsd,
          withdrawNotes,
          withdrawCurrency,
          fromCapitalOrig
        );
        success = success && capitalSuccess;
        resultMessage += ` + ${formatCurrency(fromCapitalUsd)} ${t('partners.fromCapital')}`;
        if (withdrawCurrency !== 'USD') {
          resultMessage += ` (${formatNumber(fromCapitalOrig)} ${withdrawCurrency})`;
        }
      }
    } else if (withdrawType === 'capital') {
      const fromCapitalUsd = withdrawUsdAmount;
      const fromCapitalOrig = withdrawAmount;
      success = await withdrawCapitalCloud(
        selectedPartner.id,
        fromCapitalUsd,
        withdrawNotes,
        withdrawCurrency,
        fromCapitalOrig
      );
      resultMessage = `${t('partners.withdrawnFromCapital')} ${formatCurrency(fromCapitalUsd)}`;
      if (withdrawCurrency !== 'USD') {
        resultMessage += ` (${formatNumber(fromCapitalOrig)} ${withdrawCurrency})`;
      }
    }

    if (success) {
      await refreshPartners();
      setShowWithdrawDialog(false);
      setSelectedPartner(null);
      setWithdrawAmount(0);
      setWithdrawType('auto');
      setWithdrawNotes('');
      setWithdrawCurrency('USD');
      toast.success(resultMessage);
    } else {
      toast.error(t('partners.withdrawError'));
    }
  };

  const handleAddCapital = async () => {
    if (isSubmitting) return;
    if (!selectedPartner || capitalAmount <= 0) {
      toast.error(t('partners.enterValidAmount'));
      return;
    }

    // حساب المعادل الفوري بالدولار بدقة
    const depositUsdAmount = Math.round(toUsd(capitalAmount, depositCurrency) * 100) / 100;

    const success = await addCapitalWithCashboxCloud(
      selectedPartner.id,
      selectedPartner.name,
      depositUsdAmount,
      capitalNotes,
      depositTarget,
      depositCurrency,
      capitalAmount
    );

    if (success) {
      await refreshPartners();
      setShowAddCapitalDialog(false);
      setSelectedPartner(null);
      setCapitalAmount(0);
      setCapitalNotes('');
      setDepositTarget('capital');
      setDepositCurrency('USD');
      const actionName = depositTarget === 'balance' ? 'تم إيداع الرصيد' : t('partners.capitalAdded');
      const extraCurr = depositCurrency !== 'USD' ? ` (${formatNumber(capitalAmount)} ${depositCurrency})` : '';
      toast.success(`${actionName} ${formatCurrency(depositUsdAmount)}${extraCurr} (تم الربط مع الصندوق)`);
    } else {
      toast.error(t('partners.capitalAddError'));
    }
  };

  const openAddCapitalDialog = (partner: Partner) => {
    setSelectedPartner(partner);
    setCapitalAmount(0);
    setCapitalNotes('');
    setDepositTarget('capital');
    setDepositCurrency('USD');
    setShowAddCapitalDialog(true);
  };

    const openEditDialog = (partner: Partner) => {
    setSelectedPartner(partner);
    setFormData({
      name: partner.name,
      phone: partner.phone,
      email: partner.email || '',
      accessAll: partner.accessAll,
      sharesExpenses: partner.sharesExpenses || false,
      expenseSharePercentage: partner.expenseSharePercentage || 0,
      categoryShares: partner.categoryShares.length > 0
        ? partner.categoryShares.map(cs => ({
          ...cs,
          categoryName: cs.categoryName || categories.find(c => c.id === cs.categoryId)?.label || '',
        }))
        : categories.map(c => ({
          categoryId: c.id,
          categoryName: c.label,
          percentage: partner.sharePercentage,
          enabled: true,
        })),
    });
    setShowEditDialog(true);
  };

  const openViewDialog = (partner: Partner) => {
    setSelectedPartner(partner);
    setViewCurrencyCode('USD');
    setShowViewDialog(true);
  };

  const openDeleteDialog = (partner: Partner) => {
    setSelectedPartner(partner);
    setShowDeleteDialog(true);
  };

  const openWithdrawDialog = (partner: Partner) => {
    setSelectedPartner(partner);
    setWithdrawAmount(0);
    setWithdrawType('auto');
    setWithdrawNotes('');
    setShowWithdrawDialog(true);
  };

  const updateCategoryShare = (categoryId: string, field: 'percentage' | 'enabled', value: number | boolean) => {
    setFormData({
      ...formData,
      categoryShares: formData.categoryShares.map(c =>
        c.categoryId === categoryId
          ? { ...c, [field]: value }
          : c
      ),
    });
  };

  const handleAccessAllChange = (checked: boolean) => {
    if (checked) {
      const firstPercentage = formData.categoryShares[0]?.percentage || 0;
      setFormData({
        ...formData,
        accessAll: true,
        categoryShares: formData.categoryShares.map(c => ({
          ...c,
          enabled: true,
          percentage: firstPercentage,
        })),
      });
    } else {
      setFormData({
        ...formData,
        accessAll: false,
      });
    }
  };

  const handleUniformPercentageChange = (value: number) => {
    if (formData.accessAll) {
      setFormData({
        ...formData,
        categoryShares: formData.categoryShares.map(c => ({
          ...c,
          percentage: value,
        })),
      });
    }
  };

  return (
    <div className="p-0 sm:p-4 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-3xl font-bold text-foreground">{t('partners.title')}</h1>
          <p className="text-xs sm:text-sm md:text-base text-muted-foreground mt-0.5">{t('partners.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
          <Button variant="outline" size="sm" className="h-9 px-3 text-xs sm:text-sm" onClick={() => setShowCategoryManager(true)}>
            <Tag className="w-4 h-4" />
            <span>{t('partners.categories')}</span>
          </Button>
          <Button size="sm" className="bg-primary hover:bg-primary/90 h-9 px-3 text-xs sm:text-sm" onClick={() => {
            resetForm();
            setShowAddDialog(true);
          }}>
            <Plus className="w-4 h-4" />
            <span className="whitespace-nowrap">{t('partners.addPartner')}</span>
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
        <div className="bg-card rounded-xl border border-border p-3 md:p-4">
          <div className="flex items-center gap-2 md:gap-3">
            <div className="p-1.5 md:p-2 rounded-lg bg-primary/10">
              <UserCheck className="w-4 h-4 md:w-5 md:h-5 text-primary" />
            </div>
            <div>
              <p className="text-lg md:text-2xl font-bold text-foreground">{formatNumber(stats.totalPartners)}</p>
              <p className="text-xs md:text-sm text-muted-foreground">{t('partners.partners')}</p>
            </div>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-3 md:p-4">
          <div className="flex items-center gap-2 md:gap-3">
            <div className="p-1.5 md:p-2 rounded-lg bg-info/10">
              <Percent className="w-4 h-4 md:w-5 md:h-5 text-info" />
            </div>
            <div>
              <p className="text-lg md:text-2xl font-bold text-foreground">{formatNumber(stats.totalShare)}%</p>
              <p className="text-xs md:text-sm text-muted-foreground">{t('partners.distributed')}</p>
            </div>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-3 md:p-4">
          <div className="flex items-center gap-2 md:gap-3">
            <div className="p-1.5 md:p-2 rounded-lg bg-warning/10">
              <Wallet className="w-4 h-4 md:w-5 md:h-5 text-warning" />
            </div>
            <div>
              <p className="text-lg md:text-2xl font-bold text-foreground">${formatNumber(stats.totalBalance, 2)}</p>
              <p className="text-xs md:text-sm text-muted-foreground">{t('partners.balances')}</p>
            </div>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-3 md:p-4">
          <div className="flex items-center gap-2 md:gap-3">
            <div className="p-1.5 md:p-2 rounded-lg bg-success/10">
              <TrendingUp className="w-4 h-4 md:w-5 md:h-5 text-success" />
            </div>
            <div>
              <p className="text-lg md:text-2xl font-bold text-foreground">${formatNumber(stats.totalProfit, 2)}</p>
              <p className="text-xs md:text-sm text-muted-foreground">{t('partners.profits')}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 md:w-5 md:h-5 text-muted-foreground" />
        <Input
          type="text"
          placeholder={t('partners.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pr-9 md:pr-10 bg-muted border-0"
        />
      </div>

      {/* Partners Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        {filteredPartners.map((partner, index) => (
          <div
            key={partner.id}
            className="bg-card rounded-xl md:rounded-2xl border border-border p-4 md:p-6 card-hover fade-in"
            style={{ animationDelay: `${index * 50}ms` }}
          >
            {/* Partner Header */}
            <div className="flex items-start justify-between mb-3 md:mb-4">
              <div className="flex items-center gap-2 md:gap-3">
                <div className="w-10 h-10 md:w-12 md:h-12 rounded-full bg-gradient-primary flex items-center justify-center">
                  <span className="text-base md:text-lg font-bold text-primary-foreground">
                    {partner.name.charAt(0)}
                  </span>
                </div>
                <div>
                  <h3 className="font-semibold text-foreground text-sm md:text-base">{partner.name}</h3>
                  <p className="text-xs md:text-sm text-muted-foreground">{t('partners.since')} {partner.joinedDate}</p>
                </div>
              </div>
              <div className="text-left">
                <span className="px-2 md:px-3 py-0.5 md:py-1 rounded-full text-xs md:text-sm font-bold bg-primary/10 text-primary">
                  {partner.sharePercentage}%
                </span>
                {partner.accessAll ? (
                  <p className="text-[10px] text-muted-foreground mt-1">{t('partners.fullStore')}</p>
                ) : (
                  <p className="text-[10px] text-muted-foreground mt-1">{t('partners.specificCategories')}</p>
                )}
                {partner.sharesExpenses && (
                  <span className="text-[10px] text-success">● {t('partners.sharesExpenses')}</span>
                )}
              </div>
            </div>

            {/* Category Shares */}
            {!partner.accessAll && partner.categoryShares.filter(c => c.enabled).length > 0 && (
              <div className="flex flex-wrap gap-1 mb-3">
                {partner.categoryShares.filter(c => c.enabled).map(cs => {
                  return (
                    <span key={cs.categoryId} className="px-2 py-0.5 rounded-full text-[10px] bg-accent/10 text-accent">
                      {cs.categoryName || cs.categoryId}: {cs.percentage}%
                    </span>
                  );
                })}
              </div>
            )}

            {/* Contact Info */}
            <div className="space-y-1.5 md:space-y-2 mb-3 md:mb-4">
              <div className="flex items-center gap-2 text-xs md:text-sm text-muted-foreground">
                <Phone className="w-3.5 h-3.5 md:w-4 md:h-4" />
                <span>{partner.phone}</span>
              </div>
              {partner.email && (
                <div className="flex items-center gap-2 text-xs md:text-sm text-muted-foreground">
                  <Mail className="w-3.5 h-3.5 md:w-4 md:h-4" />
                  <span className="truncate">{partner.email}</span>
                </div>
              )}
            </div>

            {/* Financial Stats في كرت الشريك */}
            <div className="grid grid-cols-2 gap-2 py-3 md:py-4 border-t border-border">
              <div className="text-center">
                <p className="text-[10px] md:text-xs text-muted-foreground">{t('partners.profits')}</p>
                <div className="space-y-0.5">
                  <span className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400">
                    ${formatNumber(partner.currentBalance || 0, 2)}
                  </span>
                  {/* إظهار كبسولة المعادل اللحظي للعملات الأخرى أسفل الرقم */}
                  <div className="flex items-center justify-center gap-1.5 flex-wrap">
                    {getEquivalentCurrencies(partner.currentBalance || 0).equivalents.map(eq => (
                      <span key={eq.code} className="text-[10px] font-mono text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                        ≈ {eq.formatted}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="text-center">
                <p className="text-[10px] md:text-xs text-muted-foreground">{t('partners.capital')}</p>
                <div className="space-y-0.5">
                  <span className="text-xl font-bold font-mono text-info">
                    ${formatNumber(partner.currentCapital || 0, 2)}
                  </span>
                  <div className="flex items-center justify-center gap-1.5 flex-wrap">
                    {getEquivalentCurrencies(partner.currentCapital || 0).equivalents.map(eq => (
                      <span key={eq.code} className="text-[10px] font-mono text-muted-foreground bg-muted/60 px-1.5 py-0.5 rounded">
                        ≈ {eq.formatted}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 pt-3 md:pt-4 border-t border-border">
              <Button variant="outline" size="sm" className="sm:flex-1 h-8 md:h-9 text-xs md:text-sm" onClick={() => openViewDialog(partner)}>
                <Eye className="w-3.5 h-3.5 md:w-4 md:h-4" />
                {t('common.view')}
              </Button>
              <Button size="sm" className="sm:flex-1 h-8 md:h-9 bg-success hover:bg-success/90 text-success-foreground text-xs md:text-sm" onClick={() => openAddCapitalDialog(partner)}>
                <ArrowUpRight className="w-3.5 h-3.5 md:w-4 md:h-4" />
                {t('partners.deposit')}
              </Button>
              {((partner.currentBalance || 0) > 0 || (partner.currentCapital || 0) > 0) && (
                <Button size="sm" className="sm:flex-1 h-8 md:h-9 bg-warning hover:bg-warning/90 text-warning-foreground text-xs md:text-sm" onClick={() => openWithdrawDialog(partner)}>
                  <ArrowDownLeft className="w-3.5 h-3.5 md:w-4 md:h-4" />
                  {t('partners.withdraw')}
                </Button>
              )}
              <div className={cn(
                "flex items-center justify-end gap-1",
                !((partner.currentBalance || 0) > 0 || (partner.currentCapital || 0) > 0) && "col-span-2 sm:col-span-1"
              )}>
                <Button variant="ghost" size="icon" className="h-8 w-8 md:h-9 md:w-9" onClick={() => openEditDialog(partner)} title={t('common.edit') || 'تعديل'}>
                  <Edit className="w-3.5 h-3.5 md:w-4 md:h-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 md:h-9 md:w-9 text-destructive" onClick={() => openDeleteDialog(partner)} title={t('common.delete') || 'حذف'}>
                  <Trash2 className="w-3.5 h-3.5 md:w-4 md:h-4" />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add Partner Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-5 h-5 text-primary" />
              {t('partners.addNewPartner')}
            </DialogTitle>
            <DialogDescription>{t('partners.addPartnerDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('common.name')} *</label>
              <Input
                placeholder={t('partners.partnerName')}
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('common.phone')} *</label>
              <Input
                placeholder="+963 xxx xxx xxx"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('common.email')}</label>
              <Input
                placeholder="email@example.com"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>

            {/* Profit Section */}
            <div className="p-4 bg-muted/40 border border-border/40 rounded-xl space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">{t('partners.accessFullStore')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('partners.uniformPercentage')}</p>
                </div>
                <Switch
                  checked={formData.accessAll}
                  onCheckedChange={handleAccessAllChange}
                />
              </div>

              {formData.accessAll ? (
                <div>
                  <label className="text-sm font-medium mb-1.5 block">{t('partners.profitPercentageAll')}</label>
                  <Input
                    type="number"
                    placeholder="0"
                    min="0"
                    max="100"
                    value={formData.categoryShares[0]?.percentage || ''}
                    onChange={(e) => handleUniformPercentageChange(Number(e.target.value))}
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm font-medium">{t('partners.profitPerCategory')}:</p>
                  {categories.map(cat => {
                    const share = formData.categoryShares.find(c => c.categoryId === cat.id);
                    return (
                      <div key={cat.id} className="flex items-center gap-3">
                        <Switch
                          checked={share?.enabled || false}
                          onCheckedChange={(checked) => updateCategoryShare(cat.id, 'enabled', checked)}
                        />
                        <span className="flex-1 text-sm">{cat.label}</span>
                        <Input
                          type="number"
                          className="w-20"
                          placeholder="0"
                          min="0"
                          max="100"
                          disabled={!share?.enabled}
                          value={share?.percentage || ''}
                          onChange={(e) => updateCategoryShare(cat.id, 'percentage', Number(e.target.value))}
                        />
                        <span className="text-sm text-muted-foreground">%</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Expense Section */}
            <div className="p-4 bg-muted/40 border border-border/40 rounded-xl space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">{t('partners.expenseSharing')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('partners.expenseSharingDesc')}</p>
                </div>
                <Switch
                  checked={formData.sharesExpenses}
                  onCheckedChange={(checked) => setFormData({ ...formData, sharesExpenses: checked })}
                />
              </div>

              {formData.sharesExpenses && (
                <div className="ps-3 border-s-2 border-primary/30">
                  <label className="text-sm font-medium mb-1.5 block">{t('partners.expenseShareDesc')} (%)</label>
                  <Input
                    type="number"
                    placeholder="0"
                    min="0"
                    max="100"
                    value={formData.expenseSharePercentage || ''}
                    onChange={(e) => setFormData({ ...formData, expenseSharePercentage: Number(e.target.value) })}
                  />
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-4">
              <Button variant="outline" className="flex-1" onClick={() => setShowAddDialog(false)}>
                {t('common.cancel')}
              </Button>
              <Button className="flex-1" onClick={handleAddPartner} disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {t('common.save')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Partner Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit className="w-5 h-5 text-primary" />
              {t('partners.editPartner')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('common.name')} *</label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('common.phone')} *</label>
              <Input
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('common.email')}</label>
              <Input
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              />
            </div>

            {/* Profit Section */}
            <div className="p-4 bg-muted/40 border border-border/40 rounded-xl space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">{t('partners.accessFullStore')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('partners.uniformPercentage')}</p>
                </div>
                <Switch
                  checked={formData.accessAll}
                  onCheckedChange={handleAccessAllChange}
                />
              </div>

              {formData.accessAll ? (
                <div>
                  <label className="text-sm font-medium mb-1.5 block">{t('partners.profitPercentageAll')}</label>
                  <Input
                    type="number"
                    placeholder="0"
                    min="0"
                    max="100"
                    value={formData.categoryShares[0]?.percentage || ''}
                    onChange={(e) => handleUniformPercentageChange(Number(e.target.value))}
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm font-medium">{t('partners.profitPerCategory')}:</p>
                  {categories.map(cat => {
                    const share = formData.categoryShares.find(c => c.categoryId === cat.id);
                    return (
                      <div key={cat.id} className="flex items-center gap-3">
                        <Switch
                          checked={share?.enabled || false}
                          onCheckedChange={(checked) => updateCategoryShare(cat.id, 'enabled', checked)}
                        />
                        <span className="flex-1 text-sm">{cat.label}</span>
                        <Input
                          type="number"
                          className="w-20"
                          placeholder="0"
                          min="0"
                          max="100"
                          disabled={!share?.enabled}
                          value={share?.percentage || ''}
                          onChange={(e) => updateCategoryShare(cat.id, 'percentage', Number(e.target.value))}
                        />
                        <span className="text-sm text-muted-foreground">%</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Expense Section */}
            <div className="p-4 bg-muted/40 border border-border/40 rounded-xl space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">{t('partners.expenseSharing')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('partners.expenseSharingDesc')}</p>
                </div>
                <Switch
                  checked={formData.sharesExpenses}
                  onCheckedChange={(checked) => setFormData({ ...formData, sharesExpenses: checked })}
                />
              </div>

              {formData.sharesExpenses && (
                <div className="ps-3 border-s-2 border-primary/30">
                  <label className="text-sm font-medium mb-1.5 block">{t('partners.expenseShareDesc')} (%)</label>
                  <Input
                    type="number"
                    placeholder="0"
                    min="0"
                    max="100"
                    value={formData.expenseSharePercentage || ''}
                    onChange={(e) => setFormData({ ...formData, expenseSharePercentage: Number(e.target.value) })}
                  />
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-4">
              <Button variant="outline" className="flex-1" onClick={() => setShowEditDialog(false)}>
                {t('common.cancel')}
              </Button>
              <Button className="flex-1" onClick={handleEditPartner} disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {t('common.saveChanges')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* View Partner Dialog */}
      <Dialog open={showViewDialog} onOpenChange={setShowViewDialog}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-primary" />
              {t('partners.partnerDetails')}
            </DialogTitle>
          </DialogHeader>
          {selectedPartner && (
            <div className="space-y-4 py-4">
              {/* شريط اختيار العملة في أعلى نافذة العرض */}
              <div className="flex items-center justify-between pb-3 border-b border-border">
                <span className="text-xs font-semibold text-muted-foreground">عرض القيم بعملة:</span>
                <div className="flex items-center gap-1.5 p-1 bg-muted/60 rounded-xl">
                  {getEnabledCurrencies().map(curr => (
                    <button
                      key={curr.code}
                      onClick={() => setViewCurrencyCode(curr.code)}
                      className={cn(
                        "px-2.5 py-1 rounded-lg text-xs font-bold transition-all",
                        viewCurrencyCode === curr.code
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {curr.symbol} {curr.code}
                    </button>
                  ))}
                </div>
              </div>

              {/* Basic Info */}
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-gradient-primary flex items-center justify-center">
                  <span className="text-2xl font-bold text-primary-foreground">
                    {selectedPartner.name.charAt(0)}
                  </span>
                </div>
                <div>
                  <h3 className="text-xl font-bold">{selectedPartner.name}</h3>
                  <p className="text-muted-foreground">{t('partners.since')} {selectedPartner.joinedDate}</p>
                </div>
              </div>

              {/* Financial Summary */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-success/10 rounded-lg p-4 text-center">
                  <p className="text-sm text-muted-foreground">{t('partners.profits')}</p>
                  <p className="text-2xl font-bold text-success font-mono">{convertForView(selectedPartner.currentBalance || 0)}</p>
                </div>
                <div className="bg-info/10 rounded-lg p-4 text-center">
                  <p className="text-sm text-muted-foreground">{t('partners.capital')}</p>
                  <p className="text-2xl font-bold text-info font-mono">{convertForView(selectedPartner.currentCapital || 0)}</p>
                </div>
              </div>

              {/* Stats */}
              <div className="space-y-2">
                <div className="flex justify-between py-2 border-b">
                  <span className="text-muted-foreground">{t('partners.sharePercentage')}</span>
                  <span className="font-medium">{selectedPartner.sharePercentage}%</span>
                </div>
                <div className="flex justify-between py-2 border-b">
                  <span className="text-muted-foreground">{t('partners.totalProfitEarned')}</span>
                  <span className="font-medium text-success font-mono">{convertForView(selectedPartner.totalProfitEarned || 0)}</span>
                </div>
                <div className="flex justify-between py-2 border-b">
                  <span className="text-muted-foreground">{t('partners.totalWithdrawn')}</span>
                  <span className="font-medium text-warning font-mono">{convertForView(selectedPartner.totalWithdrawn || 0)}</span>
                </div>
                <div className="flex justify-between py-2 border-b">
                  <span className="text-muted-foreground">{t('partners.totalCapital')}</span>
                  <span className="font-medium text-info font-mono">{convertForView(selectedPartner.initialCapital || 0)}</span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-4">
                <Button
                  className="flex-1 bg-success hover:bg-success/90 text-success-foreground"
                  onClick={() => {
                    setShowViewDialog(false);
                    openAddCapitalDialog(selectedPartner);
                  }}
                >
                  <ArrowUpRight className="w-4 h-4" />
                  {t('partners.addBalance')}
                </Button>
                {((selectedPartner.currentBalance || 0) > 0 || (selectedPartner.currentCapital || 0) > 0) && (
                  <Button
                    className="flex-1 bg-warning hover:bg-warning/90 text-warning-foreground"
                    onClick={() => {
                      setShowViewDialog(false);
                      openWithdrawDialog(selectedPartner);
                    }}
                  >
                    <ArrowDownLeft className="w-4 h-4" />
                    {t('partners.withdrawBalance')}
                  </Button>
                )}
              </div>

              {/* Detailed Partner Statement Tabs */}
              <div className="pt-4 border-t border-border">
                <Tabs defaultValue="profits" className="w-full">
                  <TabsList className="grid grid-cols-3 w-full bg-muted/60 p-1 rounded-xl">
                    <TabsTrigger value="profits" className="text-xs font-bold gap-1.5 data-[state=active]:bg-background">
                      <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
                      الأرباح
                    </TabsTrigger>
                    <TabsTrigger value="expenses" className="text-xs font-bold gap-1.5 data-[state=active]:bg-background">
                      <Receipt className="w-3.5 h-3.5 text-rose-500" />
                      المصاريف
                    </TabsTrigger>
                    <TabsTrigger value="capital" className="text-xs font-bold gap-1.5 data-[state=active]:bg-background">
                      <Wallet className="w-3.5 h-3.5 text-blue-500" />
                      رأس المال
                    </TabsTrigger>
                  </TabsList>

                  {/* 1. تبويب الأرباح */}
                  <TabsContent value="profits" className="mt-3 space-y-2">
                    {(!selectedPartner.profitHistory || selectedPartner.profitHistory.length === 0) ? (
                      <div className="text-center py-8 text-muted-foreground bg-muted/20 rounded-xl border border-dashed border-border text-xs">
                        لا توجد سجلات أرباح مسجلة لهذا الشريك حتى الآن
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                        {selectedPartner.profitHistory.map((p, idx) => {
                          const eq = getEquivalentCurrencies(p.amount);
                          return (
                            <div key={p.id || idx} className="p-2.5 rounded-lg border border-border/80 bg-card/60 flex items-center justify-between text-xs hover:bg-muted/30 transition-colors">
                              <div className="space-y-0.5">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono font-bold text-foreground">#{p.invoiceId}</span>
                                  {p.category && (
                                    <span className="bg-primary/10 text-primary text-[10px] px-1.5 py-0.2 rounded font-semibold">
                                      {p.category}
                                    </span>
                                  )}
                                  <span className={cn(
                                    "text-[9.5px] px-1.5 py-0.2 rounded font-medium",
                                    p.isDebt ? "bg-amber-500/10 text-amber-600 dark:text-amber-400" : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  )}>
                                    {p.isDebt ? 'بيع آجل' : 'نقدي'}
                                  </span>
                                </div>
                                <div className="text-[10px] text-muted-foreground font-mono">
                                  {p.createdAt ? new Date(p.createdAt).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-'}
                                </div>
                              </div>
                              <div className="text-left font-mono">
                                <span className="font-bold text-emerald-600 dark:text-emerald-400 block text-sm">
                                  +{convertForView(p.amount || 0)}
                                </span>
                                {viewCurrencyCode === 'USD' && eq.equivalents.length > 0 && (
                                  <div className="flex items-center gap-1 mt-0.5 flex-wrap justify-end">
                                    {eq.equivalents.map(c => (
                                      <span key={c.code} className="text-[9px] font-mono px-1 py-0.2 bg-muted/80 text-muted-foreground rounded font-bold">
                                        ≈ {c.formatted}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </TabsContent>

                  {/* 2. تبويب المصاريف */}
                  <TabsContent value="expenses" className="mt-3 space-y-2">
                    {(!selectedPartner.expenseHistory || selectedPartner.expenseHistory.length === 0) ? (
                      <div className="text-center py-8 text-muted-foreground bg-muted/20 rounded-xl border border-dashed border-border text-xs">
                        لا توجد استقطاعات مصاريف مسجلة لهذا الشريك
                      </div>
                    ) : (
                      <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                        {selectedPartner.expenseHistory.map((exp, idx) => (
                          <div key={exp.expenseId || idx} className="p-2.5 rounded-lg border border-border/80 bg-card/60 flex items-center justify-between text-xs hover:bg-muted/30 transition-colors">
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-foreground">{exp.type || 'مصروف عام'}</span>
                              </div>
                              <div className="text-[10px] text-muted-foreground">
                                <span>{exp.date || (exp.createdAt ? new Date(exp.createdAt).toLocaleDateString('ar-EG') : '-')}</span>
                                {exp.notes && <span className="mr-2 text-foreground/70">({exp.notes})</span>}
                              </div>
                            </div>
                            <div className="text-left font-mono">
                              <span className="font-bold text-rose-600 dark:text-rose-400 text-sm">
                                -{convertForView(exp.amount || 0)}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </TabsContent>

                  {/* 3. تبويب حركة رأس المال والمسحوبات */}
                  <TabsContent value="capital" className="mt-3 space-y-3">
                    {/* حركة رأس المال */}
                    <div className="space-y-1.5">
                      <h4 className="text-[11px] font-bold text-muted-foreground flex items-center gap-1">
                        <PiggyBank className="w-3.5 h-3.5 text-blue-500" />
                        حركات رأس المال (إيداعات وتعديلات)
                      </h4>
                      {(!selectedPartner.capitalHistory || selectedPartner.capitalHistory.length === 0) ? (
                        <div className="text-center py-3 text-muted-foreground bg-muted/20 rounded-lg border border-dashed border-border text-[11px]">
                          لا توجد حركات رأس مال مسجلة
                        </div>
                      ) : (
                        <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                          {selectedPartner.capitalHistory.map((cap, idx) => (
                            <div key={cap.id || idx} className="p-2 rounded-lg border border-border/70 bg-card/50 flex items-center justify-between text-xs">
                              <div>
                                <span className={cn(
                                  "font-bold text-[11px] px-1.5 py-0.2 rounded",
                                  cap.type === 'deposit' ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" : "bg-amber-500/10 text-amber-600"
                                )}>
                                  {cap.type === 'deposit' ? 'إيداع رأس مال' : 'سحب رأس مال'}
                                </span>
                                <span className="text-[10px] text-muted-foreground mr-2 font-mono">{cap.date}</span>
                                {cap.notes && <p className="text-[10px] text-muted-foreground mt-0.5">{cap.notes}</p>}
                              </div>
                              <span className="font-mono font-bold text-foreground">
                                {convertForView(cap.amount || 0)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* المسحوبات */}
                    <div className="space-y-1.5 pt-2 border-t border-border/60">
                      <h4 className="text-[11px] font-bold text-muted-foreground flex items-center gap-1">
                        <ArrowDownLeft className="w-3.5 h-3.5 text-amber-500" />
                        سجل المسحوبات (أرباح ورأس مال)
                      </h4>
                      {(!selectedPartner.withdrawalHistory || selectedPartner.withdrawalHistory.length === 0) ? (
                        <div className="text-center py-3 text-muted-foreground bg-muted/20 rounded-lg border border-dashed border-border text-[11px]">
                          لا توجد مسحوبات مسجلة
                        </div>
                      ) : (
                        <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                          {selectedPartner.withdrawalHistory.map((w, idx) => (
                            <div key={w.id || idx} className="p-2 rounded-lg border border-border/70 bg-card/50 flex items-center justify-between text-xs">
                              <div>
                                <span className={cn(
                                  "font-bold text-[11px] px-1.5 py-0.2 rounded",
                                  w.type === 'profit' ? "bg-emerald-500/10 text-emerald-600" : "bg-purple-500/10 text-purple-600"
                                )}>
                                  {w.type === 'profit' ? 'سحب أرباح' : 'سحب رأس مال'}
                                </span>
                                <span className="text-[10px] text-muted-foreground mr-2 font-mono">{w.date}</span>
                                {w.notes && <p className="text-[10px] text-muted-foreground mt-0.5">{w.notes}</p>}
                              </div>
                              <span className="font-mono font-bold text-amber-600 dark:text-amber-400">
                                -{convertForView(w.amount || 0)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Withdraw Dialog */}
      <Dialog open={showWithdrawDialog} onOpenChange={setShowWithdrawDialog}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowDownLeft className="w-5 h-5 text-warning" />
              {t('partners.withdrawBalance')}
            </DialogTitle>
            <DialogDescription>
              {t('partners.withdrawFor')} {selectedPartner?.name}
            </DialogDescription>
          </DialogHeader>
          {selectedPartner && (
            <div className="space-y-4 py-4">
              {/* Currency Selector Capsules */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground block">عملة السحب والتسليم</label>
                <div className="flex flex-wrap gap-1.5">
                  {getEnabledCurrencies().map(curr => {
                    const isSelected = withdrawCurrency === curr.code;
                    return (
                      <button
                        key={curr.code}
                        type="button"
                        onClick={() => {
                          setWithdrawCurrency(curr.code);
                          setWithdrawAmount(0);
                        }}
                        className={cn(
                          "px-3 py-1 text-xs font-bold rounded-lg border transition-all",
                          isSelected
                            ? "bg-primary text-primary-foreground border-primary shadow-sm"
                            : "bg-muted/40 hover:bg-muted text-foreground border-border/60"
                        )}
                      >
                        {curr.code} ({curr.symbol})
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Available Balances */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-success/10 rounded-lg p-3 text-center">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <TrendingUp className="w-4 h-4 text-success" />
                    <p className="text-xs text-muted-foreground">{t('partners.profits')}</p>
                  </div>
                  <p className="text-xl font-bold text-success">$${formatNumber(selectedPartner.currentBalance || 0)}</p>
                  {withdrawCurrency !== 'USD' && (
                    <p className="text-xs font-semibold text-success/80 mt-0.5">
                      ≈ {formatNumber(fromUsd(selectedPartner.currentBalance || 0, withdrawCurrency))} {withdrawCurrency}
                    </p>
                  )}
                </div>
                <div className="bg-info/10 rounded-lg p-3 text-center">
                  <div className="flex items-center justify-center gap-1 mb-1">
                    <PiggyBank className="w-4 h-4 text-info" />
                    <p className="text-xs text-muted-foreground">{t('partners.capital')}</p>
                  </div>
                  <p className="text-xl font-bold text-info">$${formatNumber(selectedPartner.currentCapital || 0)}</p>
                  {withdrawCurrency !== 'USD' && (
                    <p className="text-xs font-semibold text-info/80 mt-0.5">
                      ≈ {formatNumber(fromUsd(selectedPartner.currentCapital || 0, withdrawCurrency))} {withdrawCurrency}
                    </p>
                  )}
                </div>
              </div>

              {/* Withdraw Type */}
              <div className="space-y-3">
                <label className="text-sm font-medium">{t('partners.withdrawType')}</label>
                <RadioGroup value={withdrawType} onValueChange={(value) => setWithdrawType(value as 'profit' | 'capital' | 'auto')}>
                  <div className="flex items-center space-x-2 space-x-reverse">
                    <RadioGroupItem value="profit" id="profit" disabled={(selectedPartner.currentBalance || 0) <= 0} />
                    <Label htmlFor="profit" className={cn("cursor-pointer", (selectedPartner.currentBalance || 0) <= 0 && "opacity-50")}>
                      {t('partners.withdrawFromProfitOnly')}
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 space-x-reverse">
                    <RadioGroupItem value="capital" id="capital" disabled={(selectedPartner.currentCapital || 0) <= 0} />
                    <Label htmlFor="capital" className={cn("cursor-pointer", (selectedPartner.currentCapital || 0) <= 0 && "opacity-50")}>
                      {t('partners.withdrawFromCapitalOnly')}
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2 space-x-reverse">
                    <RadioGroupItem value="auto" id="auto" />
                    <Label htmlFor="auto" className="cursor-pointer">
                      {t('partners.withdrawAuto')}
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              {/* Withdraw Amount */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium">{t('partners.withdrawAmount')} ({withdrawCurrency})</label>
                  {withdrawCurrency !== 'USD' && withdrawAmount > 0 && (
                    <span className="text-xs font-bold text-primary">
                      ≈ $${formatNumber(toUsd(withdrawAmount, withdrawCurrency))}
                    </span>
                  )}
                </div>
                <div className="relative">
                  <Input
                    type="number"
                    placeholder="0"
                    value={withdrawAmount || ''}
                    onChange={(e) => setWithdrawAmount(Number(e.target.value))}
                    className="pr-14"
                  />
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
                    {withdrawCurrency}
                  </span>
                </div>
              </div>

              {/* Quick Withdraw Buttons */}
              <div className="flex gap-2">
                {withdrawType === 'profit' && (selectedPartner.currentBalance || 0) > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 text-xs"
                    onClick={() => {
                      const maxProfit = fromUsd(selectedPartner.currentBalance || 0, withdrawCurrency);
                      setWithdrawAmount(roundForCurrency(maxProfit, withdrawCurrency));
                    }}
                  >
                    {t('partners.allProfit')}
                  </Button>
                )}
                {withdrawType === 'capital' && (selectedPartner.currentCapital || 0) > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 text-xs"
                    onClick={() => {
                      const maxCapital = fromUsd(selectedPartner.currentCapital || 0, withdrawCurrency);
                      setWithdrawAmount(roundForCurrency(maxCapital, withdrawCurrency));
                    }}
                  >
                    {t('partners.allCapital')}
                  </Button>
                )}
                {withdrawType === 'auto' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 text-xs"
                    onClick={() => {
                      const maxTotal = fromUsd((selectedPartner.currentBalance || 0) + (selectedPartner.currentCapital || 0), withdrawCurrency);
                      setWithdrawAmount(roundForCurrency(maxTotal, withdrawCurrency));
                    }}
                  >
                    {t('partners.withdrawAll')}
                  </Button>
                )}
              </div>

              {/* Notes */}
              <div>
                <label className="text-sm font-medium mb-1.5 block">{t('common.notes')} ({t('common.optional')})</label>
                <Textarea
                  placeholder={t('partners.addNote')}
                  value={withdrawNotes}
                  onChange={(e) => setWithdrawNotes(e.target.value)}
                  rows={2}
                />
              </div>

              <div className="flex gap-3 pt-4">
                <Button variant="outline" className="flex-1" onClick={() => setShowWithdrawDialog(false)}>
                  {t('common.cancel')}
                </Button>
                <Button className="flex-1 bg-warning hover:bg-warning/90 text-warning-foreground" onClick={handleWithdraw} disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {t('partners.confirmWithdraw')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Capital / Deposit Dialog */}
      <Dialog open={showAddCapitalDialog} onOpenChange={setShowAddCapitalDialog}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowUpRight className="w-5 h-5 text-success" />
              {depositTarget === 'balance' ? 'إيداع رصيد للشريك' : t('partners.addCapital')}
            </DialogTitle>
            <DialogDescription>
              {depositTarget === 'balance' ? 'إيداع رصيد أرباح أو تسوية مستحقات لـ' : t('partners.addCapitalFor')} {selectedPartner?.name}
            </DialogDescription>
          </DialogHeader>
          {selectedPartner && (
            <div className="space-y-4 py-4">
              {/* Deposit Target Capsules */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground block">وجهة الإيداع</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setDepositTarget('capital')}
                    className={cn(
                      "p-2.5 rounded-xl border text-xs font-bold transition-all text-center flex flex-col items-center gap-1",
                      depositTarget === 'capital'
                        ? "bg-info/15 text-info border-info/50 shadow-sm"
                        : "bg-muted/30 hover:bg-muted text-muted-foreground border-border/50"
                    )}
                  >
                    <PiggyBank className="w-4 h-4" />
                    <span>رأس مال استثماري</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDepositTarget('balance')}
                    className={cn(
                      "p-2.5 rounded-xl border text-xs font-bold transition-all text-center flex flex-col items-center gap-1",
                      depositTarget === 'balance'
                        ? "bg-success/15 text-success border-success/50 shadow-sm"
                        : "bg-muted/30 hover:bg-muted text-muted-foreground border-border/50"
                    )}
                  >
                    <TrendingUp className="w-4 h-4" />
                    <span>رصيد متاح / تسوية</span>
                  </button>
                </div>
              </div>

              {/* Currency Selector Capsules */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-muted-foreground block">عملة الإيداع المقبوضة</label>
                <div className="flex flex-wrap gap-1.5">
                  {getEnabledCurrencies().map(curr => {
                    const isSelected = depositCurrency === curr.code;
                    return (
                      <button
                        key={curr.code}
                        type="button"
                        onClick={() => {
                          setDepositCurrency(curr.code);
                          setCapitalAmount(0);
                        }}
                        className={cn(
                          "px-3 py-1 text-xs font-bold rounded-lg border transition-all",
                          isSelected
                            ? "bg-primary text-primary-foreground border-primary shadow-sm"
                            : "bg-muted/40 hover:bg-muted text-foreground border-border/60"
                        )}
                      >
                        {curr.code} ({curr.symbol})
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Current Balances Preview */}
              <div className={cn("rounded-lg p-3.5 text-center transition-colors", depositTarget === 'capital' ? "bg-info/10" : "bg-success/10")}>
                <div className="flex items-center justify-center gap-2 mb-1">
                  {depositTarget === 'capital' ? (
                    <PiggyBank className="w-4 h-4 text-info" />
                  ) : (
                    <TrendingUp className="w-4 h-4 text-success" />
                  )}
                  <p className="text-xs text-muted-foreground">
                    {depositTarget === 'capital' ? t('partners.currentCapital') : 'الرصيد المتاح الحالي'}
                  </p>
                </div>
                <p className={cn("text-2xl font-bold", depositTarget === 'capital' ? "text-info" : "text-success")}>
                  $${formatNumber(depositTarget === 'capital' ? (selectedPartner.currentCapital || 0) : (selectedPartner.currentBalance || 0))}
                </p>
                {depositCurrency !== 'USD' && (
                  <p className="text-xs font-semibold text-muted-foreground mt-0.5">
                    ≈ {formatNumber(fromUsd(depositTarget === 'capital' ? (selectedPartner.currentCapital || 0) : (selectedPartner.currentBalance || 0), depositCurrency))} {depositCurrency}
                  </p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-sm font-medium">{t('partners.depositAmount')} ({depositCurrency})</label>
                  {depositCurrency !== 'USD' && capitalAmount > 0 && (
                    <span className="text-xs font-bold text-primary">
                      ≈ $${formatNumber(toUsd(capitalAmount, depositCurrency))}
                    </span>
                  )}
                </div>
                <div className="relative">
                  <Input
                    type="number"
                    placeholder="0"
                    value={capitalAmount || ''}
                    onChange={(e) => setCapitalAmount(Number(e.target.value))}
                    className="pr-14"
                  />
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted-foreground">
                    {depositCurrency}
                  </span>
                </div>
              </div>

              <div>
                <label className="text-sm font-medium mb-1.5 block">{t('common.notes')} ({t('common.optional')})</label>
                <Textarea
                  placeholder={depositTarget === 'balance' ? 'ملاحظة أو سبب إيداع الرصيد...' : t('partners.depositExample')}
                  value={capitalNotes}
                  onChange={(e) => setCapitalNotes(e.target.value)}
                  rows={2}
                />
              </div>

              <div className="flex gap-3 pt-4">
                <Button variant="outline" className="flex-1" onClick={() => setShowAddCapitalDialog(false)}>
                  {t('common.cancel')}
                </Button>
                <Button className="flex-1 bg-success hover:bg-success/90 text-success-foreground" onClick={handleAddCapital} disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  {t('partners.confirmDeposit')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('common.confirmDelete')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('partners.deleteConfirmation')} "{selectedPartner?.name}".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeletePartner} className="bg-destructive hover:bg-destructive/90">
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Category Manager */}
      <CategoryManager
        isOpen={showCategoryManager}
        onClose={() => setShowCategoryManager(false)}
        onCategoriesChange={reloadCategories}
        usedCategories={usedCategories}
      />
    </div>
  );
}
