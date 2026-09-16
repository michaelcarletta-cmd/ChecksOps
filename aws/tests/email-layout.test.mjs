import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { escapeHtml, renderChecksOpsEmail } from '../functions/api/email-layout.mjs';
import {
  customFromFailureReason,
  isSafeHttpUrl,
  isVerifiedCustomSender,
  platformBranding,
  resolveEmailBranding,
} from '../functions/api/email-branding.mjs';
import { sendViaSesOrSink } from '../functions/api/email.mjs';
import { renderTransactionalTemplate, TEMPLATE_NAMES } from '../functions/api/email-templates.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const sqlClient = (handlers) => ({
  query: async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ');
    for (const handler of handlers) {
      if (handler.match(compact, params)) return handler.result(params, compact);
    }
    return { rows: [], rowCount: 0 };
  },
});

test('layout escapes dynamic HTML and includes CTA, fallback URL, support, and text', () => {
  const layout = renderChecksOpsEmail({
    title: '<script>alert(1)</script>',
    greeting: 'Hi <b>Ada</b>,',
    paragraphs: ['Amount <img src=x onerror=alert(1)> owed'],
    ctaLabel: 'Open portal',
    ctaUrl: 'https://staging.checksops.com/h/ledger/abc',
    fallbackUrl: 'https://staging.checksops.com/h/ledger/abc',
    expiresText: 'Expires in 72 hours.',
    companySubtitle: 'Acme <Adjusters>',
    primaryColor: '#112233',
    unsubscribeUrl: 'https://staging.checksops.com/unsubscribe?t=1',
  });
  assert.equal(layout.html.includes('<script>'), false);
  assert.match(layout.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(layout.html, /Hi &lt;b&gt;Ada&lt;\/b&gt;,/);
  assert.match(layout.html, /Amount &lt;img src=x onerror=alert\(1\)&gt; owed/);
  assert.match(layout.html, /Acme &lt;Adjusters&gt;/);
  assert.match(layout.html, /Open portal/);
  assert.match(layout.html, /https:\/\/staging\.checksops\.com\/h\/ledger\/abc/);
  assert.match(layout.html, /If the button does not work/);
  assert.match(layout.html, /Expires in 72 hours/);
  assert.match(layout.html, /support@checksops\.com/);
  assert.match(layout.html, /Unsubscribe/);
  assert.match(layout.html, /checksops-logo\.png/);
  assert.match(layout.html, /name="viewport"/);
  assert.match(layout.html, /#112233/);
  assert.match(layout.text, /<script>alert\(1\)<\/script>/);
  assert.match(layout.text, /Open portal: https:\/\/staging\.checksops\.com\/h\/ledger\/abc/);
  assert.match(layout.text, /Questions\? Contact support@checksops\.com/);
  assert.equal(escapeHtml('<x>'), '&lt;x&gt;');
});

test('unsafe tenant color is not injected into CSS', () => {
  const layout = renderChecksOpsEmail({
    title: 'Hello',
    primaryColor: 'red;background:url(javascript:alert(1))',
  });
  assert.doesNotMatch(layout.html, /javascript:/);
  assert.match(layout.html, /#1a56db/);
});

test('tenant logo replaces the platform logo and missing or unsafe logos fall back', async () => {
  const withLogo = await resolveEmailBranding(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenants'),
      result: () => ({ rows: [{
        name: 'Acme',
        is_system_tenant: false,
        logo_url: 'https://cdn.acme.test/brand.png',
      }] }),
    },
  ]), { tenantId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(withLogo.logoUrl, 'https://cdn.acme.test/brand.png');
  const branded = renderChecksOpsEmail({ title: 'Hi', logoUrl: withLogo.logoUrl });
  assert.match(branded.html, /https:\/\/cdn\.acme\.test\/brand\.png/);
  assert.doesNotMatch(branded.html, /checksops-logo\.png/);

  const missing = await resolveEmailBranding(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenants'),
      result: () => ({ rows: [{ name: 'Acme', is_system_tenant: false, logo_url: null }] }),
    },
  ]), { tenantId: '11111111-1111-4111-8111-111111111111' });
  assert.match(missing.logoUrl, /checksops-logo\.png/);
  const fallback = renderChecksOpsEmail({ title: 'Hi', logoUrl: missing.logoUrl });
  assert.match(fallback.html, /checksops-logo\.png/);

  const unsafeLogo = await resolveEmailBranding(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenants'),
      result: () => ({ rows: [{
        name: 'Acme',
        is_system_tenant: false,
        logo_url: 'javascript:alert(1)',
      }] }),
    },
  ]), { tenantId: '11111111-1111-4111-8111-111111111111' });
  assert.match(unsafeLogo.logoUrl, /checksops-logo\.png/);
});

test('unsafe URL schemes are rejected or omitted from href and src', () => {
  assert.equal(isSafeHttpUrl('https://staging.checksops.com/h/x'), true);
  assert.equal(isSafeHttpUrl('http://localhost:4173/login'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('data:text/html,hi'), false);
  assert.equal(isSafeHttpUrl('file:///etc/passwd'), false);
  assert.equal(isSafeHttpUrl('//evil.example/x.png'), false);
  assert.equal(isSafeHttpUrl('http://evil.example/phish'), false);

  const layout = renderChecksOpsEmail({
    title: 'Hi',
    ctaLabel: 'Open',
    ctaUrl: 'javascript:alert(1)',
    fallbackUrl: 'data:text/html,hi',
    unsubscribeUrl: 'file:///tmp/x',
    logoUrl: '//evil.example/x.png',
  });
  assert.doesNotMatch(layout.html, /javascript:/i);
  assert.doesNotMatch(layout.html, /data:text\/html/i);
  assert.doesNotMatch(layout.html, /file:\/\//i);
  assert.doesNotMatch(layout.html, /src="\/\//);
  assert.doesNotMatch(layout.html, /href="\/\//);
  assert.match(layout.html, /checksops-logo\.png/);
  assert.doesNotMatch(layout.html, />Open</);
  assert.doesNotMatch(layout.text, /javascript:/i);
  assert.doesNotMatch(layout.text, /Unsubscribe:/);
});

test('legacy custom-domain rows cannot change ChecksOps From', async () => {
  const verifiedShape = {
    sending_mode: 'custom',
    domain_status: 'verified',
    from_address: 'office@acme.test',
    sending_domain: 'acme.test',
    ses_identity_name: 'acme.test',
    custom_sending_enabled: true,
  };
  assert.equal(isVerifiedCustomSender(verifiedShape), false);
  assert.equal(customFromFailureReason(verifiedShape), 'custom_from_retired');
  assert.equal(isVerifiedCustomSender({
    sending_mode: 'custom',
    domain_status: 'pending',
    from_address: 'office@acme.test',
    sending_domain: 'acme.test',
  }), false);

  const verified = await resolveEmailBranding(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenants'),
      result: () => ({ rows: [{
        name: 'Acme',
        is_system_tenant: false,
        logo_url: 'https://cdn.acme.test/brand.png',
        primary_color: '#112233',
        email_from_name: 'Acme Claims',
        email_from_address: 'office@acme.test',
        email_reply_to: 'help@acme.test',
      }] }),
    },
    {
      match: (sql) => sql.includes('tenant_email_settings'),
      result: () => ({ rows: [{
        from_name: 'Acme Claims',
        reply_to: 'claims@acme.test',
        sending_mode: 'custom',
        sending_domain: 'acme.test',
        from_address: 'office@acme.test',
        domain_status: 'verified',
        ses_identity_name: 'acme.test',
        custom_sending_enabled: true,
      }] }),
    },
  ]), { tenantId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(verified.usingCustomFrom, false);
  assert.equal(verified.customFromBlocked, true);
  assert.equal(verified.customFromReason, 'custom_from_retired');
  assert.match(verified.from, /noreply@checksops\.com/);
  assert.match(verified.from, /via ChecksOps/);
  assert.doesNotMatch(verified.from, /office@acme\.test/);
  assert.equal(verified.replyTo, 'claims@acme.test');
  assert.equal(verified.logoUrl, 'https://cdn.acme.test/brand.png');
  assert.equal(verified.primaryColor, '#112233');
  assert.equal(verified.companySubtitle, 'Acme');
});

test('Reply-To uses settings then tenant mailbox then ChecksOps fallback', async () => {
  const fromSettings = await resolveEmailBranding(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenants'),
      result: () => ({ rows: [{
        name: 'Acme',
        is_system_tenant: false,
        email_from_address: 'office@acme.test',
        email_reply_to: 'ops@acme.test',
      }] }),
    },
    {
      match: (sql) => sql.includes('tenant_email_settings'),
      result: () => ({ rows: [{
        reply_to: 'claims@acme.test',
        from_address: 'noreply@notify.acme.test',
      }] }),
    },
  ]), { tenantId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(fromSettings.replyTo, 'claims@acme.test');
  assert.match(fromSettings.from, /noreply@checksops\.com/);

  const fromTenant = await resolveEmailBranding(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenants'),
      result: () => ({ rows: [{
        name: 'Acme',
        is_system_tenant: false,
        email_from_address: 'office@acme.test',
        email_reply_to: 'ops@acme.test',
      }] }),
    },
    {
      match: (sql) => sql.includes('tenant_email_settings'),
      result: () => ({ rows: [{ from_address: 'office@acme.test' }] }),
    },
  ]), { tenantId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(fromTenant.replyTo, 'ops@acme.test');
  assert.doesNotMatch(fromTenant.replyTo, /office@acme\.test/);

  const fallback = await resolveEmailBranding(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenants'),
      result: () => ({ rows: [{
        name: 'Acme',
        is_system_tenant: false,
        email_from_address: 'office@acme.test',
      }] }),
    },
    {
      match: (sql) => sql.includes('tenant_email_settings'),
      result: () => ({ rows: [{ from_address: 'office@acme.test' }] }),
    },
  ]), { tenantId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(fallback.replyTo, 'support@checksops.com');

  const platform = await resolveEmailBranding(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenants'),
      result: () => ({ rows: [{
        name: 'Acme',
        is_system_tenant: false,
        email_reply_to: 'claims@acme.test',
      }] }),
    },
    {
      match: (sql) => sql.includes('tenant_email_settings'),
      result: () => ({ rows: [{ reply_to: 'claims@acme.test' }] }),
    },
  ]), { tenantId: '11111111-1111-4111-8111-111111111111', senderOverride: 'checksops' });
  assert.equal(platform.replyTo, 'support@checksops.com');
  assert.equal(platform.usingCustomFrom, false);
});

test('platform branding never uses a tenant custom From', async () => {
  const platform = platformBranding();
  assert.match(platform.from, /noreply@checksops\.com/);
  assert.equal(platform.usingCustomFrom, false);

  const blocked = await resolveEmailBranding(sqlClient([
    {
      match: (sql) => sql.includes('FROM public.tenants'),
      result: () => ({ rows: [{
        name: 'Acme',
        is_system_tenant: false,
        primary_color: '#ff6600',
        email_from_name: 'Acme Claims',
        email_from_address: 'office@acme.test',
        email_reply_to: 'office@acme.test',
      }] }),
    },
    {
      match: (sql) => sql.includes('tenant_email_settings'),
      result: () => ({ rows: [{
        from_name: 'Acme Claims',
        reply_to: 'office@acme.test',
        sending_mode: 'custom',
        sending_domain: 'acme.test',
        from_address: 'office@acme.test',
        domain_status: 'pending',
      }] }),
    },
  ]), { tenantId: '11111111-1111-4111-8111-111111111111' });
  assert.equal(blocked.customFromBlocked, true);
  assert.equal(blocked.usingCustomFrom, false);
  assert.match(blocked.from, /noreply@checksops\.com/);
  assert.match(blocked.from, /via ChecksOps/);
  assert.equal(blocked.replyTo, 'office@acme.test');
  assert.equal(blocked.companySubtitle, 'Acme');
  assert.equal(blocked.primaryColor, '#ff6600');
  assert.match(blocked.logoUrl, /checksops-logo\.png/);
});

test('sink mode always sinks and SES errors keep sink_fallback', async () => {
  const prev = process.env.AWS_EMAIL_MODE;
  process.env.AWS_EMAIL_MODE = 'sink';
  const sunk = await sendViaSesOrSink({
    to: 'mcarletta@freedomadj.com',
    subject: 'Sink check',
    html: '<p>hello</p>',
    text: 'hello',
    sesSend: async () => {
      throw new Error('SES must not be called in sink mode');
    },
  });
  assert.equal(sunk.mode, 'sink');
  assert.equal(sunk.results[0].delivery, 'sink');
  assert.equal(sunk.results[0].originalTo, 'mcarletta@freedomadj.com');

  process.env.AWS_EMAIL_MODE = 'ses';
  process.env.CHECKSOPS_ENV = 'staging';
  process.env.AWS_EMAIL_SES_LOCK_RECIPIENT = 'mcarletta@freedomadj.com';
  const fallback = await sendViaSesOrSink({
    to: 'mcarletta@freedomadj.com',
    subject: 'SES down',
    html: '<p>hello</p>',
    text: 'hello',
    sesSend: async () => {
      throw new Error('throttled');
    },
  });
  assert.equal(fallback.results[0].delivery, 'sink_fallback');
  assert.equal(fallback.results[0].status, 'failed');

  process.env.AWS_EMAIL_MODE = 'ses';
  let captured = null;
  const tagged = await sendViaSesOrSink({
    to: 'mcarletta@freedomadj.com',
    subject: 'Tagged',
    html: '<p>hello</p>',
    text: 'hello',
    replyTo: 'claims@acme.test',
    tenantId: '11111111-1111-4111-8111-111111111111',
    messageCategory: 'tenant_invite',
    headers: { 'X-Claim-Number': 'CL-999', recipient: 'victim@example.com' },
    sesSend: async (cmd) => {
      captured = cmd;
      return { MessageId: 'mid-1' };
    },
  });
  assert.equal(tagged.results[0].status, 'sent');
  const source = captured?.input?.Source || captured?.Source;
  assert.match(String(source || ''), /noreply@checksops\.com/);
  const replyTo = captured?.input?.ReplyToAddresses || captured?.ReplyToAddresses;
  assert.deepEqual(replyTo, ['claims@acme.test']);
  const tags = captured?.input?.Tags || captured?.Tags || [];
  assert.equal(tags.some((t) => t.Name === 'tenant_id' && t.Value === '11111111-1111-4111-8111-111111111111'), true);
  assert.equal(tags.some((t) => t.Name === 'message_category' && t.Value === 'tenant_invite'), true);
  assert.equal(tags.some((t) => /claim|recipient|email/i.test(t.Name) || /CL-999|victim@/i.test(String(t.Value))), false);
  process.env.AWS_EMAIL_MODE = prev;
});

test('shared templates keep ChecksOps layout and do not emit raw script tags', () => {
  for (const name of TEMPLATE_NAMES) {
    const rendered = renderTransactionalTemplate(name, {
      homeownerName: '<script>x</script>',
      portalUrl: 'https://staging.checksops.com/h/x',
      ledgerUrl: 'https://staging.checksops.com/h/l',
      loginUrl: 'https://staging.checksops.com/login',
      verifyUrl: 'https://staging.checksops.com/verify-account/t',
      endorseUrl: 'https://staging.checksops.com/endorse?token=t',
      requestUrl: 'https://staging.checksops.com/payment-direction/x',
      name: 'A',
      email: 'a@b.com',
      message: '<img src=x>',
      code: '123456',
    });
    assert.ok(rendered.subject);
    assert.match(rendered.html, /checksops-logo\.png/);
    assert.match(rendered.html, /support@checksops\.com/);
    assert.equal(rendered.html.includes('<script>'), false);
    assert.ok(rendered.text);
  }
});

test('staging template names AWS_EMAIL_MODE=sink and does not grant SES', () => {
  const yaml = fs.readFileSync(path.join(ROOT, 'aws/template.yaml'), 'utf8');
  assert.match(yaml, /AWS_EMAIL_MODE:\s*"sink"/);
  assert.match(yaml, /AWS_EMAIL_FROM:/);
  assert.match(yaml, /AWS_EMAIL_REPLY_TO:/);
  assert.match(yaml, /AWS_EMAIL_SINK_ADDRESS:/);
  assert.match(yaml, /AWS_EMAIL_ALLOWLIST_DOMAINS:/);
  assert.match(yaml, /AWS_EMAIL_ALLOWLIST_EXACT:/);
  assert.match(yaml, /AWS_MORTGAGE_OPS_EMAIL:/);
  assert.match(yaml, /AWS_TENANT_EMAIL_DOMAIN_ENABLED:\s*"false"/);
  assert.match(yaml, /AWS_SES_CONFIGURATION_SET:\s*""/);
  assert.doesNotMatch(yaml, /ses:SendEmail|ses:SendRawEmail|ses:/);
  const production = fs.readFileSync(path.join(ROOT, 'aws/production/api-execution-role.yaml'), 'utf8');
  assert.doesNotMatch(production, /ses:SendEmail|ses:SendRawEmail|ses:/);
});
