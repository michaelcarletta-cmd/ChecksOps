import * as React from 'npm:react@18.3.1'
import {
  Body, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'ChecksOps'
const LOGO_URL = 'https://checksops.com/checksops-logo.png'

interface DemoRequestProps {
  name?: string
  email?: string
  company?: string
  role?: string
  notes?: string
}

const DemoRequestEmail = ({ name, email, company, role, notes }: DemoRequestProps) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>New {SITE_NAME} demo request from {name || 'a prospect'}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={logoSection}>
          <Img src={LOGO_URL} alt={SITE_NAME} width="320" style={logo} />
        </Section>
        <Heading style={h1}>New demo request</Heading>
        <Text style={text}>
          Someone just submitted the live demo form on {SITE_NAME}.
        </Text>

        <Section style={card}>
          <Text style={row}><strong>Name:</strong> {name || '—'}</Text>
          <Text style={row}><strong>Email:</strong> {email || '—'}</Text>
          <Text style={row}><strong>Company:</strong> {company || '—'}</Text>
          <Text style={row}><strong>Role:</strong> {role || '—'}</Text>
        </Section>

        {notes ? (
          <>
            <Heading as="h2" style={h2}>What they want to see</Heading>
            <Text style={text}>{notes}</Text>
          </>
        ) : null}

        <Hr style={hr} />
        <Text style={footer}>
          Reply directly to this email to reach the prospect, or reach out from your
          regular inbox at {email || 'their address above'}.
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: DemoRequestEmail,
  subject: (data: Record<string, any>) =>
    `New ChecksOps demo request${data?.company ? ` — ${data.company}` : data?.name ? ` — ${data.name}` : ''}`,
  displayName: 'Demo request (internal notification)',
  previewData: {
    name: 'Jane Adjuster',
    email: 'jane@firmexample.com',
    company: 'Firm Example LLP',
    role: 'Partner',
    notes: 'Interested in the endorsement workflow and partner sharing.',
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
const hr = { borderColor: '#e2e8f0', margin: '24px 0' }
const footer = { fontSize: '12px', color: '#64748b', margin: '0' }
