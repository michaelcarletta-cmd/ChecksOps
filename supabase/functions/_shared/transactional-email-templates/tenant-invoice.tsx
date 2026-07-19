import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'ChecksOps'
const LOGO_URL = 'https://checksops.com/checksops-logo.png'

interface LineItem {
  label: string
  detail?: string
  amount_cents: number
}

interface TenantInvoiceProps {
  tenant_name?: string
  period_label?: string
  invoice_number?: string
  line_items?: LineItem[]
  discount_cents?: number
  total_cents?: number
  bank_last4?: string
  status?: string
  charged_at?: string
}

const money = (cents: number) =>
  `$${((cents || 0) / 100).toFixed(2)}`

const TenantInvoice = ({
  tenant_name,
  period_label,
  invoice_number,
  line_items = [],
  discount_cents = 0,
  total_cents = 0,
  bank_last4,
  status,
  charged_at,
}: TenantInvoiceProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>{SITE_NAME} invoice {invoice_number || ''} — {money(total_cents)}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={logoSection}>
          <Img src={LOGO_URL} alt={SITE_NAME} width="320" style={logo} />
        </Section>
        <Heading style={h1}>Invoice {invoice_number ? `#${invoice_number}` : ''}</Heading>
        <Text style={text}>
          Hi {tenant_name || 'there'}, here is your {SITE_NAME} statement for{' '}
          <strong>{period_label || 'this period'}</strong>.
        </Text>

        <Section style={card}>
          {line_items.map((li, i) => (
            <Section key={i} style={lineRow}>
              <Text style={lineLabel}>
                <strong>{li.label}</strong>
                {li.detail ? <span style={detail}> — {li.detail}</span> : null}
              </Text>
              <Text style={lineAmt}>{money(li.amount_cents)}</Text>
            </Section>
          ))}

          {discount_cents > 0 ? (
            <Section style={lineRow}>
              <Text style={lineLabel}>Referral discount</Text>
              <Text style={{ ...lineAmt, color: '#059669' }}>−{money(discount_cents)}</Text>
            </Section>
          ) : null}

          <Hr style={hr} />
          <Section style={lineRow}>
            <Text style={totalLabel}>Total charged</Text>
            <Text style={totalAmt}>{money(total_cents)}</Text>
          </Section>
        </Section>

        <Text style={text}>
          {status === 'submitted' || status === 'cleared'
            ? `We submitted an ACH debit for ${money(total_cents)} to your verified bank account${bank_last4 ? ` ending in ${bank_last4}` : ''}${charged_at ? ` on ${new Date(charged_at).toLocaleDateString()}` : ''}. Funds typically settle in 1–3 business days.`
            : `This is an invoice for ${money(total_cents)}. We will attempt the ACH debit from your verified bank account${bank_last4 ? ` ending in ${bank_last4}` : ''}.`}
        </Text>

        <Text style={text}>
          Questions? Just reply to this email.
        </Text>

        <Hr style={hr} />
        <Text style={footer}>
          {SITE_NAME} · Insurance restoration payment infrastructure
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: TenantInvoice,
  subject: (data: Record<string, any>) =>
    `${SITE_NAME} invoice${data?.invoice_number ? ` #${data.invoice_number}` : ''}${data?.period_label ? ` — ${data.period_label}` : ''}`,
  displayName: 'Tenant billing invoice',
  previewData: {
    tenant_name: 'Condition One Commercial',
    period_label: 'July 2026',
    invoice_number: 'INV-2026-07-001',
    line_items: [
      { label: 'Check processing', detail: '17 checks × $4.00', amount_cents: 6800 },
      { label: 'Actum disbursements', detail: '9 splits × $1.00', amount_cents: 900 },
      { label: 'Monthly maintenance', detail: 'July 2026', amount_cents: 10000 },
    ],
    discount_cents: 500,
    total_cents: 17200,
    bank_last4: '4821',
    status: 'submitted',
    charged_at: new Date().toISOString(),
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif' }
const container = { padding: '24px', maxWidth: '560px' }
const logoSection = { padding: '0 0 16px', borderBottom: '1px solid #e2e8f0', marginBottom: '16px' }
const logo = { display: 'block', height: 'auto' }
const h1 = { fontSize: '22px', fontWeight: 'bold' as const, color: '#0f172a', margin: '0 0 16px' }
const text = { fontSize: '14px', color: '#334155', lineHeight: '1.6', margin: '0 0 12px' }
const card = {
  backgroundColor: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  padding: '16px',
  margin: '16px 0',
}
const lineRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', margin: '4px 0' }
const lineLabel = { fontSize: '13px', color: '#0f172a', margin: 0 }
const lineAmt = { fontSize: '13px', color: '#0f172a', margin: 0, fontVariantNumeric: 'tabular-nums' as const }
const totalLabel = { fontSize: '14px', color: '#0f172a', margin: 0, fontWeight: 'bold' as const }
const totalAmt = { fontSize: '16px', color: '#0f172a', margin: 0, fontWeight: 'bold' as const, fontVariantNumeric: 'tabular-nums' as const }
const detail = { color: '#64748b', fontWeight: 'normal' as const }
const hr = { borderColor: '#e2e8f0', margin: '16px 0' }
const footer = { fontSize: '12px', color: '#64748b', margin: '0' }
