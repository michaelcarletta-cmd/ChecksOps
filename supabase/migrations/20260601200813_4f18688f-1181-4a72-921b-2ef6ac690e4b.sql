INSERT INTO public.deposit_provider_config (provider, display_name, is_active, is_stubbed, capabilities) VALUES
  ('manual_branch', 'Manual / Branch Deposit', true, false, '["deposit_slip","stamped_receipt","bank_confirmation"]'::jsonb),
  ('internal_ready', 'Internal Ready (Desktop)', true, false, '["deposit_slip","bank_confirmation"]'::jsonb),
  ('synctera', 'Synctera API', false, true, '["api_submission","webhook","auto_reconciliation"]'::jsonb),
  ('treasury_prime', 'Treasury Prime API', false, true, '["api_submission","webhook","auto_reconciliation"]'::jsonb)
ON CONFLICT (provider) DO UPDATE SET is_active = EXCLUDED.is_active, display_name = EXCLUDED.display_name;