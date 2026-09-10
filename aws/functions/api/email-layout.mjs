/**
 * Shared ChecksOps HTML + plain-text layout for AWS application emails.
 * Does not send mail. Callers still go through sendViaSesOrSink (sink by default).
 */

import {
  checksOpsLogoUrl,
  PLATFORM_PRIMARY_COLOR,
  PLATFORM_SUPPORT_EMAIL,
  safeHttpUrl,
} from './email-branding.mjs';

export const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export const escapeAttr = (value) => escapeHtml(value).replace(/`/g, '&#96;');

const stripTags = (value) => String(value ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p>/gi, '\n\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const htmlToPlainText = (html) => stripTags(html);

export const renderChecksOpsEmail = ({
  title,
  preview = '',
  greeting = '',
  bodyHtml = '',
  paragraphs = [],
  ctaLabel = null,
  ctaUrl = null,
  fallbackUrl = null,
  expiresText = null,
  companySubtitle = null,
  primaryColor = PLATFORM_PRIMARY_COLOR,
  unsubscribeUrl = null,
  supportEmail = PLATFORM_SUPPORT_EMAIL,
  logoUrl = null,
} = {}) => {
  const color = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(primaryColor || ''))
    ? String(primaryColor)
    : PLATFORM_PRIMARY_COLOR;
  const safeTitle = escapeHtml(title || 'ChecksOps notification');
  const safePreview = escapeHtml(preview || title || '');
  const safeGreeting = greeting ? `<p style="margin:0 0 12px;font-size:16px;color:#0f172a;">${escapeHtml(greeting)}</p>` : '';
  const paragraphHtml = (Array.isArray(paragraphs) ? paragraphs : [])
    .filter((p) => p != null && String(p).trim() !== '')
    .map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#334155;">${escapeHtml(p)}</p>`)
    .join('');
  const safeCtaUrl = safeHttpUrl(ctaUrl);
  const visibleUrl = safeHttpUrl(fallbackUrl) || safeCtaUrl || '';
  const ctaHref = safeCtaUrl ? escapeAttr(safeCtaUrl) : '';
  const ctaHtml = ctaLabel && ctaHref
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
        <tr><td align="center" bgcolor="${color}" style="border-radius:8px;">
          <a href="${ctaHref}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
        </td></tr>
      </table>`
    : '';
  const fallbackHtml = visibleUrl
    ? `<p style="margin:8px 0 16px;font-size:12px;line-height:1.5;color:#64748b;word-break:break-all;">If the button does not work, copy and paste this URL into your browser:<br><a href="${escapeAttr(visibleUrl)}" style="color:${color};">${escapeHtml(visibleUrl)}</a></p>`
    : '';
  const expiryHtml = expiresText
    ? `<p style="margin:0 0 16px;font-size:13px;color:#64748b;">${escapeHtml(expiresText)}</p>`
    : '';
  const subtitleHtml = companySubtitle
    ? `<p style="margin:4px 0 0;font-size:13px;color:#64748b;">${escapeHtml(companySubtitle)}</p>`
    : '';
  const safeUnsubUrl = safeHttpUrl(unsubscribeUrl);
  const unsubHtml = safeUnsubUrl
    ? `<p style="margin:16px 0 0;font-size:11px;color:#94a3b8;">Don't want these emails? <a href="${escapeAttr(safeUnsubUrl)}" style="color:#64748b;">Unsubscribe</a></p>`
    : '';
  const logo = escapeAttr(safeHttpUrl(logoUrl) || safeHttpUrl(checksOpsLogoUrl()) || '');
  const safeSupport = escapeHtml(supportEmail);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="x-ua-compatible" content="ie=edge">
  <title>${safeTitle}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${safePreview}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;margin:0;padding:0;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="padding:20px 28px 16px;border-bottom:1px solid #e2e8f0;">
              ${logo ? `<img src="${logo}" alt="ChecksOps" width="220" style="display:block;width:220px;max-width:70%;height:auto;border:0;">` : ''}
              ${subtitleHtml}
            </td>
          </tr>
          <tr>
            <td style="height:4px;line-height:4px;font-size:0;background:${color};">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#0f172a;font-family:Arial,Helvetica,sans-serif;">${safeTitle}</h1>
              ${safeGreeting}
              ${paragraphHtml}
              ${bodyHtml || ''}
              ${ctaHtml}
              ${fallbackHtml}
              ${expiryHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px 24px;border-top:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#64748b;">Questions? Contact <a href="mailto:${safeSupport}" style="color:${color};">${safeSupport}</a></p>
              ${unsubHtml}
              <p style="margin:12px 0 0;font-size:11px;color:#94a3b8;">Sent by ChecksOps</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textParts = [
    title || 'ChecksOps notification',
    companySubtitle ? String(companySubtitle) : null,
    '',
    greeting ? String(greeting) : null,
    ...(Array.isArray(paragraphs) ? paragraphs.map((p) => String(p)) : []),
    bodyHtml ? htmlToPlainText(bodyHtml) : null,
    ctaLabel && safeCtaUrl ? `${ctaLabel}: ${safeCtaUrl}` : null,
    visibleUrl && visibleUrl !== safeCtaUrl ? `Link: ${visibleUrl}` : (visibleUrl && !ctaLabel ? `Link: ${visibleUrl}` : null),
    expiresText ? String(expiresText) : null,
    '',
    `Questions? Contact ${supportEmail}`,
    safeUnsubUrl ? `Unsubscribe: ${safeUnsubUrl}` : null,
    'Sent by ChecksOps',
  ].filter((line) => line != null);

  return {
    html,
    text: textParts.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
};
