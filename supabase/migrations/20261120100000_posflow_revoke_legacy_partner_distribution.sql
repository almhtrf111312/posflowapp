-- No callers found in client code, other DB functions, or repo edge functions. Execution restricted to service_role.
REVOKE ALL ON FUNCTION public.distribute_sale_profit_to_partners_atomic(text,text,boolean,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.distribute_sale_profit_to_partners_atomic(text,text,boolean,jsonb) TO service_role;
