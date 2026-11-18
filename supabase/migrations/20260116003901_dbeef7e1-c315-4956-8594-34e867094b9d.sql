-- Add unique constraint first
ALTER TABLE public.user_roles 
ADD CONSTRAINT user_roles_user_id_unique UNIQUE (user_id);

-- Then add admin role for the current user
-- يُدرج دور المدير فقط إن كان المستخدم موجوداً (قاعدة جديدة بلا مستخدمين لا تفشل)
INSERT INTO public.user_roles (user_id, role)
SELECT '174b31d6-f19a-4381-9efb-45f1bea6ff0f'::uuid, 'admin'
WHERE EXISTS (SELECT 1 FROM auth.users WHERE id = '174b31d6-f19a-4381-9efb-45f1bea6ff0f'::uuid)
ON CONFLICT (user_id) DO NOTHING;