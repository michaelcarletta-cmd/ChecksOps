import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'ChecksOps'
const LOGO_URL = 'https://checksops.com/checksops-logo.png'

interface Props {
  staff_name?: string
  homeowner_name?: string
  homeowner_email?: string
  partner_code?: string
  amount_estimate?: number | null
  homeowner_note?: string | null
  inbox_url?: string
}

const Email = ({
  staff_name, homeowner_name, homeowner_email,
  partner_code, amount_estimate, homeowner_note, inbox_url,
}: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>New homeowner check upload waiting for triage</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={logoSection}>
          <Img src={LOGO_URL} alt={SITE_NAME} width="180" style={{ display: 'block', height: 'auto' }} />
        </Section>
        <Heading style={h1}>New homeowner check upload</Heading>
        <Text style={text}>
          Hi {staff_name || 'there'} — a homeowner just uploaded a check on a link you sent. It's
          waiting in your Homeowner Uploads inbox for review and claim attach.
        </Text>

        <Section style={card}>
          <Row label="Homeowner" value={homeowner_name || homeowner_email || 'Unknown'} />
          {homeowner_email ? <Row label="Email" value={homeowner_email} /> : null}
          {partner_code ? <Row label="Partner code" value={partner_code} /> : null}
          {amount_estimate != null ? (
            <Row label="Amount (est.)" value={new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(amount_estimate))} />
          ) : null}
          {homeowner_note ? <Row label="Note" value={homeowner_note} /> : null}
        </Section>

        {inbox_url ? (
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button href={inbox_url} style={button}>Open Homeowner Uploads</Button>
          </Section>
        ) : null}

        <Hr style={hr} />
        <Text style={footer}>
          You received this because you sent this homeowner an upload link tagged with your partner code.
        </Text>
      </Container>
    </Body>
  </Html>
)

const Row = ({ label, value }: { label: string; value: string }) => (
  <Text style={row}><strong>{label}:</strong> {value}</Text>
)

export const template = {
  component: Email,
  subject: (d: Record<string, any>) =>
    `New homeowner check upload${d?.partner_code ? ` (${d.partner_code})` : ''}`,
  displayName: 'Homeowner upload alert (staff)',
  previewData: {
    staff_name: 'Alex',
    homeowner_name: 'Jane Doe',
    homeowner_email: 'jane@example.com',
    partner_code: 'FRDM01',
    amount_estimate: 12500,
    homeowner_note: 'Front and back scanned on my phone.',
    inbox_url: 'https://checksops.com/checks',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif' }
const container = { padding: '24px', maxWidth: '560px' }
const logoSection = { padding: '0 0 16px', borderBottom: '1px solid #e2e8f0', marginBottom: '16px' }
const h1 = { fontSize: '22px', fontWeight: 'bold' as const, color: '#0f172a', margin: '0 0 16px' }
const text = { fontSize: '14px', color: '#334155', lineHeight: '1.6', margin: '0 0 12px' }
const card = {
  backgroundColor: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  padding: '16px',
  margin: '16px 0',
}
const row = { fontSize: '13px', color: '#0f172a', margin: '0 0 6px' }
const button = {
  backgroundColor: '#0f172a',
  color: '#ffffff',
  padding: '12px 24px',
  borderRadius: '8px',
  fontSize: '14px',
  fontWeight: 'bold' as const,
  textDecoration: 'none',
}
const hr = { borderColor: '#e2e8f0', margin: '24px 0' }
const footer = { fontSize: '12px', color: '#64748b', margin: '0' }
