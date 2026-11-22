import { useLanguage } from '@/hooks/use-language';
import { useState, useEffect, useCallback } from 'react';
import { Plus, Edit, Trash2, X, Save, Tag, Loader2 } from 'lucide-react';
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
  inline?: boolean; // ط¹ط±ط¶ ظƒطµظپط­ط© ط¯ط§ط®ظ„ ط§ظ„ط´ط§ط´ط© ط¨ط¯ظ„ ظ†ط§ظپط°ط© ط¹ط§ط¦ظ…ط©
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
      toast.error(isEn ? 'Please enter a category name' : 'ظٹط±ط¬ظ‰ ط¥ط¯ط®ط§ظ„ ط§ط³ظ… ط§ظ„طھطµظ†ظٹظپ');
      return;
    }
    
    // Check for duplicate (case-insensitive and trimmed)
    const norm = name.toLowerCase();
    if (categories.some(c => c.name.trim().toLowerCase() === norm)) {
      toast.error(isEn ? 'This category already exists' : 'ظ‡ط°ط§ ط§ظ„طھطµظ†ظٹظپ ظ…ظˆط¬ظˆط¯ ط¨ط§ظ„ظپط¹ظ„');
      return;
    }
    
    setIsSaving(true);
    const newCategory = await addCategoryCloud(name);
    setIsSaving(false);
    
    if (newCategory) {
      setNewCategoryName('');
      onCategoriesChange?.();
      toast.success(isEn ? 'Category added successfully' : 'طھظ… ط¥ط¶ط§ظپط© ط§ظ„طھطµظ†ظٹظپ ط¨ظ†ط¬ط§ط­');
      loadData();
      if (!inline) onClose();
    } else {
      toast.error(isEn ? 'Failed to add category' : 'ظپط´ظ„ ظپظٹ ط¥ط¶ط§ظپط© ط§ظ„طھطµظ†ظٹظپ');
    }
  };

  const handleEditCategory = async () => {
    if (!editingCategory) return;
    
    const name = editName.trim();
    if (!name) {
      toast.error(isEn ? 'Please enter a category name' : 'ظٹط±ط¬ظ‰ ط¥ط¯ط®ط§ظ„ ط§ط³ظ… ط§ظ„طھطµظ†ظٹظپ');
      return;
    }
    
    // Check for duplicate (excluding current)
    const norm = name.toLowerCase();
    if (categories.some(c => c.name.trim().toLowerCase() === norm && c.id !== editingCategory.id)) {
      toast.error(isEn ? 'This category already exists' : 'ظ‡ط°ط§ ط§ظ„طھطµظ†ظٹظپ ظ…ظˆط¬ظˆط¯ ط¨ط§ظ„ظپط¹ظ„');
      return;
    }
    
    setIsSaving(true);
    const success = await updateCategoryCloud(editingCategory.id, name);
    setIsSaving(false);
    
    if (success) {
      setEditingCategory(null);
      setEditName('');
      onCategoriesChange?.();
      toast.success(isEn ? 'Category updated successfully' : 'طھظ… طھط¹ط¯ظٹظ„ ط§ظ„طھطµظ†ظٹظپ ط¨ظ†ط¬ط§ط­');
      loadData();
    } else {
      toast.error(isEn ? 'Failed to update category' : 'ظپط´ظ„ ظپظٹ طھط¹ط¯ظٹظ„ ط§ظ„طھطµظ†ظٹظپ');
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
      toast.success(isEn ? 'Category deleted successfully' : 'طھظ… ط­ط°ظپ ط§ظ„طھطµظ†ظٹظپ ط¨ظ†ط¬ط§ط­');
      loadData();
    } else {
      toast.error(isEn ? 'Failed to delete category' : 'ظپط´ظ„ ظپظٹ ط­ط°ظپ ط§ظ„طھطµظ†ظٹظپ');
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

  return (
    <>
      {inline ? (
        <div className="space-y-3">
          {/* Add new category */}
          <div className="flex gap-2 p-2 bg-muted rounded-lg">
            <Input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder={isEn ? "New category name..." : "ط§ط³ظ… ط§ظ„طھطµظ†ظٹظپ ط§ظ„ط¬ط¯ظٹط¯..."}
              className="flex-1"
              onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
              disabled={isSaving}
            />
            <Button onClick={handleAddCategory} size="icon" disabled={isSaving} className="bg-gradient-primary hover:brightness-105 active:scale-95 text-primary-foreground shadow-sm">
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
              <>
                {categories.map((category) => (
                  <div 
                    key={category.id}
                    className="flex items-center justify-between p-3 bg-card border rounded-lg"
                  >
                    {editingCategory?.id === category.id ? (
                      <div className="flex gap-2 flex-1">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="flex-1"
                          autoFocus
                          onKeyDown={(e) => e.key === 'Enter' && handleEditCategory()}
                          disabled={isSaving}
                        />
                        <Button size="icon" variant="ghost" onClick={handleEditCategory} disabled={isSaving}>
                          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 text-green-600" />}
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => setEditingCategory(null)} disabled={isSaving}>
                          <X className="w-4 h-4 text-red-600" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <Tag className="w-4 h-4 text-muted-foreground" />
                          <span className="font-medium">{category.name}</span>
                          {isCategoryInUse(category.name) && (
                            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                              {isEn ? "In use" : "ظ…ط³طھط®ط¯ظ…"}
                            </span>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => startEdit(category)}
                            className="h-8 w-8"
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setDeleteCategory(category)}
                            className="h-8 w-8 text-red-600 hover:text-red-700"
                            disabled={isCategoryInUse(category.name)}
                            title={isCategoryInUse(category.name) ? (isEn ? 'Cannot delete a category in use' : 'ظ„ط§ ظٹظ…ظƒظ† ط­ط°ظپ طھطµظ†ظٹظپ ظ…ط³طھط®ط¯ظ…') : ''}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
                
                {categories.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <Tag className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>{isEn ? "No categories yet" : "ظ„ط§ طھظˆط¬ط¯ طھطµظ†ظٹظپط§طھ"}</p>
                  </div>
                )}
              </>
            )}
          </div>

        </div>
      ) : (
      <Sheet open={isOpen} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="bottom" className="max-h-[85vh] max-h-[85dvh] sm:max-w-lg sm:mx-auto rounded-t-2xl sm:rounded-2xl p-0 flex flex-col overflow-hidden bg-background border-border shadow-2xl">
          <SheetHeader className="p-4 border-b border-border/50 shrink-0 bg-muted/20">
            <SheetTitle className="flex items-center gap-2 text-base font-bold text-foreground">
              <Tag className="w-5 h-5 text-primary" />
              {isEn ? "Manage Categories" : "ط¥ط¯ط§ط±ط© ط§ظ„طھطµظ†ظٹظپط§طھ"}
            </SheetTitle>
          </SheetHeader>

          {/* Add new category */}
          <div className="flex gap-2 p-2 bg-muted rounded-lg">
            <Input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder={isEn ? "New category name..." : "ط§ط³ظ… ط§ظ„طھطµظ†ظٹظپ ط§ظ„ط¬ط¯ظٹط¯..."}
              className="flex-1"
              onKeyDown={(e) => e.key === 'Enter' && handleAddCategory()}
              disabled={isSaving}
            />
            <Button onClick={handleAddCategory} size="icon" disabled={isSaving} className="bg-gradient-primary hover:brightness-105 active:scale-95 text-primary-foreground shadow-sm">
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            </Button>
          </div>

          {/* Categories list */}
          <div className="flex-1 overflow-y-auto space-y-2 py-2">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {categories.map((category) => (
                  <div 
                    key={category.id}
                    className="flex items-center justify-between p-3 bg-card border rounded-lg"
                  >
                    {editingCategory?.id === category.id ? (
                      <div className="flex gap-2 flex-1">
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="flex-1"
                          autoFocus
                          onKeyDown={(e) => e.key === 'Enter' && handleEditCategory()}
                          disabled={isSaving}
                        />
                        <Button size="icon" variant="ghost" onClick={handleEditCategory} disabled={isSaving}>
                          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 text-green-600" />}
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => setEditingCategory(null)} disabled={isSaving}>
                          <X className="w-4 h-4 text-red-600" />
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <Tag className="w-4 h-4 text-muted-foreground" />
                          <span className="font-medium">{category.name}</span>
                          {isCategoryInUse(category.name) && (
                            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                              {isEn ? "In use" : "ظ…ط³طھط®ط¯ظ…"}
                            </span>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => startEdit(category)}
                            className="h-8 w-8"
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setDeleteCategory(category)}
                            className="h-8 w-8 text-red-600 hover:text-red-700"
                            disabled={isCategoryInUse(category.name)}
                            title={isCategoryInUse(category.name) ? (isEn ? 'Cannot delete a category in use' : 'ظ„ط§ ظٹظ…ظƒظ† ط­ط°ظپ طھطµظ†ظٹظپ ظ…ط³طھط®ط¯ظ…') : ''}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
                
                {categories.length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    <Tag className="w-12 h-12 mx-auto mb-2 opacity-50" />
                    <p>{isEn ? "No categories yet" : "ظ„ط§ طھظˆط¬ط¯ طھطµظ†ظٹظپط§طھ"}</p>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="pt-2 border-t">
            <Button variant="outline" onClick={onClose} className="w-full">
              {isEn ? "Close" : "ط¥ط؛ظ„ط§ظ‚"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteCategory} onOpenChange={() => setDeleteCategory(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{isEn ? "Delete Category" : "ط­ط°ظپ ط§ظ„طھطµظ†ظٹظپ"}</AlertDialogTitle>
            <AlertDialogDescription>
              {isEn ? `Are you sure you want to delete category "${deleteCategory?.name}"?` : `ظ‡ظ„ ط£ظ†طھ ظ…طھط£ظƒط¯ ظ…ظ† ط­ط°ظپ ط§ظ„طھطµظ†ظٹظپ "${deleteCategory?.name}"طں`}
              <br />
              {isEn ? "This action cannot be undone." : "ظ„ط§ ظٹظ…ظƒظ† ط§ظ„طھط±ط§ط¬ط¹ ط¹ظ† ظ‡ط°ط§ ط§ظ„ط¥ط¬ط±ط§ط،."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel disabled={isSaving}>{isEn ? "Cancel" : "ط¥ظ„ط؛ط§ط،"}</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDeleteCategory}
              className="bg-red-600 hover:bg-red-700"
              disabled={isSaving}
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {isEn ? "Delete" : "ط­ط°ظپ"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
