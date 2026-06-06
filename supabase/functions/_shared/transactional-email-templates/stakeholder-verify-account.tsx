import * as React from 'npm:react@18.3.1'
import {
  Body, Button, Container, Head, Heading, Hr, Html, Img, Preview, Section, Text,
} from 'npm:@react-email/components@0.0.22'
import type { TemplateEntry } from './registry.ts'

const SITE_NAME = 'ChecksOps'
const LOGO_URL = 'https://checksops.com/checksops-logo.png'

interface Props {
  nickname?: string
  custname?: string
  lastFour?: string
  verifyUrl?: string
}

const Email = ({ nickname, custname, lastFour, verifyUrl }: Props) => (
  <Html lang="en" dir="ltr">
    <Head />
    <Preview>Confirm two small deposits to verify your bank account</Preview>
    <Body style={main}>
      <Container style={container}>
        <Section style={logoSection}>
          <Img src={LOGO_URL} alt={SITE_NAME} width="180" style={logo} />
        </Section>
        <Heading style={h1}>Verify your bank account</Heading>
        <Text style={text}>
          {custname ? `Hi ${custname},` : 'Hi,'}
        </Text>
        <Text style={text}>
          To start receiving ACH payments from {SITE_NAME}, we need to confirm
          that you own the account ending in <strong>••••{lastFour ?? '----'}</strong>
          {nickname ? <> ({nickname})</> : null}.
        </Text>
        <Text style={text}>
          In the next 1–2 business days you'll see <strong>two small deposits</strong>
          {' '}from us in your bank account (each less than $0.25). Once they
          arrive, click the button below and enter the exact amounts to verify
          your account.
        </Text>

        <Section style={{ textAlign: 'center', margin: '24px 0' }}>
          <Button href={verifyUrl} style={button}>
            Confirm deposits
          </Button>
        </Section>

        <Text style={smallText}>
          Or paste this link into your browser:<br />
          <span style={{ wordBreak: 'break-all', color: '#475569' }}>{verifyUrl}</span>
        </Text>

        <Hr style={hr} />
        <Text style={footer}>
          You're getting this because your account was added to {SITE_NAME} for
          ACH disbursements. If you don't recognize this request, you can
          safely ignore this email — no money will move until you confirm.
        </Text>
      </Container>
    </Body>
  </Html>
)

export const template = {
  component: Email,
  subject: 'Verify your bank account with ChecksOps',
  displayName: 'Stakeholder bank account verification',
  previewData: {
    nickname: 'Operating account',
    custname: 'Acme Roofing LLC',
    lastFour: '4321',
    verifyUrl: 'https://checksops.com/verify-account/example-token',
  },
} satisfies TemplateEntry

const main = { backgroundColor: '#ffffff', fontFamily: 'Arial, sans-serif' }
const container = { padding: '24px', maxWidth: '560px' }
const logoSection = { padding: '0 0 16px', borderBottom: '1px solid #e2e8f0', marginBottom: '16px' }
const logo = { display: 'block', height: 'auto' }
const h1 = { fontSize: '22px', fontWeight: 'bold' as const, color: '#0f172a', margin: '0 0 16px' }
const text = { fontSize: '14px', color: '#334155', lineHeight: '1.6', margin: '0 0 12px' }
const smallText = { fontSize: '12px', color: '#64748b', lineHeight: '1.5', margin: '8px 0' }
const button = {
  backgroundColor: '#0f172a',
  color: '#ffffff',
  padding: '12px 24px',
  borderRadius: '6px',
  fontSize: '14px',
  fontWeight: 'bold' as const,
  textDecoration: 'none',
  display: 'inline-block',
}
const hr = { borderColor: '#e2e8f0', margin: '24px 0' }
const footer = { fontSize: '12px', color: '#64748b', margin: '0' }
