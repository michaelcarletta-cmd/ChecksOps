# Plan - Refine OCR Error Messaging and Handling

We will improve the OCR error messaging to be more user-friendly and clear, specifically addressing the technical detail leak where underlying "AI 400" errors are displayed directly to users.

## User Review Required

> [!IMPORTANT]
> This change updates technical error messages to be more user-friendly. No functionality changes are made to the OCR engine itself.

## Proposed Changes

### Backend (Edge Functions)

#### `supabase/functions/check-ocr-intake/index.ts`
- Modify `shouldFallbackTenantAiError` to better categorize common gateway/model errors.
- Update the `last_error` assignment in `validateTenantKeyForOcrFallback` to use a cleaner message format.
- Refine `errResponse` usage to return user-friendly strings (e.g., "The check image could not be downloaded for analysis" instead of "AI 400: Failed to download...").
- Update error logging in the OCR pipeline to strip technical headers (like "AI 400:") when displaying to the UI, while keeping full logs in the audit trail.

#### `supabase/functions/_shared/ai/openaiClient.ts`
- Update the error throwing logic in `executeChat` to provide cleaner error types (e.g., `IMAGE_DOWNLOAD_FAILED`, `PROVIDER_UNAVAILABLE`) that the intake function can map to friendly text.

### Frontend

#### `src/components/white-label/TenantAIKeySettings.tsx`
- Add a helper to parse and format the `last_error` from the `tenant_openai_credentials` table, hiding raw Supabase/OpenAI technical details and showing helpful troubleshooting steps instead.

## Technical Details
- Map `AI 400: Failed to download image` -> `Unable to retrieve check image for processing. Please try re-uploading.`
- Map `AI 401/403` -> `The provided AI key is unauthorized. Please verify your credentials in Settings.`
- Map `AI 429` -> `AI processing limit reached. Please wait a moment before trying again.`

## Verification Plan
- **Mocked Failure**: Manually trigger an OCR failure with a signed URL error and verify the UI shows the friendly message.
- **Key Validation**: Test with an invalid key to ensure the `TenantAIKeySettings` panel displays a clear "Invalid Key" message without raw JSON/stack traces.
