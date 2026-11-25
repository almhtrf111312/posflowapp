import { useState, useEffect } from 'react';
import { BookOpen, Search, User, Calendar, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { loadMembersCloud, addLoanCloud, LibraryMember } from '@/lib/cloud/library-cloud';
import { DatePicker } from '@/components/ui/date-picker';
import { toast } from '@/lib/sonner-bridge';
import { showSmartToast } from '@/hooks/use-smart-toast';
import { useLanguage } from '@/hooks/language-context';
import { format } from 'date-fns';

interface LoanQuickDialogProps {
  isOpen: boolean;
  onClose: () => void;
  productId: string;
  productName: string;
  onLoanComplete: () => void;
}

export function LoanQuickDialog({
  isOpen,
  onClose,
  productId,
  productName,
  onLoanComplete,
}: LoanQuickDialogProps) {
  const { t, isRTL, language } = useLanguage();
  const [members, setMembers] = useState<LibraryMember[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMember, setSelectedMember] = useState<LibraryMember | null>(null);
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14); // Default 2 weeks
    return format(d, 'yyyy-MM-dd');
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadMembersCloud().then(setMembers);
      setSelectedMember(null);
      setSearchQuery('');
    }
  }, [isOpen]);

  const filteredMembers = members.filter(m =>
    m.membershipStatus === 'active' &&
    (m.name.includes(searchQuery) || m.phone.includes(searchQuery))
  );

  const handleSubmit = async () => {
    if (!selectedMember) {
      toast.warning(language === 'en' ? 'Please select a member' : 'يرجى اختيار عضو');
      return;
    }
    if (!dueDate) {
      toast.warning(language === 'en' ? 'Please select a return due date' : 'يرجى تحديد تاريخ الاسترداد');
      return;
    }

    setIsSubmitting(true);
    const loan = await addLoanCloud({
      productId,
      memberId: selectedMember.id,
      dueDate,
    });

    if (loan) {
      showSmartToast({
        type: 'success',
        title: language === 'en' ? 'Book Loan Registered' : 'تم تسجيل إعارة كتاب',
        subtitle: `#LOAN-${(loan.id || '').substring(0, 6) || 'NEW'}`,
        statusBadge: language === 'en' ? 'Now • Borrowed' : 'الآن • إعارة',
        primaryLabel: language === 'en' ? 'Member' : 'العضو',
        primaryValue: selectedMember.name,
        secondaryLabel: language === 'en' ? 'Book' : 'الكتاب',
        secondaryValue: productName,
        pillText: language === 'en' ? 'Loaned ✓' : 'معار ✓',
        duration: 4000,
      });
      onLoanComplete();
      onClose();
    } else {
      toast.error(language === 'en' ? 'Failed to record loan' : 'فشل تسجيل الإعارة');
    }
    setIsSubmitting(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px] bg-background border-border/50 shadow-2xl"
        dir={isRTL ? 'rtl' : 'ltr'}
        onPointerDownOutside={(e) => { if (selectedMember || isSubmitting) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (selectedMember || isSubmitting) e.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-primary shrink-0" />
            {language === 'en' ? 'Book Loan' : 'إعارة كتاب'}
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="space-y-4 py-4">
          {/* Book Name */}
          <div className="p-3 rounded-lg bg-muted/50 border border-border/50">
            <p className="text-xs text-muted-foreground">{language === 'en' ? 'Book' : 'الكتاب'}</p>
            <p className="font-semibold text-foreground break-words">{productName}</p>
          </div>

          {/* Member Search */}
          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">{language === 'en' ? 'Select Member' : 'اختر العضو'}</label>
            {selectedMember ? (
              <div className="flex items-center justify-between p-3 rounded-lg bg-primary/5 border border-primary/30">
                <div className="flex items-center gap-2">
                  <User className="w-4 h-4 text-primary" />
                  <span className="font-medium">{selectedMember.name}</span>
                  {selectedMember.phone && (
                    <span dir="ltr" className="inline-block tabular-nums text-xs text-muted-foreground">{selectedMember.phone}</span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedMember(null)}
                  className="text-xs"
                >
                  {language === 'en' ? 'Change' : 'تغيير'}
                </Button>
              </div>
            ) : (
              <>
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder={language === 'en' ? 'Search by name or phone...' : 'بحث بالاسم أو الهاتف...'}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="ps-9 pe-3"
                  />
                </div>
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {filteredMembers.length === 0 ? (
                    <p className="text-center text-sm text-muted-foreground py-3">
                      {members.length === 0 ? (language === 'en' ? 'No members found. Add members from the Library page.' : 'لا يوجد أعضاء. أضف أعضاء من صفحة المكتبة.') : (language === 'en' ? 'No results' : 'لا توجد نتائج')}
                    </p>
                  ) : (
                    filteredMembers.map(m => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setSelectedMember(m)}
                        className="w-full min-h-11 text-start p-2.5 rounded-lg hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring flex items-center gap-2 transition-colors"
                      >
                        <User className="w-4 h-4 text-muted-foreground shrink-0" />
                        <div>
                          <p className="text-sm font-medium">{m.name}</p>
                          {m.phone && <p dir="ltr" className="inline-block tabular-nums text-xs text-muted-foreground">{m.phone}</p>}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          {/* Due Date */}
          <div>
            <label className="text-sm font-medium text-foreground mb-1.5 block">
              <Calendar className="w-4 h-4 inline me-1" />
              {language === 'en' ? 'Due Date' : 'تاريخ الاسترداد'}
            </label>
            <DatePicker
              value={dueDate}
              onChange={setDueDate}
              placeholder={language === 'en' ? 'Select return date' : 'اختر تاريخ الاسترداد'}
            />
          </div>

        </DialogBody>

        <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
          <Button variant="outline" size="default" onClick={onClose} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="default"
            size="default"
            onClick={handleSubmit}
            disabled={!selectedMember || isSubmitting}
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : <BookOpen className="w-4 h-4 shrink-0" />}
            {isSubmitting ? (language === 'en' ? 'Recording...' : 'جارٍ التسجيل...') : (language === 'en' ? 'Confirm Loan' : 'تأكيد الإعارة')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}