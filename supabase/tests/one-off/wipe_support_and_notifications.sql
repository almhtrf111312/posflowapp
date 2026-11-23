-- ONE-OFF SCRIPT (owner request, 2026-11-23). NOT a migration: never replayed by the migration tooling.
-- Removes the support conversations/messages and the in-app notifications. Accounts, roles, licences, stores,
-- settings and device push tokens are kept.
TRUNCATE TABLE
  public.support_messages,
  public.support_conversations,
  public.user_notifications;
