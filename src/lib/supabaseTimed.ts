import { supabase } from "@/integrations/supabase/client";

export async function timedQuery<T>(
  name: string,
  queryFn: () => Promise<{ data: T; error: unknown }>
): Promise<T> {
  const started = performance.now();
  const result = await queryFn();
  const ended = performance.now();

  console.log(`[query] ${name}: ${(ended - started).toFixed(2)}ms`);

  if ((result as { error?: unknown }).error) {
    throw (result as { error?: unknown }).error;
  }

  return result.data;
}

export { supabase };
