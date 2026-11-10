-- =========================================================================
-- جدول مزامنة الإعلانات المقروءة مع السحابة (Broadcast Reads Cloud Sync)
-- يمنع تكرار ظهور إعلانات البث بعد قراءتها حتى لو أعاد العميل تثبيت التطبيق
-- =========================================================================

CREATE TABLE IF NOT EXISTS public.broadcast_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  broadcast_id uuid NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, broadcast_id)
);

-- الفهارس للأداء العالي
CREATE INDEX IF NOT EXISTS idx_broadcast_reads_user_id ON public.broadcast_reads(user_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_reads_broadcast_id ON public.broadcast_reads(broadcast_id);

-- تفعيل أمان مستوى الصف RLS
ALTER TABLE public.broadcast_reads ENABLE ROW LEVEL SECURITY;

-- سياسات RLS: كل مستخدم مسجل يقرأ ويسجل إعلاناته المقروءة فقط
DROP POLICY IF EXISTS "Users can view own broadcast reads" ON public.broadcast_reads;
CREATE POLICY "Users can view own broadcast reads"
  ON public.broadcast_reads FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own broadcast reads" ON public.broadcast_reads;
CREATE POLICY "Users can insert own broadcast reads"
  ON public.broadcast_reads FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own broadcast reads" ON public.broadcast_reads;
CREATE POLICY "Users can update own broadcast reads"
  ON public.broadcast_reads FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own broadcast reads" ON public.broadcast_reads;
CREATE POLICY "Users can delete own broadcast reads"
  ON public.broadcast_reads FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
