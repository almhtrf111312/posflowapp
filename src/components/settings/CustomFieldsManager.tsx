import { isLocalDataMode } from '@/hooks/use-network-status';
import { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, GripVertical, ToggleLeft, ToggleRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogBody,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/lib/sonner-bridge';
import { useLanguage } from '@/hooks/use-language';
import type { TranslationKey } from '@/lib/i18n';
import {
  CustomField,
  CustomFieldType,
  loadCustomFields,
  addCustomField,
  updateCustomField,
  deleteCustomField,
  saveCustomFields,
  syncCustomFieldsFromCloud,
} from '@/lib/custom-fields-config';

interface CustomFieldsManagerProps {
  onFieldsChange?: () => void;
}

const fieldTypeTranslationKeys: Record<CustomFieldType, string> = {
  text: 'customFields.type.text',
  number: 'customFields.type.number',
  select: 'customFields.type.select',
};

export function CustomFieldsManager({ onFieldsChange }: CustomFieldsManagerProps) {
  const { t } = useLanguage();
  const [fields, setFields] = useState<CustomField[]>(() => loadCustomFields());

  useEffect(() => {
    if (isLocalDataMode()) return; // نعرض الحقول المحفوظة محلياً
    syncCustomFieldsFromCloud().then((cloudFields) => {
      if (cloudFields && cloudFields.length > 0) {
        setFields(cloudFields);
      }
    });
  }, []);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedField, setSelectedField] = useState<CustomField | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    type: 'text' as CustomFieldType,
    placeholder: '',
    required: false,
    enabled: true,
    options: '',
    showInTable: false,
    showInDetails: true,
  });

  const resetForm = () => {
    setFormData({
      name: '',
      type: 'text',
      placeholder: '',
      required: false,
      enabled: true,
      options: '',
      showInTable: false,
      showInDetails: true,
    });
  };

  const handleAddField = () => {
    if (!formData.name.trim()) {
      toast.error(t('customFields.toast.nameRequired' as TranslationKey));
      return;
    }

    const options = formData.type === 'select' && formData.options
      ? formData.options.split(',').map(o => o.trim()).filter(Boolean)
      : undefined;

    addCustomField({
      name: formData.name.trim(),
      type: formData.type,
      placeholder: formData.placeholder.trim() || undefined,
      required: formData.required,
      enabled: formData.enabled,
      options,
      showInTable: formData.showInTable,
      showInDetails: formData.showInDetails,
    });

    setFields(loadCustomFields());
    setShowAddDialog(false);
    resetForm();
    onFieldsChange?.();
    toast.success(t('customFields.toast.added' as TranslationKey));
  };

  const handleEditField = () => {
    if (!selectedField || !formData.name.trim()) {
      toast.error(t('customFields.toast.nameRequired' as TranslationKey));
      return;
    }

    const options = formData.type === 'select' && formData.options
      ? formData.options.split(',').map(o => o.trim()).filter(Boolean)
      : undefined;

    updateCustomField(selectedField.id, {
      name: formData.name.trim(),
      type: formData.type,
      placeholder: formData.placeholder.trim() || undefined,
      required: formData.required,
      enabled: formData.enabled,
      options,
      showInTable: formData.showInTable,
      showInDetails: formData.showInDetails,
    });

    setFields(loadCustomFields());
    setShowEditDialog(false);
    setSelectedField(null);
    resetForm();
    onFieldsChange?.();
    toast.success(t('customFields.toast.updated' as TranslationKey));
  };

  const handleDeleteField = () => {
    if (!selectedField) return;

    deleteCustomField(selectedField.id);
    setFields(loadCustomFields());
    setShowDeleteDialog(false);
    setSelectedField(null);
    onFieldsChange?.();
    toast.success(t('customFields.toast.deleted' as TranslationKey));
  };

  const handleToggleEnabled = (field: CustomField) => {
    updateCustomField(field.id, { enabled: !field.enabled });
    setFields(loadCustomFields());
    onFieldsChange?.();
  };

  const openEditDialog = (field: CustomField) => {
    setSelectedField(field);
    setFormData({
      name: field.name,
      type: field.type,
      placeholder: field.placeholder || '',
      required: field.required,
      enabled: field.enabled,
      options: field.options?.join(', ') || '',
      showInTable: field.showInTable,
      showInDetails: field.showInDetails,
    });
    setShowEditDialog(true);
  };

  const openDeleteDialog = (field: CustomField) => {
    setSelectedField(field);
    setShowDeleteDialog(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="font-medium text-foreground">{t('customFields.title' as TranslationKey)}</h4>
          <p className="text-sm text-muted-foreground">
            {t('customFields.subtitle' as TranslationKey)}
          </p>
        </div>
        <Button variant="default" size="default" onClick={() => setShowAddDialog(true)}>
          <Plus className="w-4 h-4 shrink-0" />
          {t('customFields.addField' as TranslationKey)}
        </Button>
      </div>

      {fields.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-2xl border border-dashed border-border/70 bg-muted/20">
          <p className="text-sm sm:text-base font-semibold text-foreground">
            {t('customFields.empty' as TranslationKey)}
          </p>
          <Button
            variant="default"
            size="default"
            className="mt-3"
            onClick={() => setShowAddDialog(true)}
          >
            <Plus className="w-4 h-4 shrink-0" />
            {t('customFields.addFirstField' as TranslationKey)}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((field) => (
            <div
              key={field.id}
              className="flex items-center justify-between p-3 bg-card rounded-lg border border-border/50"
            >
              <div className="flex items-center gap-3">
                <GripVertical className="w-4 h-4 text-muted-foreground/50" />
                <div>
                  <div className="font-medium text-foreground flex items-center gap-2">
                    {field.name}
                    <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
                      {t(fieldTypeTranslationKeys[field.type] as TranslationKey)}
                    </span>
                    {field.required && (
                      <span className="text-xs px-2 py-0.5 rounded bg-destructive/10 text-destructive">
                        {t('customFields.requiredBadge' as TranslationKey)}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground flex gap-2 mt-0.5">
                    {field.showInTable && <span>{t('customFields.badge.table' as TranslationKey)}</span>}
                    {field.showInDetails && <span>{t('customFields.badge.details' as TranslationKey)}</span>}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleToggleEnabled(field)}
                  title={field.enabled ? t('customFields.disable' as TranslationKey) : t('customFields.enable' as TranslationKey)}
                  aria-label={field.enabled ? t('customFields.disable' as TranslationKey) : t('customFields.enable' as TranslationKey)}
                >
                  {field.enabled ? (
                    <ToggleRight className="w-5 h-5 text-success" />
                  ) : (
                    <ToggleLeft className="w-5 h-5 text-muted-foreground" />
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => openEditDialog(field)}
                  aria-label={t('customFields.editDialog.title' as TranslationKey)}
                >
                  <Edit2 className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => openDeleteDialog(field)}
                  aria-label={t('customFields.actions.delete' as TranslationKey)}
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Field Dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
          onPointerDownOutside={(e) => { if (formData.name.trim()) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (formData.name.trim()) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle>{t('customFields.addDialog.title' as TranslationKey)}</DialogTitle>
            <DialogDescription>{t('customFields.addDialog.description' as TranslationKey)}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('customFields.form.nameLabel' as TranslationKey)}</label>
              <Input
                placeholder={t('customFields.form.namePlaceholder' as TranslationKey)}
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('customFields.form.typeLabel' as TranslationKey)}</label>
              <select
                className="w-full h-10 px-3 rounded-md bg-muted border-0 text-foreground"
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value as CustomFieldType })}
              >
                <option value="text">{t('customFields.type.text' as TranslationKey)}</option>
                <option value="number">{t('customFields.type.number' as TranslationKey)}</option>
                <option value="select">{t('customFields.type.select' as TranslationKey)}</option>
              </select>
            </div>
            {formData.type === 'select' && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">{t('customFields.form.optionsLabel' as TranslationKey)}</label>
                <Input
                  placeholder={t('customFields.form.optionsPlaceholder' as TranslationKey)}
                  value={formData.options}
                  onChange={(e) => setFormData({ ...formData, options: e.target.value })}
                />
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('customFields.form.placeholderLabel' as TranslationKey)}</label>
              <Input
                placeholder={t('customFields.form.placeholderExample' as TranslationKey)}
                value={formData.placeholder}
                onChange={(e) => setFormData({ ...formData, placeholder: e.target.value })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('customFields.form.required' as TranslationKey)}</span>
              <Switch
                checked={formData.required}
                onCheckedChange={(checked) => setFormData({ ...formData, required: checked })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('customFields.form.showInTable' as TranslationKey)}</span>
              <Switch
                checked={formData.showInTable}
                onCheckedChange={(checked) => setFormData({ ...formData, showInTable: checked })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('customFields.form.showInDetails' as TranslationKey)}</span>
              <Switch
                checked={formData.showInDetails}
                onCheckedChange={(checked) => setFormData({ ...formData, showInDetails: checked })}
              />
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" onClick={() => { setShowAddDialog(false); resetForm(); }}>
              {t('customFields.actions.cancel' as TranslationKey)}
            </Button>
            <Button onClick={handleAddField}>
              {t('customFields.actions.add' as TranslationKey)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Field Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent
          className="w-[min(calc(100vw-1.5rem),32rem)] max-h-[calc(100dvh-1.5rem)] flex flex-col p-0 overflow-hidden rounded-[24px]"
          onPointerDownOutside={(e) => { if (formData.name.trim()) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (formData.name.trim()) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0 px-4 pt-4 pb-3 sm:px-6 sm:pt-5 border-b border-border/60 text-start pe-12">
            <DialogTitle>{t('customFields.editDialog.title' as TranslationKey)}</DialogTitle>
            <DialogDescription>{t('customFields.editDialog.description' as TranslationKey)}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('customFields.form.nameLabel' as TranslationKey)}</label>
              <Input
                placeholder={t('customFields.form.namePlaceholder' as TranslationKey)}
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('customFields.form.typeLabel' as TranslationKey)}</label>
              <select
                className="w-full h-10 px-3 rounded-md bg-muted border-0 text-foreground"
                value={formData.type}
                onChange={(e) => setFormData({ ...formData, type: e.target.value as CustomFieldType })}
              >
                <option value="text">{t('customFields.type.text' as TranslationKey)}</option>
                <option value="number">{t('customFields.type.number' as TranslationKey)}</option>
                <option value="select">{t('customFields.type.select' as TranslationKey)}</option>
              </select>
            </div>
            {formData.type === 'select' && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">{t('customFields.form.optionsLabel' as TranslationKey)}</label>
                <Input
                  placeholder={t('customFields.form.optionsPlaceholder' as TranslationKey)}
                  value={formData.options}
                  onChange={(e) => setFormData({ ...formData, options: e.target.value })}
                />
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-1.5 block">{t('customFields.form.placeholderLabel' as TranslationKey)}</label>
              <Input
                placeholder={t('customFields.form.placeholderExample' as TranslationKey)}
                value={formData.placeholder}
                onChange={(e) => setFormData({ ...formData, placeholder: e.target.value })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('customFields.form.required' as TranslationKey)}</span>
              <Switch
                checked={formData.required}
                onCheckedChange={(checked) => setFormData({ ...formData, required: checked })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('customFields.form.showInTable' as TranslationKey)}</span>
              <Switch
                checked={formData.showInTable}
                onCheckedChange={(checked) => setFormData({ ...formData, showInTable: checked })}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t('customFields.form.showInDetails' as TranslationKey)}</span>
              <Switch
                checked={formData.showInDetails}
                onCheckedChange={(checked) => setFormData({ ...formData, showInDetails: checked })}
              />
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0 px-4 py-3 sm:px-6 border-t border-border/60">
            <Button variant="outline" onClick={() => { setShowEditDialog(false); setSelectedField(null); resetForm(); }}>
              {t('customFields.actions.cancel' as TranslationKey)}
            </Button>
            <Button onClick={handleEditField}>
              {t('customFields.actions.saveChanges' as TranslationKey)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('customFields.deleteDialog.title' as TranslationKey)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('customFields.deleteDialog.description' as TranslationKey).replace('{name}', selectedField?.name || '')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('customFields.actions.cancel' as TranslationKey)}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteField} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {t('customFields.actions.delete' as TranslationKey)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
