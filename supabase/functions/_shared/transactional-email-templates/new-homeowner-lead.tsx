import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'ChecksOps'
const LOGO_URL = 'https://checksops.com/checksops-logo.png'

interface Props {
  contractor_name?: string
  homeowner_name?: string
  homeowner_email?: string
  homeowner_phone?: string
  property_zip?: string
  loss_type?: string
  message?: string
  leads_url?: string
}

const Email = ({
  contractor_name, homeowner_name, homeowner_email, homeowner_phone,
  property_zip, loss_type, message, leads_url,
}: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>New homeowner lead from {homeowner_name || 'a homeowner'} on Find-a-Pro</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={logoSection}>
          <Img src={LOGO_URL} alt={SITE_NAME} width="180" style={logo} />
        </Section>
        <Heading style={h1}>New homeowner lead</Heading>
        <Text style={text}>
          Hi {contractor_name || 'there'} — a homeowner just contacted you through the {SITE_NAME}
          {' '}Find-a-Pro directory. Respond quickly; the fastest reply usually wins the job.
        </Text>

        <Section style={card}>
          <Text style={row}><strong>Name:</strong> {homeowner_name || '—'}</Text>
          <Text style={row}><strong>Email:</strong> {homeowner_email || '—'}</Text>
          <Text style={row}><strong>Phone:</strong> {homeowner_phone || '—'}</Text>
          <Text style={row}><strong>Property ZIP:</strong> {property_zip || '—'}</Text>
          <Text style={row}><strong>Type of loss:</strong> {loss_type || '—'}</Text>
        </Section>

        {message ? (
          <>
            <Heading as="h2" style={h2}>What they wrote</Heading>
            <Text style={text}>{message}</Text>
          </>
        ) : null}

        {leads_url ? (
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button href={leads_url} style={button}>Open leads inbox</Button>
          </Section>
        ) : null}

        <Hr style={hr} />
        <Text style={footer}>
          You're getting this because your directory listing is published on {SITE_NAME}. You can
          update your listing or pause leads any time from your Find-a-Pro settings.
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: Email,
  subject: (d: Record<string, any>) =>
    `New homeowner lead${d?.homeowner_name ? ` — ${d.homeowner_name}` : ''}${d?.property_zip ? ` (ZIP ${d.property_zip})` : ''}`,
  displayName: 'New homeowner lead (contractor notification)',
  previewData: {
    contractor_name: 'Sunrise Restoration',
    homeowner_name: 'Alex Homeowner',
    homeowner_email: 'alex@example.com',
    homeowner_phone: '(305) 555-0142',
    property_zip: '33101',
    loss_type: 'Roof / Wind / Hail',
    message: 'Hurricane took part of my roof. Need help filing my claim and getting it fixed.',
    leads_url: 'https://checksops.com/settings',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif' }
const container = { padding: '24px', maxWidth: '560px' }
const logoSection = { padding: '0 0 16px', borderBottom: '1px solid #e2e8f0', marginBottom: '16px' }
const logo = { display: 'block', height: 'auto' }
const h1 = { fontSize: '22px', fontWeight: 'bold' as const, color: '#0f172a', margin: '0 0 16px' }
const h2 = { fontSize: '16px', fontWeight: 'bold' as const, color: '#0f172a', margin: '24px 0 8px' }
const text = { fontSize: '14px', color: '#334155', lineHeight: '1.6', margin: '0 0 12px' }
const card = {
  backgroundColor: '#f8fafc',
  border: '1px solid #e2e8f0',
  borderRadius: '8px',
  padding: '16px',
  margin: '16px 0',
}
const row = { fontSize: '14px', color: '#0f172a', margin: '4px 0' }
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
