import { useLanguage } from '@/hooks/language-context';
import { useState, useEffect, useCallback } from 'react';
import { Plus, Edit, Trash2, X, Save, Tag, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import { 
  loadCategoriesCloud, 
  addCategoryCloud,
  updateCategoryCloud,
  deleteCategoryCloud,
  Category 
} from '@/lib/cloud/categories-cloud';

interface CategoryManagerProps {
  isOpen: boolean;
  onClose: () => void;
  onCategoriesChange?: () => void;
  usedCategories?: string[]; // Categories that are in use and cannot be deleted
  inline?: boolean; // عرض كصفحة داخل الشاشة بدل نافذة عائمة
}

export function CategoryManager({
  isOpen, 
  onClose, 
  onCategoriesChange,
  usedCategories = [],
  inline = false
}: CategoryManagerProps) {
  const { language } = useLanguage();
  const isEn = language === 'en';
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [editName, setEditName] = useState('');
  const [deleteCategory, setDeleteCategory] = useState<Category | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const cats = await loadCategoriesCloud();
      // Ensure local state is completely deduplicated
      const unique: Category[] = [];
      const seen = new Set<string>();
      for (const c of cats) {
        const norm = c.name.trim().toLowerCase();
        if (!seen.has(norm)) {
          seen.add(norm);
          unique.push(c);
        }
      }
      setCategories(unique);
    } catch (error) {
      console.error('Error loading categories:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen, loadData]);

  const handleAddCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) {
      toast.error(isEn ? 'Please enter a category name' : 'يرجى إدخال اسم التصنيف');
      return;
    }
    
    // Check for duplicate (case-insensitive and trimmed)
    const norm = name.toLowerCase();
    if (categories.some(c => c.name.trim().toLowerCase() === norm)) {
      toast.error(isEn ? 'This category already exists' : 'هذا التصنيف موجود بالفعل');
      return;
    }
    
    setIsSaving(true);
    const newCategory = await addCategoryCloud(name);
    setIsSaving(false);
    
    if (newCategory) {
      setNewCategoryName('');
      onCategoriesChange?.();
      toast.success(isEn ? 'Category added successfully' : 'تم إضافة التصنيف بنجاح');
      loadData();
      if (!inline) onClose();
    } else {
      toast.error(isEn ? 'Failed to add category' : 'فشل في إضافة التصنيف');
    }
  };

  const handleEditCategory = async () => {
    if (!editingCategory) return;
    
    const name = editName.trim();
    if (!name) {
      toast.error(isEn ? 'Please enter a category name' : 'يرجى إدخال اسم التصنيف');
      return;
    }
    
    // Check for duplicate (excluding current)
    const norm = name.toLowerCase();
    if (categories.some(c => c.name.trim().toLowerCase() === norm && c.id !== editingCategory.id)) {
      toast.error(isEn ? 'This category already exists' : 'هذا التصنيف موجود بالفعل');
      return;
    }
    
    setIsSaving(true);
    const success = await updateCategoryCloud(editingCategory.id, name);
    setIsSaving(false);
    
    if (success) {
      setEditingCategory(null);
      setEditName('');
      onCategoriesChange?.();
      toast.success(isEn ? 'Category updated successfully' : 'تم تعديل التصنيف بنجاح');
      loadData();
    } else {
      toast.error(isEn ? 'Failed to update category' : 'فشل في تعديل التصنيف');
    }
  };

  const handleDeleteCategory = async () => {
    if (!deleteCategory) return;
    
    setIsSaving(true);
    const success = await deleteCategoryCloud(deleteCategory.id);
    setIsSaving(false);
    
    if (success) {
      setDeleteCategory(null);
      onCategoriesChange?.();
      toast.success(isEn ? 'Category deleted successfully' : 'تم حذف التصنيف بنجاح');
      loadData();
    } else {
      toast.error(isEn ? 'Failed to delete category' : 'فشل في حذف التصنيف');
    }
  };

  const startEdit = (category: Category) => {
    setEditingCategory(category);
    setEditName(category.name);
  };

  const isCategoryInUse = (categoryName: string) => {
    const norm = categoryName.trim().toLowerCase();
    return usedCategories.some(uc => (uc || '').trim().toLowerCase() === norm);
  };

  const renderCategoryRows = () => (
    <>
      {categories.map((category) => (
        <div
          key={category.id}
          className="flex items-center justify-between gap-2 p-3 bg-card border border-border rounded-xl"
        >
          {editingCategory?.id === category.id ? (
            <div className="flex items-center gap-2 flex-1">
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="flex-1"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleEditCategory()}
                disabled={isSaving}
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={handleEditCategory}
                disabled={isSaving}
                className="text-success hover:text-success hover:bg-success/10"
                aria-label={isEn ? "Save" : "حفظ"}
              >
                {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => setEditingCategory(null)}
                disabled={isSaving}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                aria-label={isEn ? "Cancel" : "إلغاء"}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 min-w-0">
                <Tag className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="font-medium truncate">{category.name}</span>
                {isCategoryInUse(category.name) && (
                  <Badge variant="secondary">
                    {isEn ? "In use" : "مستخدم"}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => startEdit(category)}
                  aria-label={isEn ? "Edit" : "تعديل"}
                >
                  <Edit className="w-4 h-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setDeleteCategory(category)}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  disabled={isCategoryInUse(category.name)}
                  aria-label={isEn ? "Delete" : "حذف"}
                  title={isCategoryInUse(category.name) ? (isEn ? 'Cannot delete a category in use' : 'لا يمكن حذف تصنيف مستخدم') : ''}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </>
          )}
        </div>
      ))}

      {categories.length === 0 && (
        <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
          <Tag className="w-12 h-12 text-muted-foreground/50 mb-3" />
          <p className="text-sm sm:text-base font-semibold text-foreground">
            {isEn ? "No categories yet" : "لا توجد تصنيفات"}
          </p>
        </div>
      )}
    </>
  );

  return (
    <>
      {inline ? (
        <div className="space-y-3">
          {/* Add new category */}
          <div className="flex items-center gap-2 p-2 bg-muted rounded-xl">
            <Input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder={isEn ? "New category name..." : "اسم التصنيف الجديد..."}
              className="flex-1"
              onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
              disabled={isSaving}
            />
            <Button
              onClick={handleAddCategory}
              size="icon"
              disabled={isSaving}
              aria-label={isEn ? "Add category" : "إضافة تصنيف"}
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            </Button>
          </div>

          {/* Categories list */}
          <div className="space-y-2 py-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              renderCategoryRows()
            )}
          </div>
        </div>
      ) : (
        <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
          <SheetContent side="bottom" className="max-h-[85dvh] sm:max-w-lg sm:mx-auto rounded-t-[24px] sm:rounded-[24px] p-0 flex flex-col overflow-hidden bg-background border-border shadow-2xl">
            <SheetHeader className="px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 shrink-0 bg-muted/20 text-start pe-12">
              <SheetTitle className="flex items-center gap-2 text-base sm:text-lg font-semibold text-foreground">
                <Tag className="w-5 h-5 text-primary shrink-0" />
                {isEn ? "Manage Categories" : "إدارة التصنيفات"}
              </SheetTitle>
            </SheetHeader>

            {/* Body */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 sm:px-6 space-y-3">
              {/* Add new category */}
              <div className="flex items-center gap-2 p-2 bg-muted rounded-xl">
                <Input
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder={isEn ? "New category name..." : "اسم التصنيف الجديد..."}
                  className="flex-1"
                  onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
                  disabled={isSaving}
                />
                <Button
                  onClick={handleAddCategory}
                  size="icon"
                  disabled={isSaving}
                  aria-label={isEn ? "Add category" : "إضافة تصنيف"}
                >
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                </Button>
              </div>

              {/* Categories list */}
              <div className="space-y-2">
                {isLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  renderCategoryRows()
                )}
              </div>
            </div>

            <div className="shrink-0 px-4 py-3 sm:px-6 pb-[max(1rem,env(safe-area-inset-bottom,0px))] border-t border-border/60">
              <Button variant="outline" onClick={onClose} className="w-full">
                {isEn ? "Close" : "إغلاق"}
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteCategory} onOpenChange={() => setDeleteCategory(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isEn ? "Delete Category" : "حذف التصنيف"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isEn ? `Are you sure you want to delete category "${deleteCategory?.name}"?` : `هل أنت متأكد من حذف التصنيف "${deleteCategory?.name}"؟`}
              <br />
              {isEn ? "This action cannot be undone." : "لا يمكن التراجع عن هذا الإجراء."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>{isEn ? "Cancel" : "إلغاء"}</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDeleteCategory}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isSaving}
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {isEn ? "Delete" : "حذف"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
