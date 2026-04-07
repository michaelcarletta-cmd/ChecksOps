
-- Expenses Categories
CREATE TABLE public.expenses_categories (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name, created_by)
);

ALTER TABLE public.expenses_categories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own categories" ON public.expenses_categories FOR SELECT USING (auth.uid() = created_by);
CREATE POLICY "Users can create own categories" ON public.expenses_categories FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "Users can update own categories" ON public.expenses_categories FOR UPDATE USING (auth.uid() = created_by);
CREATE POLICY "Users can delete own categories" ON public.expenses_categories FOR DELETE USING (auth.uid() = created_by);

-- Expenses Payees
CREATE TABLE public.expenses_payees (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(name, created_by)
);

ALTER TABLE public.expenses_payees ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own payees" ON public.expenses_payees FOR SELECT USING (auth.uid() = created_by);
CREATE POLICY "Users can create own payees" ON public.expenses_payees FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "Users can update own payees" ON public.expenses_payees FOR UPDATE USING (auth.uid() = created_by);
CREATE POLICY "Users can delete own payees" ON public.expenses_payees FOR DELETE USING (auth.uid() = created_by);

-- Payment Methods
CREATE TABLE public.payment_methods (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  label TEXT NOT NULL,
  method_type TEXT NOT NULL DEFAULT 'card',
  card_last_four TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(label, created_by)
);

ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own methods" ON public.payment_methods FOR SELECT USING (auth.uid() = created_by);
CREATE POLICY "Users can create own methods" ON public.payment_methods FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "Users can update own methods" ON public.payment_methods FOR UPDATE USING (auth.uid() = created_by);
CREATE POLICY "Users can delete own methods" ON public.payment_methods FOR DELETE USING (auth.uid() = created_by);

-- Update timestamps triggers
CREATE TRIGGER update_expenses_categories_updated_at BEFORE UPDATE ON public.expenses_categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_expenses_payees_updated_at BEFORE UPDATE ON public.expenses_payees FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_payment_methods_updated_at BEFORE UPDATE ON public.payment_methods FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
