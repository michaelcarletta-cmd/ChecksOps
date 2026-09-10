Deploy this function from commit df8338df (PR #209) to project nbcqwpysqgyxrrbgtmkw.

Do not rewrite the code. Pull the exact source from that commit:

  git show df8338df:supabase/functions/moov-recipient-session/index.ts > supabase/functions/moov-recipient-session/index.ts

Then deploy:

  supabase functions deploy moov-recipient-session --project-ref nbcqwpysqgyxrrbgtmkw

verify_jwt must remain false (see src/constants/edgeFunctionConfig.ts).
