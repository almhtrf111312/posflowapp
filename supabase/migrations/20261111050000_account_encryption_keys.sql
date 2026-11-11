-- ============================================================================
-- Account encryption key escrow
-- يُولَّد مفتاح التشفير عند أول إنشاء لحساب أونلاين ويُحفظ هنا ليُسترجع عند الاشتراك.
-- المفتاح غير قابل للتعديل أو الحذف من العميل (لا توجد سياسات update/delete).
-- قبل التطبيق: راجع الملف. بعد التطبيق: شغّل التحقق في نهاية الملف.
-- ============================================================================

create table if not exists public.account_encryption_keys (
  user_id uuid primary key references auth.users(id) on delete cascade,
  key_material text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now()
);

comment on table public.account_encryption_keys is
  'Per-account encryption key (escrow). Written once at signup, read by the owner only.';

alter table public.account_encryption_keys enable row level security;

revoke all on table public.account_encryption_keys from anon;
revoke all on table public.account_encryption_keys from authenticated;
grant select, insert on table public.account_encryption_keys to authenticated;

drop policy if exists "owner reads own encryption key" on public.account_encryption_keys;
create policy "owner reads own encryption key"
  on public.account_encryption_keys
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "owner inserts own encryption key once" on public.account_encryption_keys;
create policy "owner inserts own encryption key once"
  on public.account_encryption_keys
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- ============================================================================
-- التحقق (شغّله بعد التطبيق، يجب أن يُرجع الجدول موجوداً مع RLS مفعّل)
-- ============================================================================
-- select relname, relrowsecurity from pg_class where relname = 'account_encryption_keys';
-- select policyname, cmd from pg_policies where tablename = 'account_encryption_keys';
