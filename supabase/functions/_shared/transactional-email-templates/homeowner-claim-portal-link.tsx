import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'ChecksOps'
const LOGO_URL = 'https://checksops.com/checksops-logo.png'

interface Props {
  homeowner_name?: string
  contractor_name?: string
  portal_url?: string
}

const Email = ({ homeowner_name, contractor_name, portal_url }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Your private claim portal with {contractor_name || 'your contractor'}</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={logoSection}>
          <Img src={LOGO_URL} alt={SITE_NAME} width="180" style={logo} />
        </Section>
        <Heading style={h1}>Your claim portal is ready</Heading>
        <Text style={text}>
          Hi {homeowner_name || 'there'} — thanks for reaching out through {SITE_NAME}. We've set
          up a private page just for your claim with <strong>{contractor_name || 'your contractor'}</strong>.
        </Text>
        <Text style={text}>
          From your portal you can sign the Direction to Pay, upload your insurance check, and
          watch every endorsement and deposit happen live. No account or password needed — the
          link below is your secure key back in.
        </Text>

        {portal_url ? (
          <Section style={{ textAlign: 'center', margin: '24px 0' }}>
            <Button href={portal_url} style={button}>Open my claim portal</Button>
          </Section>
        ) : null}

        <Section style={card}>
          <Text style={row}><strong>Bookmark this email.</strong> Anyone with this link can act on
          your claim, so please don't share it or forward this message.</Text>
        </Section>

        <Hr style={hr} />
        <Text style={footer}>
          You're getting this because you submitted a request on {SITE_NAME} Find-a-Pro. If this
          wasn't you, you can ignore this email.
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: Email,
  subject: (d: Record<string, any>) =>
    `Your ChecksOps claim portal${d?.contractor_name ? ` with ${d.contractor_name}` : ''}`,
  displayName: 'Homeowner claim portal link',
  previewData: {
    homeowner_name: 'Alex',
    contractor_name: 'Sunrise Restoration',
    portal_url: 'https://checksops.com/h/claim/example-token',
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
const row = { fontSize: '13px', color: '#0f172a', margin: '0' }
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
