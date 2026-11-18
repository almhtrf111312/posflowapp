-- Live database stores telegram_chat_id as bigint.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='profiles' AND column_name='telegram_chat_id') = 'text' THEN
    ALTER TABLE public.profiles
      ALTER COLUMN telegram_chat_id TYPE bigint USING NULLIF(telegram_chat_id, '')::bigint;
  END IF;
END $$;
