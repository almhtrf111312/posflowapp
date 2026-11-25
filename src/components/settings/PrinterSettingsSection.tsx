import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Bluetooth,
  Check,
  Laptop,
  Loader2,
  Plus,
  Printer,
  RefreshCw,
  Unlink
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/language-context';
import type { PrinterConfig } from '@/lib/printer/printer-config';

/** Receipt print toggles as the parent screen keeps them. */
export type PrintSettingsValue = {
  autoPrint: boolean;
  showStoreName: boolean;
  showLogo: boolean;
  showAddress: boolean;
  showPhone: boolean;
  showEmail: boolean;
  showInvoiceNumber: boolean;
  showDateTime: boolean;
  showCashierName: boolean;
  showAlternativeCurrencies: boolean;
  welcomeMessage: string;
  footer: string;
  paperSize: string;
  copies: string;
};

export interface PrinterSettingsSectionProps {
  printerConfig: PrinterConfig;
  handleUpdatePrinterConfig: (patch: Partial<PrinterConfig>) => void;
  handleTestPrint: () => void;
  handleMainTestPrint: () => void;
  isTestingPrint: boolean;
  printSettings: PrintSettingsValue;
  setPrintSettings: React.Dispatch<React.SetStateAction<PrintSettingsValue>>;
  isPrinterConnected: boolean;
  setShowBtDialog: (show: boolean) => void;
  setShowUnpairDialog: (show: boolean) => void;
}

export function PrinterSettingsSection({
  printerConfig,
  handleUpdatePrinterConfig,
  handleTestPrint,
  handleMainTestPrint,
  isTestingPrint,
  printSettings,
  setPrintSettings,
  isPrinterConnected,
  setShowBtDialog,
  setShowUnpairDialog,
}: PrinterSettingsSectionProps) {
  const {t, isRTL, language } = useLanguage();
  const isEn = language === 'en';

  return (
          <div className="bg-muted/30 rounded-xl border border-border/50 p-4 space-y-5">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight mb-1">{t('settings.printing')}</h2>
              <p className="text-xs text-muted-foreground">{isEn ? "Customize receipt fields, visibility toggles, and secondary currencies for printing and sharing" : "تخصيص بنود وقالب الفاتورة، مفاتيح الإظهار، والعملات البديلة للطباعة والمشاركة"}</p>
            </div>

            {/* قسم إدارة الطابعة ونوع الاتصال المزدوج (بلوتوث vs سلكي) */}
            <div className="space-y-4 pt-1 border-t border-border/40">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Printer className="w-4 h-4 text-primary" />
                <span>{isEn ? "Printer Management & Dual Connection" : "إدارة الطابعة والاتصال المزدوج"}</span>
              </h3>

              {/* اختيار نوع الاتصال: بلوتوث حرارية أو سلكية / نظامية */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => handleUpdatePrinterConfig({ connectionType: 'bluetooth' })}
                  className={cn(
                    "p-3.5 rounded-xl border-2 text-start transition-all flex items-start gap-3 relative",
                    printerConfig.connectionType === 'bluetooth'
                      ? "border-primary bg-primary/10 shadow-xs"
                      : "border-border/60 bg-card hover:bg-muted/40"
                  )}
                >
                  <div className={cn(
                    "w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
                    printerConfig.connectionType === 'bluetooth' ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  )}>
                    <Bluetooth className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm text-foreground">{t('bluetoothThermalPrinter')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{isEn ? "For phones & tablets (ESC/POS thermal bitmap)" : "للهواتف والأجهزة اللوحية (ESC/POS حراري معالجة نقطية)"}</div>
                  </div>
                  {printerConfig.connectionType === 'bluetooth' && (
                    <Check className="w-4 h-4 text-primary absolute end-3 top-3.5" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => handleUpdatePrinterConfig({ connectionType: 'wired_system' })}
                  className={cn(
                    "p-3.5 rounded-xl border-2 text-start transition-all flex items-start gap-3 relative",
                    printerConfig.connectionType === 'wired_system'
                      ? "border-primary bg-primary/10 shadow-xs"
                      : "border-border/60 bg-card hover:bg-muted/40"
                  )}
                >
                  <div className={cn(
                    "w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5",
                    printerConfig.connectionType === 'wired_system' ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  )}>
                    <Laptop className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-sm text-foreground">{t('wiredSystemPrinter')}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{isEn ? "For PC & web via the system print dialog" : "للكمبيوتر والويب عبر نافذة الطباعة الافتراضية"}</div>
                  </div>
                  {printerConfig.connectionType === 'wired_system' && (
                    <Check className="w-4 h-4 text-primary absolute end-3 top-3.5" />
                  )}
                </button>
              </div>

              {/* بطاقة طابعة البلوتوث (حالات A, B, C) */}
              {printerConfig.connectionType === 'bluetooth' && (
                <div className="p-4 rounded-2xl border border-border/70 bg-card space-y-4 shadow-2xs">
                  {!printerConfig.deviceAddress ? (
                    /* حالة A: لا توجد طابعة مقترنة */
                    <div className="py-6 flex flex-col items-center justify-center text-center space-y-3">
                      <div className="w-14 h-14 rounded-2xl bg-primary/10 text-primary flex items-center justify-center">
                        <Bluetooth className="w-7 h-7" />
                      </div>
                      <div className="space-y-1">
                        <h4 className="text-sm font-bold text-foreground">
                          {t('noPrinterSelected') || 'ما في طابعة بلوتوث محفوظة بعد'}
                        </h4>
                        <p className="text-xs text-muted-foreground max-w-xs">
                          {isEn ? "Connect a Bluetooth thermal receipt printer for instant printing after every sale" : "اربط طابعة إيصالات حرارية عبر البلوتوث للطباعة المباشرة السريعة بعد كل عملية بيع"}
                        </p>
                      </div>
                      <Button
                        type="button"
                        onClick={() => setShowBtDialog(true)}
                        className="w-full sm:w-auto px-6"
                      >
                        <Plus className="w-4 h-4 shrink-0" />
                        <span>{t('printer.add') || 'إضافة طابعة بلوتوث'}</span>
                      </Button>
                    </div>
                  ) : (
                    /* حالة B: طابعة محفوظة */
                    <div className="space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/40">
                        <div className="flex items-center gap-3">
                          <div className="w-11 h-11 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                            <Printer className="w-5 h-5" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-sm text-foreground">
                                {printerConfig.deviceName || 'Bluetooth Thermal Printer'}
                              </span>
                              <Badge
                                variant="outline"
                                className={cn(
                                  isPrinterConnected
                                    ? "bg-success/15 text-success border-success/30"
                                    : "bg-muted text-muted-foreground border-border/50"
                                )}
                              >
                                <span className={cn("w-1.5 h-1.5 rounded-full inline-block me-1", isPrinterConnected ? "bg-success" : "bg-muted-foreground")}></span>
                                {isPrinterConnected ? (t('printer.connected') || 'متصلة') : (t('printer.notConnected') || 'غير متصلة')}
                              </Badge>
                            </div>
                            <span className="font-mono text-xs text-muted-foreground block mt-0.5">
                              MAC: ...{printerConfig.deviceAddress.slice(-5)}
                            </span>
                          </div>
                        </div>

                        {/* اختيار عرض الورق */}
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-muted-foreground">
                            {t('printer.paperWidth') || 'عرض الورق'}:
                          </span>
                          <div className="flex items-center gap-1 p-0.5 bg-muted/70 rounded-lg border border-border/50">
                            <button
                              type="button"
                              onClick={() => handleUpdatePrinterConfig({ paperWidth: '58mm' })}
                              className={cn(
                                "px-2.5 py-1 text-xs font-bold rounded-md transition-colors",
                                printerConfig.paperWidth === '58mm' ? "bg-card text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
                              )}
                            >
                              58mm
                            </button>
                            <button
                              type="button"
                              onClick={() => handleUpdatePrinterConfig({ paperWidth: '80mm' })}
                              className={cn(
                                "px-2.5 py-1 text-xs font-bold rounded-md transition-colors",
                                (printerConfig.paperWidth || '80mm') === '80mm' ? "bg-card text-foreground shadow-2xs" : "text-muted-foreground hover:text-foreground"
                              )}
                            >
                              80mm
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* أزرار الإجراءات */}
                      <div className="flex flex-col sm:flex-row items-center gap-2">
                        <Button
                          type="button"
                          onClick={handleMainTestPrint}
                          disabled={isTestingPrint}
                          className="w-full sm:flex-1 h-9 gap-2 font-bold"
                        >
                          {isTestingPrint ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>{t('printer.printingTest') || 'جاري الطباعة…'}</span>
                            </>
                          ) : (
                            <>
                              <Printer className="w-4 h-4" />
                              <span>{t('printer.testPrint') || 'طباعة تجريبية'}</span>
                            </>
                          )}
                        </Button>

                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setShowBtDialog(true)}
                          disabled={isTestingPrint}
                          className="w-full sm:w-auto h-9 gap-1.5"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>{t('printer.change') || 'تغيير الطابعة'}</span>
                        </Button>

                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setShowUnpairDialog(true)}
                          disabled={isTestingPrint}
                          className="w-full sm:w-auto h-9 text-destructive hover:bg-destructive/10 gap-1.5"
                        >
                          <Unlink className="w-3.5 h-3.5" />
                          <span>{t('printer.unpair') || 'فصل الطابعة'}</span>
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* مقاس الورق ومفتاح الطباعة التلقائية */}
              <div className="flex items-center justify-between py-2 border-b border-border/30">
                <div>
                  <span className="text-sm font-medium block">{t('settings.autoPrint')}</span>
                  <span className="text-xs text-muted-foreground">{isEn ? "Automatically print receipt upon completing a sale" : "طباعة الإيصال تلقائياً فور تأكيد البيع"}</span>
                </div>
                <Switch
                  checked={printSettings.autoPrint}
                  onCheckedChange={(checked) => {
                    setPrintSettings({ ...printSettings, autoPrint: checked });
                    handleUpdatePrinterConfig({ autoPrintAfterSale: checked });
                  }}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium text-foreground w-24 shrink-0">{t('settings.paperSize')}</label>
                  <select
                    value={printerConfig.paperWidth || printSettings.paperSize || '80mm'}
                    onChange={(e) => {
                      // The options below offer only the paper widths of PrinterConfig.
                      const val = e.target.value as PrinterConfig['paperWidth'];
                      setPrintSettings({ ...printSettings, paperSize: val });
                      handleUpdatePrinterConfig({ paperWidth: val });
                    }}
                    className="flex-1 h-9 px-3 rounded-lg bg-card border border-border/60 text-foreground text-sm"
                  >
                    <option value="58mm">{isEn ? "58mm (Compact Printer)" : "58mm (طابعة صغيرة)"}</option>
                    <option value="80mm">{isEn ? "80mm (Standard Printer)" : "80mm (طابعة قياسية)"}</option>
                    <option value="A4">{isEn ? "A4 (Standard Paper)" : "A4 (ورق قياسي)"}</option>
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium text-foreground w-24 sm:w-20 shrink-0">{t('settings.copies')}</label>
                  <Input
                    type="number"
                    value={printSettings.copies}
                    onChange={(e) => setPrintSettings({ ...printSettings, copies: e.target.value })}
                    min="1"
                    max="5"
                    className="bg-card border border-border/60 h-9 flex-1"
                  />
                </div>
              </div>
            </div>

            {/* تخصيص بنود الفاتورة */}
            <div className="space-y-3 pt-3 border-t border-border/40">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{isEn ? "Receipt Fields & Details" : "تخصيص بنود وبيانات الفاتورة"}</h3>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div className="flex items-center justify-between p-2.5 rounded-lg bg-card/60 border border-border/40">
                  <span className="text-sm font-medium">{isEn ? "Show Store Name" : "إظهار اسم المتجر"}</span>
                  <Switch
                    checked={printSettings.showStoreName}
                    onCheckedChange={(checked) => setPrintSettings({ ...printSettings, showStoreName: checked })}
                  />
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-card/60 border border-border/40">
                  <span className="text-sm font-medium">{isEn ? "Show Logo" : "إظهار الشعار (Logo)"}</span>
                  <Switch
                    checked={printSettings.showLogo}
                    onCheckedChange={(checked) => setPrintSettings({ ...printSettings, showLogo: checked })}
                  />
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-card/60 border border-border/40">
                  <span className="text-sm font-medium">{isEn ? "Show Address" : "إظهار العنوان"}</span>
                  <Switch
                    checked={printSettings.showAddress}
                    onCheckedChange={(checked) => setPrintSettings({ ...printSettings, showAddress: checked })}
                  />
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-card/60 border border-border/40">
                  <span className="text-sm font-medium">{isEn ? "Show Phone Number" : "إظهار رقم الهاتف"}</span>
                  <Switch
                    checked={printSettings.showPhone}
                    onCheckedChange={(checked) => setPrintSettings({ ...printSettings, showPhone: checked })}
                  />
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-card/60 border border-border/40">
                  <span className="text-sm font-medium">{isEn ? "Show Email" : "إظهار البريد الإلكتروني"}</span>
                  <Switch
                    checked={printSettings.showEmail}
                    onCheckedChange={(checked) => setPrintSettings({ ...printSettings, showEmail: checked })}
                  />
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-card/60 border border-border/40">
                  <span className="text-sm font-medium">{isEn ? "Show Invoice Number" : "إظهار رقم الفاتورة"}</span>
                  <Switch
                    checked={printSettings.showInvoiceNumber}
                    onCheckedChange={(checked) => setPrintSettings({ ...printSettings, showInvoiceNumber: checked })}
                  />
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-card/60 border border-border/40">
                  <span className="text-sm font-medium">{isEn ? "Show Date & Time" : "إظهار التاريخ والوقت"}</span>
                  <Switch
                    checked={printSettings.showDateTime}
                    onCheckedChange={(checked) => setPrintSettings({ ...printSettings, showDateTime: checked })}
                  />
                </div>

                <div className="flex items-center justify-between p-2.5 rounded-lg bg-card/60 border border-border/40">
                  <span className="text-sm font-medium">{isEn ? "Show Cashier / Seller Name" : "إظهار اسم الكاشير / البائع"}</span>
                  <Switch
                    checked={printSettings.showCashierName}
                    onCheckedChange={(checked) => setPrintSettings({ ...printSettings, showCashierName: checked })}
                  />
                </div>
              </div>
            </div>

            {/* معادلات العملات البديلة في الفاتورة */}
            <div className="space-y-3 pt-3 border-t border-border/40">
              <div className="flex items-center justify-between p-3 rounded-lg bg-card/70 border border-primary/20">
                <div>
                  <span className="text-sm font-bold block text-foreground">{isEn ? "Show Total in Secondary Currencies" : "إظهار المجموع بالعملات البديلة"}</span>
                  <span className="text-xs text-muted-foreground">
                    {isEn ? "Automatically calculate and display equivalent totals (e.g. SYP, TRY) below the invoice total for printing and sharing only" : "احتساب وعرض المعادل تلقائياً (مثل SYP و TRY) تحت إجمالي الفاتورة لأغراض الطباعة والمشاركة فقط"}
                  </span>
                </div>
                <Switch
                  checked={printSettings.showAlternativeCurrencies}
                  onCheckedChange={(checked) => setPrintSettings({ ...printSettings, showAlternativeCurrencies: checked })}
                />
              </div>
            </div>

            {/* نصوص الفاتورة */}
            <div className="space-y-3 pt-3 border-t border-border/40">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{isEn ? "Receipt Messages & Footer" : "رسائل ونصوص الفاتورة"}</h3>
              
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground block">{isEn ? "Header Welcome Message" : "الكلمة الترحيبية (أعلى الفاتورة)"}</label>
                <Input
                  value={printSettings.welcomeMessage}
                  onChange={(e) => setPrintSettings({ ...printSettings, welcomeMessage: e.target.value })}
                  placeholder={isEn ? "e.g., Welcome to our store" : "مثال: أهلاً وسهلاً بكم في متجرنا"}
                  className="bg-card border border-border/60 h-9"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground block">{t('settings.receiptFooter')} {isEn ? '(Receipt Footer)' : '(خاتمة الفاتورة)'}</label>
                <Input
                  value={printSettings.footer}
                  onChange={(e) => setPrintSettings({ ...printSettings, footer: e.target.value })}
                  placeholder={isEn ? "e.g., Thank you for shopping with us!" : "مثال: شكراً لتسوقكم معنا! بضاعتكم أمانة لدينا"}
                  className="bg-card border border-border/60 h-9"
                />
              </div>
            </div>

            <div className="pt-2">
              <Button variant="outline" size="sm" onClick={handleTestPrint} className="w-full sm:w-auto">
                <Printer className="w-4 h-4" />
                {t('settings.testPrint')}
              </Button>
            </div>
          </div>
  );
}

export default PrinterSettingsSection;
