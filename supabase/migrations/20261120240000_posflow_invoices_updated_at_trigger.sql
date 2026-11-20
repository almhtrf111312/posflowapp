-- المزامنة التزايدية للفواتير تعتمد على updated_at: يجب أن يتحدّث عند كل تعديل
DROP TRIGGER IF EXISTS set_invoices_updated_at ON public.invoices;
CREATE TRIGGER set_invoices_updated_at BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
