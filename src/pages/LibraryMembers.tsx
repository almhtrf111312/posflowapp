import { capsuleOuter, capsuleTrigger } from '@/components/ui/SegmentedCapsule';
import { useState, useEffect, useCallback } from 'react';
import {
  Users, Plus, Search, Edit, Trash2, BookOpen, Save,
  AlertTriangle, RotateCcw, Loader2
} from 'lucide-react';
import { cn, formatNumber } from '@/lib/utils';
import { PageHeader } from '@/components/layout/PageHeader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/lib/sonner-bridge';
import { useLanguage } from '@/hooks/language-context';
import {
  loadMembersCloud, addMemberCloud, updateMemberCloud, deleteMemberCloud,
  loadLoansCloud, addLoanCloud, returnLoanCloud, markLoanLostCloud,
  LibraryMember, BookLoan
} from '@/lib/cloud/library-cloud';
import { loadProductsCloud, Product } from '@/lib/cloud/products-cloud';

export default function LibraryMembers() {
  const { language } = useLanguage();
  const isEn = language === 'en';
  const [members, setMembers] = useState<LibraryMember[]>([]);
  const [loans, setLoans] = useState<BookLoan[]>([]);
  const [books, setBooks] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('members');

  // Member dialogs
  const [showAddMember, setShowAddMember] = useState(false);
  const [showEditMember, setShowEditMember] = useState(false);
  const [showDeleteMember, setShowDeleteMember] = useState(false);
  const [selectedMember, setSelectedMember] = useState<LibraryMember | null>(null);
  const [memberForm, setMemberForm] = useState({ name: '', phone: '', email: '', notes: '' });

  // Loan dialogs
  const [showAddLoan, setShowAddLoan] = useState(false);
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [selectedLoan, setSelectedLoan] = useState<BookLoan | null>(null);
  const [loanForm, setLoanForm] = useState({ productId: '', memberId: '', dueDate: '', notes: '' });
  const [returnLateFee, setReturnLateFee] = useState(0);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [m, l, b] = await Promise.all([
        loadMembersCloud(), loadLoansCloud(), loadProductsCloud()
      ]);
      setMembers(m);
      setLoans(l);
      setBooks(b);
    } catch (e) {
      console.error('Failed to load library data:', e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Member CRUD
  const handleAddMember = async () => {
    if (!memberForm.name.trim()) { toast.error(isEn ? 'Name is required' : 'الاسم مطلوب'); return; }
    setIsSaving(true);
    try {
      const result = await addMemberCloud(memberForm);
      if (result) {
        toast.success(isEn ? 'Member added successfully' : 'تم إضافة العضو بنجاح');
        setShowAddMember(false);
        setMemberForm({ name: '', phone: '', email: '', notes: '' });
        loadData();
      } else {
        toast.error(isEn ? 'Failed to add member' : 'فشل في إضافة العضو');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditMember = async () => {
    if (!selectedMember) return;
    setIsSaving(true);
    try {
      const ok = await updateMemberCloud(selectedMember.id, memberForm);
      if (ok) {
        toast.success(isEn ? 'Member updated' : 'تم تحديث العضو');
        setShowEditMember(false);
        loadData();
      } else {
        toast.error(isEn ? 'Failed to update member' : 'فشل في التحديث');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteMember = async () => {
    if (!selectedMember) return;
    setIsSaving(true);
    try {
      const ok = await deleteMemberCloud(selectedMember.id);
      if (ok) {
        toast.success(isEn ? 'Member deleted' : 'تم حذف العضو');
        setShowDeleteMember(false);
        loadData();
      } else {
        toast.error(isEn ? 'Failed to delete member' : 'فشل في الحذف');
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Loan CRUD
  const handleAddLoan = async () => {
    if (!loanForm.productId || !loanForm.memberId || !loanForm.dueDate) {
      toast.error(isEn ? 'Please fill in all required fields' : 'يرجى ملء جميع الحقول المطلوبة');
      return;
    }
    setIsSaving(true);
    try {
      const result = await addLoanCloud(loanForm);
      if (result) {
        toast.success(isEn ? 'Loan recorded successfully' : 'تم تسجيل الإعارة بنجاح');
        setShowAddLoan(false);
        setLoanForm({ productId: '', memberId: '', dueDate: '', notes: '' });
        loadData();
      } else {
        toast.error(isEn ? 'Failed to record loan' : 'فشل في تسجيل الإعارة');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleReturnLoan = async () => {
    if (!selectedLoan) return;
    setIsSaving(true);
    try {
      const ok = await returnLoanCloud(selectedLoan.id, returnLateFee);
      if (ok) {
        toast.success(isEn ? 'Book returned' : 'تم إرجاع الكتاب');
        setShowReturnDialog(false);
        setReturnLateFee(0);
        loadData();
      } else {
        toast.error(isEn ? 'Failed to record return' : 'فشل في تسجيل الإرجاع');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleMarkLost = async (loan: BookLoan) => {
    const ok = await markLoanLostCloud(loan.id);
    if (ok) {
      toast.success(isEn ? 'Book marked as lost' : 'تم تسجيل الكتاب كمفقود');
      loadData();
    }
  };

  // Filters
  const filteredMembers = members.filter(m =>
    m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.phone.includes(searchQuery)
  );

  const filteredLoans = loans.filter(l =>
    (l.memberName || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (l.bookName || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const activeLoansByMember = (memberId: string) =>
    loans.filter(l => l.memberId === memberId && l.status === 'active').length;

  const overdueLoans = loans.filter(l => {
    if (l.status !== 'active') return false;
    return new Date(l.dueDate) < new Date();
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'active':
        return <Badge variant="outline" className="bg-primary/15 text-primary border-primary/30">{isEn ? 'Active' : 'نشط'}</Badge>;
      case 'returned':
        return <Badge variant="outline" className="bg-success/15 text-success border-success/30">{isEn ? 'Returned' : 'مُرجع'}</Badge>;
      case 'overdue':
        return <Badge variant="outline" className="bg-destructive/15 text-destructive border-destructive/30">{isEn ? 'Overdue' : 'متأخر'}</Badge>;
      case 'lost':
        return <Badge variant="secondary">{isEn ? 'Lost' : 'مفقود'}</Badge>;
      default:
        return null;
    }
  };

  const isOverdue = (loan: BookLoan) => loan.status === 'active' && new Date(loan.dueDate) < new Date();

  const isMemberFormDirty = Boolean(memberForm.name.trim() || memberForm.phone.trim() || memberForm.email.trim() || memberForm.notes.trim());
  const isLoanFormDirty = Boolean(loanForm.productId || loanForm.memberId || loanForm.dueDate || loanForm.notes.trim());

  return (
    <div className="p-3 sm:p-4 md:p-6 space-y-4 md:space-y-6">
      <PageHeader
        title={activeTab === 'members' ? (isEn ? 'Members' : 'الأعضاء') : (isEn ? 'Loans' : 'الإعارات')}
        icon={activeTab === 'members' ? <Users className="w-5 h-5" /> : <BookOpen className="w-5 h-5" />}
        actions={
          <Button
            variant="default"
            size="default"
            onClick={() => {
              if (activeTab === 'members') {
                setMemberForm({ name: '', phone: '', email: '', notes: '' });
                setShowAddMember(true);
              } else {
                setLoanForm({ productId: '', memberId: '', dueDate: '', notes: '' });
                setShowAddLoan(true);
              }
            }}
          >
            <Plus className="w-4 h-4 shrink-0" />
            <span>{activeTab === 'members' ? (isEn ? 'New Member' : 'عضو جديد') : (isEn ? 'New Loan' : 'إعارة جديدة')}</span>
          </Button>
        }
      />

      {/* Top Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full space-y-4">
        <div className="flex items-center justify-between gap-2">
          <TabsList className={capsuleOuter}>
            <TabsTrigger value="members" className={capsuleTrigger}>
              <Users className="w-3.5 h-3.5" />
              <span>{isEn ? 'Members' : 'الأعضاء'}</span>
            </TabsTrigger>
            <TabsTrigger value="loans" className={capsuleTrigger}>
              <BookOpen className="w-3.5 h-3.5" />
              <span>{isEn ? 'Loans' : 'الإعارات'}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Compact Stats Strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 text-center select-none">
          <div className="bg-card py-3 px-2 rounded-xl border border-border shadow-xs">
            <span className="text-xs text-muted-foreground font-medium block truncate">{isEn ? "Members" : "الأعضاء"}</span>
            <span dir="ltr" className="inline-block text-base font-bold text-foreground tabular-nums mt-0.5">{members.length}</span>
          </div>
          <div className="bg-card py-3 px-2 rounded-xl border border-border shadow-xs">
            <span className="text-xs text-primary font-medium block truncate">{isEn ? "Active Loans" : "إعارات نشطة"}</span>
            <span dir="ltr" className="inline-block text-base font-bold text-primary tabular-nums mt-0.5">{loans.filter(l => l.status === 'active').length}</span>
          </div>
          <div className="bg-card py-3 px-2 rounded-xl border border-border shadow-xs">
            <span className="text-xs text-destructive font-medium block truncate">{isEn ? "Overdue" : "متأخرة"}</span>
            <span dir="ltr" className="inline-block text-base font-bold text-destructive tabular-nums mt-0.5">{overdueLoans.length}</span>
          </div>
          <div className="bg-card py-3 px-2 rounded-xl border border-border shadow-xs">
            <span className="text-xs text-muted-foreground font-medium block truncate">{isEn ? "Lost" : "مفقودة"}</span>
            <span dir="ltr" className="inline-block text-base font-bold text-muted-foreground tabular-nums mt-0.5">{loans.filter(l => l.status === 'lost').length}</span>
          </div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={isEn ? "Search by name or phone..." : "بحث بالاسم أو الهاتف..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="ps-9 pe-3"
            />
          </div>
        </div>

        {/* Members Tab */}
        <TabsContent value="members" className="space-y-2 mt-2">
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : filteredMembers.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
              <Users className="w-12 h-12 text-muted-foreground/50 mb-3" />
              <p className="text-sm sm:text-base font-semibold text-foreground">{isEn ? "No members yet" : "لا يوجد أعضاء بعد"}</p>
            </div>
          ) : (
            filteredMembers.map(member => (
              <div key={member.id} className="bg-card rounded-xl border border-border p-4 flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold text-foreground truncate">{member.name}</p>
                    {member.membershipStatus === 'active' ? (
                      <Badge variant="outline" className="bg-success/15 text-success border-success/30">{isEn ? "Active" : "نشط"}</Badge>
                    ) : (
                      <Badge variant="outline" className="bg-destructive/15 text-destructive border-destructive/30">{isEn ? "Suspended" : "معلّق"}</Badge>
                    )}
                  </div>
                  <div className="flex items-center flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
                    {member.phone && <span dir="ltr" className="inline-block tabular-nums">{member.phone}</span>}
                    <span>
                      {isEn ? "Active loans:" : "إعارات نشطة:"}{' '}
                      <span dir="ltr" className="inline-block tabular-nums">{activeLoansByMember(member.id)}</span>
                    </span>
                    {member.lateFees > 0 && (
                      <span className="text-destructive">
                        {isEn ? "Fines:" : "غرامات:"}{' '}
                        <span dir="ltr" className="inline-block tabular-nums">{formatNumber(member.lateFees)}</span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={isEn ? "Edit Member" : "تعديل العضو"}
                    onClick={() => {
                      setSelectedMember(member);
                      setMemberForm({ name: member.name, phone: member.phone, email: member.email, notes: member.notes });
                      setShowEditMember(true);
                    }}
                  >
                    <Edit className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    aria-label={isEn ? "Delete Member" : "حذف العضو"}
                    onClick={() => {
                      setSelectedMember(member);
                      setShowDeleteMember(true);
                    }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </TabsContent>

        {/* Loans Tab */}
        <TabsContent value="loans" className="space-y-2 mt-2">
          {isLoading ? (
            <div className="flex justify-center py-12"><div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" /></div>
          ) : filteredLoans.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
              <BookOpen className="w-12 h-12 text-muted-foreground/50 mb-3" />
              <p className="text-sm sm:text-base font-semibold text-foreground">{isEn ? "No loans yet" : "لا يوجد إعارات بعد"}</p>
            </div>
          ) : (
            filteredLoans.map(loan => (
              <div key={loan.id} className={cn(
                "bg-card rounded-xl border border-border p-4",
                isOverdue(loan) && "border-destructive/50"
              )}>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-foreground truncate">{loan.bookName}</p>
                      {getStatusBadge(isOverdue(loan) ? 'overdue' : loan.status)}
                    </div>
                    <div className="flex items-center flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
                      <span>{isEn ? "Member:" : "العضو:"} {loan.memberName}</span>
                      <span>
                        {isEn ? "Loaned:" : "الإعارة:"}{' '}
                        <span dir="ltr" className="inline-block tabular-nums">{loan.loanDate}</span>
                      </span>
                      <span className={cn(isOverdue(loan) && "text-destructive font-medium")}>
                        {isEn ? "Due:" : "الاسترداد:"}{' '}
                        <span dir="ltr" className="inline-block tabular-nums">{loan.dueDate}</span>
                      </span>
                    </div>
                    {loan.returnDate && (
                      <p className="text-xs text-success mt-0.5">
                        {isEn ? "Returned:" : "تم الإرجاع:"}{' '}
                        <span dir="ltr" className="inline-block tabular-nums">{loan.returnDate}</span>
                      </p>
                    )}
                  </div>
                  {loan.status === 'active' && (
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-10 sm:min-h-9"
                        onClick={() => {
                          setSelectedLoan(loan);
                          setReturnLateFee(0);
                          setShowReturnDialog(true);
                        }}
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> {isEn ? "Return" : "إرجاع"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-10 sm:min-h-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleMarkLost(loan)}
                      >
                        {isEn ? "Lost" : "مفقود"}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </TabsContent>
      </Tabs>

      {/* Add/Edit Member Dialog */}
      <Dialog open={showAddMember || showEditMember} onOpenChange={(open) => {
        if (!open && !isSaving) { setShowAddMember(false); setShowEditMember(false); }
      }}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
          onPointerDownOutside={(e) => { if (isSaving || isMemberFormDirty) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (isSaving || isMemberFormDirty) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle>{showEditMember ? (isEn ? 'Edit Member' : 'تعديل العضو') : (isEn ? 'New Member' : 'عضو جديد')}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium block">{isEn ? "Member Name *" : "اسم العضو *"}</label>
              <Input value={memberForm.name} onChange={(e) => setMemberForm(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium block">{isEn ? "Phone Number" : "رقم الهاتف"}</label>
              <Input dir="ltr" className="tabular-nums" value={memberForm.phone} onChange={(e) => setMemberForm(p => ({ ...p, phone: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium block">{isEn ? "Email" : "البريد الإلكتروني"}</label>
              <Input dir="ltr" value={memberForm.email} onChange={(e) => setMemberForm(p => ({ ...p, email: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium block">{isEn ? "Notes" : "ملاحظات"}</label>
              <Input value={memberForm.notes} onChange={(e) => setMemberForm(p => ({ ...p, notes: e.target.value }))} />
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button
              variant="outline"
              size="default"
              disabled={isSaving}
              onClick={() => { setShowAddMember(false); setShowEditMember(false); }}
            >
              {isEn ? "Cancel" : "إلغاء"}
            </Button>
            <Button
              variant="default"
              size="default"
              disabled={isSaving}
              onClick={showEditMember ? handleEditMember : handleAddMember}
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {showEditMember ? (isEn ? 'Update' : 'تحديث') : (isEn ? 'Add' : 'إضافة')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Loan Dialog */}
      <Dialog open={showAddLoan} onOpenChange={(open) => { if (!open && !isSaving) setShowAddLoan(false); }}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
          onPointerDownOutside={(e) => { if (isSaving || isLoanFormDirty) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (isSaving || isLoanFormDirty) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle>{isEn ? "Loan Book" : "إعارة كتاب"}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium block">{isEn ? "Book *" : "الكتاب *"}</label>
              <Select value={loanForm.productId} onValueChange={(v) => setLoanForm(p => ({ ...p, productId: v }))}>
                <SelectTrigger className="min-h-11 sm:min-h-10 rounded-[14px]"><SelectValue placeholder={isEn ? "Select a book" : "اختر كتاب"} /></SelectTrigger>
                <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
                  {books.map(b => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium block">{isEn ? "Member *" : "العضو *"}</label>
              <Select value={loanForm.memberId} onValueChange={(v) => setLoanForm(p => ({ ...p, memberId: v }))}>
                <SelectTrigger className="min-h-11 sm:min-h-10 rounded-[14px]"><SelectValue placeholder={isEn ? "Select a member" : "اختر عضو"} /></SelectTrigger>
                <SelectContent className="max-h-[min(20rem,60dvh)] overflow-y-auto">
                  {members.filter(m => m.membershipStatus === 'active').map(m => (
                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium block">{isEn ? "Due Date *" : "تاريخ الاسترداد *"}</label>
              <Input
                type="date"
                dir="ltr"
                className="tabular-nums"
                value={loanForm.dueDate}
                onChange={(e) => setLoanForm(p => ({ ...p, dueDate: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium block">{isEn ? "Notes" : "ملاحظات"}</label>
              <Input value={loanForm.notes} onChange={(e) => setLoanForm(p => ({ ...p, notes: e.target.value }))} />
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" size="default" disabled={isSaving} onClick={() => setShowAddLoan(false)}>
              {isEn ? "Cancel" : "إلغاء"}
            </Button>
            <Button variant="default" size="default" disabled={isSaving} onClick={handleAddLoan}>
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <BookOpen className="w-4 h-4" />}
              {isEn ? "Record Loan" : "تسجيل الإعارة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Return Loan Dialog */}
      <Dialog open={showReturnDialog} onOpenChange={(open) => { if (!open && !isSaving) setShowReturnDialog(false); }}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),28rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
          onPointerDownOutside={(e) => { if (isSaving || returnLateFee > 0) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (isSaving || returnLateFee > 0) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle>{isEn ? "Return Book" : "إرجاع كتاب"}</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {isEn ? "Book:" : "الكتاب:"} <strong>{selectedLoan?.bookName}</strong>
              <br />
              {isEn ? "Member:" : "العضو:"} <strong>{selectedLoan?.memberName}</strong>
            </p>
            {selectedLoan && isOverdue(selectedLoan) && (
              <div className="bg-destructive/10 rounded-xl p-3 text-sm text-destructive">
                <AlertTriangle className="w-4 h-4 inline me-1" />
                {isEn ? "This book is overdue!" : "هذا الكتاب متأخر عن موعد الاسترداد!"}
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium block">{isEn ? "Late Fee" : "غرامة التأخير"}</label>
              <Input
                type="number"
                dir="ltr"
                className="tabular-nums"
                value={returnLateFee}
                onChange={(e) => setReturnLateFee(Number(e.target.value))}
                min={0}
              />
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" size="default" disabled={isSaving} onClick={() => setShowReturnDialog(false)}>
              {isEn ? "Cancel" : "إلغاء"}
            </Button>
            <Button variant="default" size="default" disabled={isSaving} onClick={handleReturnLoan}>
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              {isEn ? "Confirm Return" : "تأكيد الإرجاع"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Member Confirm */}
      <AlertDialog open={showDeleteMember} onOpenChange={(open) => { if (!open && !isSaving) setShowDeleteMember(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isEn ? "Delete Member" : "حذف العضو"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isEn ? `Are you sure you want to delete member "${selectedMember?.name}"? All of their loans will also be deleted.` : `هل أنت متأكد من حذف العضو "${selectedMember?.name}"؟ سيتم حذف جميع إعاراته أيضاً.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>{isEn ? "Cancel" : "إلغاء"}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteMember}
              disabled={isSaving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
              {isEn ? "Delete" : "حذف"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
