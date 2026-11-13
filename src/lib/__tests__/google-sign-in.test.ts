import { describe, it, expect, vi, beforeEach } from 'vitest';

const platform = { native: false, name: 'web' };
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => platform.native, getPlatform: () => platform.name },
  registerPlugin: () => ({ signIn: vi.fn(), signOut: vi.fn() }),
}));
const roleRow: { value: { role: string } | null } = { value: null };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: roleRow.value, error: null }) }) }) }),
    auth: { signInWithOAuth: vi.fn(async () => ({ error: null })) },
  },
}));

import { isGoogleSignInAvailable, checkGoogleAccountAllowed, googleErrorMessage, isValidSignupPhone, isGoogleOnlyUser } from '../auth/google-sign-in';

describe('google sign-in (removable module)', () => {
  beforeEach(() => { platform.native = false; platform.name = 'web'; roleRow.value = null; });

  it('shows on web', () => {
    expect(isGoogleSignInAvailable()).toBe(true);
  });

  it('hidden on iOS native', () => {
    platform.native = true; platform.name = 'ios';
    expect(isGoogleSignInAvailable()).toBe(false);
  });

  it('rejects a Google account with no store', async () => {
    expect(await checkGoogleAccountAllowed('u1')).toEqual({ allowed: false, reason: 'no_account' });
  });

  it('allows owner, rejects cashier by default', async () => {
    roleRow.value = { role: 'admin' };
    expect((await checkGoogleAccountAllowed('u1')).allowed).toBe(true);
    roleRow.value = { role: 'cashier' };
    expect(await checkGoogleAccountAllowed('u1')).toEqual({ allowed: false, reason: 'role' });
  });

  it('rejects a Google-only identity even if a default role was auto-created', async () => {
    roleRow.value = { role: 'admin' };
    expect(await checkGoogleAccountAllowed('u1', [{ provider: 'google' }])).toEqual({ allowed: false, reason: 'new_account' });
    expect((await checkGoogleAccountAllowed('u1', [{ provider: 'email' }, { provider: 'google' }])).allowed).toBe(true);
  });

  it('validates signup phone like the signup page', () => {
    expect(isValidSignupPhone('+963912345678')).toBe(true);
    expect(isValidSignupPhone('0912 345')).toBe(false);
  });

  it('detects Google-only users (gate shows only for them)', () => {
    expect(isGoogleOnlyUser({ identities: [{ provider: 'google' }] })).toBe(true);
    expect(isGoogleOnlyUser({ identities: [{ provider: 'email' }, { provider: 'google' }] })).toBe(false);
    expect(isGoogleOnlyUser({ app_metadata: { providers: ['google'] } })).toBe(true);
    expect(isGoogleOnlyUser({ app_metadata: { providers: ['email'] } })).toBe(false);
    expect(isGoogleOnlyUser(null)).toBe(false);
  });

  it('cancel is silent', () => {
    expect(googleErrorMessage('CANCELLED')).toBe('');
    expect(googleErrorMessage('no_account')).toContain('البريد');
  });
});
