-- =========================================================================
-- أساس: جداول أُنشئت على القاعدة الحية مباشرة (محرر SQL) دون ملف migration.
-- مأخوذة من القاعدة الحية بتاريخ 2026-11-18 (قراءة فقط). لا تحوي مشغّلات (triggers):
-- المشغّلات تُنشأ في الـ migrations اللاحقة. banned_devices يُنشأ في 20261114010000.
-- =========================================================================

-- ---------- 1) الجداول ----------
CREATE TABLE IF NOT EXISTS public.account_encryption_keys (user_id uuid NOT NULL, key_material text NOT NULL, key_version integer NOT NULL DEFAULT 1, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.app_broadcasts (id uuid NOT NULL DEFAULT gen_random_uuid(), title text NOT NULL, body text NOT NULL DEFAULT ''::text, kind text NOT NULL DEFAULT 'info'::text, link_url text, is_active boolean NOT NULL DEFAULT true, expires_at timestamp with time zone, created_by uuid, created_at timestamp with time zone NOT NULL DEFAULT now(), target_version_code integer);
CREATE TABLE IF NOT EXISTS public.broadcast_reads (user_id uuid NOT NULL, broadcast_id uuid NOT NULL, read_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.client_versions (user_id uuid NOT NULL, version_name text NOT NULL, version_code integer NOT NULL DEFAULT 0, platform text, last_seen_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.error_logs (id uuid NOT NULL DEFAULT gen_random_uuid(), created_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()), occurred_at timestamp with time zone NOT NULL DEFAULT timezone('utc'::text, now()), user_id uuid, user_email text, error_type text DEFAULT 'React ErrorBoundary'::text, error_message text NOT NULL, error_stack text, component_stack text, platform text, page_url text, device_language text, timezone text, screen_resolution text, was_online boolean DEFAULT true, was_queued_offline boolean DEFAULT false, user_agent text, extra_context jsonb DEFAULT '{}'::jsonb, is_resolved boolean DEFAULT false);
CREATE TABLE IF NOT EXISTS public.phone_transfer_requests (id uuid NOT NULL DEFAULT gen_random_uuid(), target_user_id uuid NOT NULL, source_user_id uuid NOT NULL, phone text NOT NULL, code_hash text NOT NULL, attempts integer DEFAULT 0, expires_at timestamp with time zone NOT NULL, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.security_tamper_logs (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid, device_id text NOT NULL, tamper_type text NOT NULL, client_timestamp timestamp with time zone, server_timestamp timestamp with time zone DEFAULT now(), metadata jsonb DEFAULT '{}'::jsonb, resolved boolean DEFAULT false);
CREATE TABLE IF NOT EXISTS public.store_settings (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid, name text NOT NULL DEFAULT ''::text, store_type text DEFAULT 'phones'::text, phone text, email text, address text, logo_url text, primary_currency text DEFAULT 'USD'::text, exchange_rates jsonb DEFAULT '{"SYP": 0, "TRY": 0}'::jsonb, tax_enabled boolean DEFAULT false, tax_rate numeric DEFAULT 0, sync_settings jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE IF NOT EXISTS public.subscription_requests (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, ref_code text NOT NULL, plan_id uuid, plan_name text NOT NULL, plan_audience text NOT NULL, plan_days integer NOT NULL, price_usd numeric(12,2) NOT NULL, equivalents_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb, method_id uuid, method_name text NOT NULL, payer_name text, payer_ref text, proof_path text, status text NOT NULL DEFAULT 'pending'::text, admin_note text, confirmed_by uuid, confirmed_at timestamp with time zone, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.support_conversations (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, owner_id uuid, user_name text, user_email text, user_phone text, store_name text, status text NOT NULL DEFAULT 'open'::text, last_message_at timestamp with time zone NOT NULL DEFAULT now(), created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.support_messages (id uuid NOT NULL DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL, sender_id uuid NOT NULL, sender_role text NOT NULL DEFAULT 'user'::text, message text NOT NULL, is_read boolean NOT NULL DEFAULT false, created_at timestamp with time zone NOT NULL DEFAULT now(), attachment_url text, notified_native boolean DEFAULT false);
CREATE TABLE IF NOT EXISTS public.user_notifications (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, title text NOT NULL, message text NOT NULL, type text NOT NULL DEFAULT 'system'::text, is_read boolean NOT NULL DEFAULT false, is_archived boolean NOT NULL DEFAULT false, action_url text, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone NOT NULL DEFAULT now());

-- ---------- 2) المفاتيح الأساسية والفريدة ----------
ALTER TABLE public.account_encryption_keys ADD CONSTRAINT account_encryption_keys_pkey PRIMARY KEY (user_id);
ALTER TABLE public.app_broadcasts ADD CONSTRAINT app_broadcasts_pkey PRIMARY KEY (id);
ALTER TABLE public.broadcast_reads ADD CONSTRAINT broadcast_reads_pkey PRIMARY KEY (user_id, broadcast_id);
ALTER TABLE public.client_versions ADD CONSTRAINT client_versions_pkey PRIMARY KEY (user_id);
ALTER TABLE public.error_logs ADD CONSTRAINT error_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.phone_transfer_requests ADD CONSTRAINT phone_transfer_requests_pkey PRIMARY KEY (id);
ALTER TABLE public.security_tamper_logs ADD CONSTRAINT security_tamper_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_pkey PRIMARY KEY (id);
ALTER TABLE public.store_settings ADD CONSTRAINT unique_store_user UNIQUE (user_id);
ALTER TABLE public.subscription_requests ADD CONSTRAINT subscription_requests_pkey PRIMARY KEY (id);
ALTER TABLE public.subscription_requests ADD CONSTRAINT subscription_requests_ref_code_key UNIQUE (ref_code);
ALTER TABLE public.support_conversations ADD CONSTRAINT support_conversations_pkey PRIMARY KEY (id);
ALTER TABLE public.support_messages ADD CONSTRAINT support_messages_pkey PRIMARY KEY (id);
ALTER TABLE public.user_notifications ADD CONSTRAINT user_notifications_pkey PRIMARY KEY (id);

-- ---------- 3) المفاتيح الأجنبية وقيود الفحص ----------
ALTER TABLE public.account_encryption_keys ADD CONSTRAINT account_encryption_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.error_logs ADD CONSTRAINT error_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.phone_transfer_requests ADD CONSTRAINT phone_transfer_requests_source_user_id_fkey FOREIGN KEY (source_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.phone_transfer_requests ADD CONSTRAINT phone_transfer_requests_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.security_tamper_logs ADD CONSTRAINT security_tamper_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.store_settings ADD CONSTRAINT store_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.subscription_requests ADD CONSTRAINT subscription_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid_claimed'::text, 'confirmed'::text, 'rejected'::text, 'cancelled'::text, 'expired'::text])));
ALTER TABLE public.subscription_requests ADD CONSTRAINT subscription_requests_method_id_fkey FOREIGN KEY (method_id) REFERENCES public.payment_methods(id) ON DELETE SET NULL;
ALTER TABLE public.subscription_requests ADD CONSTRAINT subscription_requests_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.subscription_plans(id) ON DELETE SET NULL;
ALTER TABLE public.support_conversations ADD CONSTRAINT support_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.support_messages ADD CONSTRAINT support_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.support_conversations(id) ON DELETE CASCADE;
ALTER TABLE public.support_messages ADD CONSTRAINT support_messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES auth.users(id);

-- ---------- 4) الفهارس ----------
CREATE INDEX IF NOT EXISTS idx_error_logs_occurred_at ON public.error_logs USING btree (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_is_resolved ON public.error_logs USING btree (is_resolved);
CREATE INDEX IF NOT EXISTS idx_error_logs_platform ON public.error_logs USING btree (platform);
CREATE INDEX IF NOT EXISTS idx_phone_transfer_target ON public.phone_transfer_requests USING btree (target_user_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_sub_request_per_user ON public.subscription_requests USING btree (user_id) WHERE (status = ANY (ARRAY['pending'::text, 'paid_claimed'::text]));
CREATE INDEX IF NOT EXISTS idx_support_conv_user ON public.support_conversations USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_support_conv_last_msg ON public.support_conversations USING btree (last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_msg_conv ON public.support_messages USING btree (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_user_notifications_user ON public.user_notifications USING btree (user_id, is_archived, created_at DESC);

-- ---------- 5) أمان مستوى الصف (RLS) والسياسات ----------
ALTER TABLE public.account_encryption_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.broadcast_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.error_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.phone_transfer_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_tamper_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner reads own encryption key" ON public.account_encryption_keys AS PERMISSIVE FOR SELECT TO authenticated USING ((auth.uid() = user_id));
CREATE POLICY "owner inserts own encryption key once" ON public.account_encryption_keys AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users read active broadcasts" ON public.app_broadcasts AS PERMISSIVE FOR SELECT TO authenticated USING ((is_active OR public.is_boss(auth.uid())));
CREATE POLICY "Boss manages broadcasts" ON public.app_broadcasts AS PERMISSIVE FOR ALL TO authenticated USING (public.is_boss(auth.uid())) WITH CHECK (public.is_boss(auth.uid()));

CREATE POLICY "Users own broadcast reads" ON public.broadcast_reads AS PERMISSIVE FOR ALL TO authenticated USING ((user_id = auth.uid()));

CREATE POLICY "Users upsert own version" ON public.client_versions AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users update own version" ON public.client_versions AS PERMISSIVE FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Read own or boss reads all versions" ON public.client_versions AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.is_boss(auth.uid())));

CREATE POLICY "Boss and owners can view error logs" ON public.error_logs AS PERMISSIVE FOR SELECT TO authenticated USING ((public.is_boss(auth.uid()) OR (user_id = auth.uid())));
CREATE POLICY "Only boss can update error logs" ON public.error_logs AS PERMISSIVE FOR UPDATE TO authenticated USING (public.is_boss(auth.uid())) WITH CHECK (public.is_boss(auth.uid()));
CREATE POLICY "Only boss can delete error logs" ON public.error_logs AS PERMISSIVE FOR DELETE TO authenticated USING (public.is_boss(auth.uid()));
CREATE POLICY "Signed-in users insert own error logs" ON public.error_logs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));

CREATE POLICY service_role_transfer_requests_all ON public.phone_transfer_requests AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Devices report security tamper logs" ON public.security_tamper_logs AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) OR (user_id IS NULL)));
CREATE POLICY "Boss and admin view security tamper logs" ON public.security_tamper_logs AS PERMISSIVE FOR SELECT TO authenticated USING ((public.is_boss(auth.uid()) OR (EXISTS ( SELECT 1 FROM public.user_roles WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::public.app_role, 'boss'::public.app_role])))))));

CREATE POLICY "Users own their store settings" ON public.store_settings AS PERMISSIVE FOR ALL TO public USING ((auth.uid() = user_id));

CREATE POLICY "Users create requests" ON public.subscription_requests AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) AND ((status IS NULL) OR (status = 'pending'::text)) AND (confirmed_by IS NULL) AND (confirmed_at IS NULL)));
CREATE POLICY "Users read own requests" ON public.subscription_requests AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.is_boss(auth.uid())));
CREATE POLICY "Users update own pending proof only" ON public.subscription_requests AS PERMISSIVE FOR UPDATE TO authenticated USING (((user_id = auth.uid()) AND (status = 'pending'::text))) WITH CHECK (((user_id = auth.uid()) AND (status = 'pending'::text) AND (confirmed_by IS NULL) AND (confirmed_at IS NULL)));
CREATE POLICY "Boss manage all subscription requests" ON public.subscription_requests AS PERMISSIVE FOR ALL TO authenticated USING (public.is_boss(auth.uid())) WITH CHECK (public.is_boss(auth.uid()));

CREATE POLICY "Users can view own conversation" ON public.support_conversations AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR (owner_id = public.get_owner_id(auth.uid())) OR public.is_boss(auth.uid())));
CREATE POLICY "Users can create own conversation" ON public.support_conversations AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) OR public.is_boss(auth.uid())));
CREATE POLICY "Boss can update conversations" ON public.support_conversations AS PERMISSIVE FOR UPDATE TO authenticated USING ((public.is_boss(auth.uid()) OR (user_id = auth.uid())));
CREATE POLICY "Users and boss view support conversations" ON public.support_conversations AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR (owner_id = public.get_owner_id(auth.uid())) OR public.is_boss(auth.uid())));

CREATE POLICY "Users can view messages in own conversation" ON public.support_messages AS PERMISSIVE FOR SELECT TO authenticated USING ((public.is_boss(auth.uid()) OR (EXISTS ( SELECT 1 FROM public.support_conversations c WHERE ((c.id = support_messages.conversation_id) AND ((c.user_id = auth.uid()) OR (c.owner_id = public.get_owner_id(auth.uid()))))))));
CREATE POLICY "Users can insert messages into own conversation" ON public.support_messages AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((sender_id = auth.uid()) AND (public.is_boss(auth.uid()) OR (EXISTS ( SELECT 1 FROM public.support_conversations c WHERE ((c.id = support_messages.conversation_id) AND ((c.user_id = auth.uid()) OR (c.owner_id = public.get_owner_id(auth.uid())))))))));
CREATE POLICY "Users and boss view support messages" ON public.support_messages AS PERMISSIVE FOR SELECT TO authenticated USING ((public.is_boss(auth.uid()) OR (EXISTS ( SELECT 1 FROM public.support_conversations c WHERE ((c.id = support_messages.conversation_id) AND ((c.user_id = auth.uid()) OR (c.owner_id = public.get_owner_id(auth.uid()))))))));
CREATE POLICY "Users and boss update support messages" ON public.support_messages AS PERMISSIVE FOR UPDATE TO authenticated USING ((public.is_boss(auth.uid()) OR (EXISTS ( SELECT 1 FROM public.support_conversations c WHERE ((c.id = support_messages.conversation_id) AND ((c.user_id = auth.uid()) OR (c.owner_id = public.get_owner_id(auth.uid())))))))) WITH CHECK ((public.is_boss(auth.uid()) OR (EXISTS ( SELECT 1 FROM public.support_conversations c WHERE ((c.id = support_messages.conversation_id) AND ((c.user_id = auth.uid()) OR (c.owner_id = public.get_owner_id(auth.uid()))))))));

CREATE POLICY "Users read own notifications" ON public.user_notifications AS PERMISSIVE FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.is_boss(auth.uid())));
CREATE POLICY "Users update own notifications" ON public.user_notifications AS PERMISSIVE FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Boss insert notifications" ON public.user_notifications AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) OR public.is_boss(auth.uid())));
CREATE POLICY "Users delete own notifications" ON public.user_notifications AS PERMISSIVE FOR DELETE TO authenticated USING (((user_id = auth.uid()) OR public.is_boss(auth.uid())));
