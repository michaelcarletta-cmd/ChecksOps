create unique index if not exists payment_provider_methods_provider_bank_uniq
  on public.payment_provider_methods (provider, environment, provider_bank_account_id);