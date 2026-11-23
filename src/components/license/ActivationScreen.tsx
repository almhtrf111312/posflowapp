import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Lock, Key, MessageCircle, Loader2, CheckCircle, AlertCircle, LogOut } from 'lucide-react';
import { useLicense } from '@/hooks/use-license';
import { useLanguage } from '@/hooks/use-language';
import { useAuth } from '@/hooks/use-auth';
import { supabase } from '@/integrations/supabase/client';
import { ContactLinksSection } from '@/components/settings/ContactLinksSection';

export function ActivationScreen() {
  const { activateCode, checkLicense, isTrial, isExpired } = useLicense();
  const { t, direction, isRTL } = useLanguage();
  const { signOut, user } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [developerPhone, setDeveloperPhone] = useState<string>('');

  useEffect(() => {
    const fetchDeveloperPhone = async () => {
      try {
        const { data, error } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'developer_phone')
          .maybeSingle();
        if (!error && data?.value) {
          setDeveloperPhone(data.value);
        }
      } catch (err) {
        console.error('Failed to fetch developer phone:', err);
      }
    };
    fetchDeveloperPhone();
  }, []);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    await signOut();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) {
      setError(t('license.enterCode'));
      return;
    }
    setIsLoading(true);
    setError(null);
    const result = await activateCode(code.trim());
    setIsLoading(false);
    if (result.success) {
      setSuccess(true);
    } else {
      setError(result.error || t('license.invalidCode'));
    }
  };

  const formatCode = (value: string) => {
    let cleaned = value.replace(/[^a-zA-Z0-9-]/g, '').toUpperCase();
    if (cleaned.startsWith('HYPER-')) {
      const afterPrefix = cleaned.slice(6).replace(/-/g, '');
      const parts = afterPrefix.match(/.{1,4}/g) || [];
      return 'HYPER-' + parts.join('-');
    }
    cleaned = cleaned.replace(/-/g, '');
    const parts = cleaned.match(/.{1,4}/g) || [];
    return parts.join('-');
  };

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted = formatCode(e.target.value);
    setCode(formatted);
    setError(null);
  };

  const handleContactDeveloper = () => {
    navigate('/contact-developer', {
      state: {
        supportReason: isExpired ? 'expired' : 'activation_required',
        email: user?.email,
      },
    });
  };

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted p-4" dir={direction}>
        <Card className="w-full max-w-md shadow-xl">
          <CardContent className="pt-8 pb-8 text-center">
            <div className="w-16 h-16 bg-success/15 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle className="w-8 h-8 text-success" />
            </div>
            <h2 className="text-base sm:text-lg font-bold text-foreground tracking-tight mb-2">{t('license.activationSuccess')}</h2>
            <p className="text-muted-foreground mb-4">{t('license.canUseFullApp')}</p>
            <Button onClick={() => window.location.reload()} className="w-full">{t('license.continue')}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted p-4" dir={direction}>
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader className="text-center pb-2">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <Lock className="w-8 h-8 text-primary" />
          </div>
          <CardTitle>
            {isTrial && isExpired
              ? t('license.trialEnded')
              : isExpired
                ? t('license.licenseExpired')
                : t('license.activationRequired')
            }
          </CardTitle>
          <CardDescription>
            {isTrial && isExpired
              ? t('license.trialEndedDesc')
              : t('license.enterCodeToContinue')
            }
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* إدخال أكواد التفعيل اليدوية مُلغى: التفعيل يتم من لوحة الإدارة مباشرة، ثم يعيد العميل التحقق */}
          <Button
            type="button"
            className="w-full gap-2"
            disabled={isLoading}
            onClick={async () => {
              setIsLoading(true);
              try {
                await checkLicense();
              } finally {
                setIsLoading(false);
              }
            }}
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
            <span>{t('license.recheck')}</span>
          </Button>

          <div className="pt-4 border-t space-y-3">
            <p className="text-sm text-muted-foreground text-center">{t('license.getCodeContact')}</p>
            <ContactLinksSection />
            <Button type="button" variant="outline" className="w-full gap-2" onClick={handleContactDeveloper}>
              <MessageCircle className="w-4 h-4" />
              {t('license.contactDeveloper')}
            </Button>
            <Button variant="ghost" className="w-full text-muted-foreground hover:text-foreground gap-2" onClick={handleSignOut} disabled={isSigningOut}>
              {isSigningOut ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
              <span className="ms-2">{t('license.signOutOther')}</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
