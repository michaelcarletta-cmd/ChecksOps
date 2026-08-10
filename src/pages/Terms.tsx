import { useEffect } from "react";
import { Link } from "react-router-dom";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";

const EFFECTIVE_DATE = "August 5, 2026";
const CONTACT_EMAIL = "support@checksops.com";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-3 scroll-mt-24">
      <h2 className="text-xl font-semibold text-foreground">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export default function Terms() {
  useEffect(() => {
    document.title = "Terms of Service | ChecksOps";
    const desc = document.querySelector('meta[name="description"]');
    if (desc) {
      desc.setAttribute(
        "content",
        "ChecksOps Terms of Service — the agreement governing use of the ChecksOps check workflow, endorsement, deposit, and disbursement platform."
      );
    }
  }, []);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 md:px-6 py-12 space-y-10">
        <header className="space-y-3">
          <Link to="/" className="inline-block">
            <CheckOpsLogo className="text-foreground h-8" />
          </Link>
          <h1 className="text-3xl font-semibold">Terms of Service</h1>
          <p className="text-sm text-muted-foreground">Effective {EFFECTIVE_DATE}</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            These Terms of Service (the "Terms") govern access to and use of the ChecksOps platform,
            websites, and related services (the "Service"). By creating an account, accessing the
            Service, or clicking to accept these Terms, you agree to be bound by them. If you are
            agreeing on behalf of a company or other organization, you represent that you have
            authority to bind that organization, and "you" refers to that organization.
          </p>
        </header>

        <Section id="service" title="1. The Service">
          <p>
            ChecksOps is workflow software for the insurance restoration industry. It supports check
            intake and data extraction, endorsement collection, loss draft and mortgage
            correspondence, deposit submission, and disbursement instructions to third-party
            payment providers.
          </p>
          <p>
            ChecksOps is not a bank, lender, escrow agent, money transmitter, insurance carrier,
            public adjuster, or law firm. Banking, deposit, and payment functions are performed by
            regulated third-party financial institutions and payment providers. You remain
            responsible for all deposit, endorsement, compliance, and fund release decisions made
            through the Service.
          </p>
        </Section>

        <Section id="accounts" title="2. Accounts and access">
          <p>
            You must provide accurate registration information and keep it current. You are
            responsible for all activity under your account and for safeguarding credentials. You
            must promptly notify us at {CONTACT_EMAIL} of any suspected unauthorized access.
          </p>
          <p>
            Accounts are provisioned per organization. You are responsible for the acts and
            omissions of your users, employees, contractors, and anyone you invite into your
            workspace.
          </p>
        </Section>

        <Section id="acceptable-use" title="3. Acceptable use">
          <p>You agree not to:</p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>upload, endorse, deposit, or attempt to deposit any instrument you are not legally entitled to negotiate;</li>
            <li>submit an instrument that has already been deposited or negotiated elsewhere;</li>
            <li>forge, alter, or cause the collection of any signature or endorsement without the signer's authorization;</li>
            <li>use the Service for money laundering, fraud, or any unlawful purpose;</li>
            <li>attempt to access another organization's data, probe or circumvent security controls, or interfere with the Service;</li>
            <li>reverse engineer, resell, or provide the Service to third parties except as expressly permitted; or</li>
            <li>upload malware or content that infringes the rights of others.</li>
          </ul>
          <p>
            We may suspend access immediately where we reasonably believe continued use presents a
            legal, security, financial, or fraud risk.
          </p>
        </Section>

        <Section id="payments" title="4. Checks, deposits, and disbursements">
          <p>
            Deposit and disbursement services are provided by third-party financial partners subject
            to their own terms, verification requirements, cut-off times, and funds-availability
            policies. Availability of funds, settlement timing, and delivery speed are determined by
            those partners and the receiving institutions, not by ChecksOps.
          </p>
          <p>
            You are solely responsible for the accuracy of payee information, account and routing
            details, amounts, and payment instructions submitted through the Service. Payments sent
            to an incorrect recipient because of information you provided may not be recoverable.
          </p>
          <p>
            You represent that each check submitted is genuine, that you have the right to deposit
            it, that all required endorsements have been obtained, and that the original instrument
            will be securely retained and destroyed in accordance with applicable law and your
            financial institution's requirements.
          </p>
          <p>
            <strong className="text-foreground">Role clarification.</strong> ChecksOps is a software
            platform used by restoration contractors and public adjusters to manage their own claim
            proceeds. ChecksOps is not a payment facilitator, payfac, or aggregator: we do not
            underwrite, sponsor, or onboard sub-merchants, and we do not settle funds on behalf of
            unaffiliated merchants. Each customer contracts directly with the applicable financial
            partner and is onboarded and underwritten by that partner. Funds move from a customer's
            own verified account to that customer's own payees — contractors, subcontractors,
            vendors, sales representatives, and policyholders they work with.
          </p>
          <p>
            <strong className="text-foreground">No carrier or lender relationship.</strong> ChecksOps
            has no contractual, agency, or referral relationship with any insurance carrier or
            mortgage lender, and does not onboard, sponsor, or process payments for carriers or
            lenders. Carriers and mortgage servicers appear in the Service only as third parties
            named on a customer's check or correspondence. ChecksOps does not source funds from
            mortgage or insurance companies; funds are sourced directly from our customers'
            business accounts to pay their own stakeholders. Verification of funds origin is
            conducted by the third-party financial partner at the time of account funding and
            deposit.
          </p>
          <p>
            <strong className="text-foreground">Customer Sourcing.</strong> ChecksOps sources
            customers through direct sales, industry partnerships, and marketing within the
            insurance restoration and public adjusting sectors. We do not rely on relationships
            with insurance carriers or mortgage companies for customer acquisition.
          </p>
        </Section>


        <Section id="fees" title="5. Fees and billing">
          <p>
            Subscription fees, per-transaction fees, and delivery-speed fees are those presented to
            you in the Service or in your order form. Unless stated otherwise, fees are billed in
            advance for subscriptions and at the time of processing for transaction fees, are
            non-refundable except as required by law, and are exclusive of taxes.
          </p>
          <p>
            Where you authorize it, transaction and platform fees may be debited from a bank account
            or wallet balance you designate. You are responsible for maintaining sufficient funds.
            We may suspend the Service for unpaid amounts after notice.
          </p>
        </Section>

        <Section id="data" title="6. Your data">
          <p>
            You retain all rights in the claim, check, document, and customer data you submit ("Your
            Data"). You grant ChecksOps a limited license to host, process, transmit, and display
            Your Data solely to provide, secure, and support the Service, and to comply with law.
          </p>
          <p>
            You are responsible for having the necessary rights and consents to submit Your Data,
            including any consumer financial information, and for providing required privacy
            notices. Our handling of consumer financial information is described in our{" "}
            <Link to="/privacy-notice" className="text-primary underline underline-offset-2">
              Privacy Notice
            </Link>
            .
          </p>
          <p>
            We may use aggregated, de-identified data that does not identify you, your customers, or
            any individual to operate and improve the Service.
          </p>
        </Section>

        <Section id="ai" title="7. Automated processing and AI features">
          <p>
            The Service uses automated extraction and AI-assisted features to read documents,
            suggest data values, and draft correspondence. These outputs are assistive only, may
            contain errors, and are not legal, financial, insurance, or tax advice. You must review
            and verify all extracted data and generated content before relying on it or acting on
            it.
          </p>
        </Section>

        <Section id="third-party" title="8. Third-party services">
          <p>
            The Service integrates with third-party providers for banking, payments, identity and
            bank verification, communications, and document delivery. Your use of those integrations
            may require you to accept the provider's terms, and we are not responsible for their
            acts, omissions, availability, or decisions, including a provider's refusal to onboard
            you or process a transaction.
          </p>
        </Section>

        <Section id="ip" title="9. Intellectual property">
          <p>
            ChecksOps and its licensors own all rights in the Service, including software,
            interfaces, and trademarks. Subject to these Terms and payment of applicable fees, we
            grant you a non-exclusive, non-transferable, revocable right to access and use the
            Service for your internal business purposes. Feedback you provide may be used without
            restriction or obligation.
          </p>
        </Section>

        <Section id="confidentiality" title="10. Confidentiality">
          <p>
            Each party may receive non-public information of the other. The receiving party will
            protect it with at least reasonable care, use it only to perform under these Terms, and
            disclose it only to personnel and contractors bound by similar obligations or as
            required by law.
          </p>
        </Section>

        <Section id="warranty" title="11. Disclaimers">
          <p className="uppercase text-xs tracking-wide">
            The Service is provided "as is" and "as available." To the maximum extent permitted by
            law, ChecksOps disclaims all warranties, express or implied, including merchantability,
            fitness for a particular purpose, title, and non-infringement. We do not warrant that
            the Service will be uninterrupted, error-free, or that automated extraction will be
            accurate.
          </p>
        </Section>

        <Section id="liability" title="12. Limitation of liability">
          <p className="uppercase text-xs tracking-wide">
            To the maximum extent permitted by law, neither party will be liable for indirect,
            incidental, special, consequential, exemplary, or punitive damages, or for lost profits,
            revenue, goodwill, or data. ChecksOps' total aggregate liability arising out of or
            relating to these Terms or the Service will not exceed the fees you paid to ChecksOps in
            the twelve months preceding the event giving rise to the claim.
          </p>
          <p>
            These limits do not apply to your payment obligations, your breach of Section 3
            (Acceptable use), or liability that cannot be limited under applicable law.
          </p>
        </Section>

        <Section id="indemnity" title="13. Indemnification">
          <p>
            You will defend, indemnify, and hold harmless ChecksOps and its officers, employees, and
            agents from third-party claims, losses, and expenses (including reasonable attorneys'
            fees) arising from Your Data, your use of the Service, your payment instructions, your
            endorsement practices, or your violation of these Terms or applicable law.
          </p>
        </Section>

        <Section id="term" title="14. Term, suspension, and termination">
          <p>
            These Terms apply for as long as you use the Service. Either party may terminate a
            subscription at the end of the then-current term by providing notice, unless your order
            form says otherwise. We may suspend or terminate access for material breach, non-payment,
            or legal or security risk.
          </p>
          <p>
            On termination, your right to use the Service ends. You may request an export of Your
            Data within 30 days of termination, after which we may delete it, subject to records we
            are required to retain by law or by our financial partners.
          </p>
        </Section>

        <Section id="changes" title="15. Changes to the Service or Terms">
          <p>
            We may modify the Service and these Terms. Material changes take effect on the date
            posted, and we will make reasonable efforts to notify account administrators. Continued
            use after the effective date constitutes acceptance.
          </p>
        </Section>

        <Section id="law" title="16. Governing law and disputes">
          <p>
            These Terms are governed by the laws of the State of New Jersey, without regard to
            conflict-of-law rules. The parties submit to the exclusive jurisdiction of the state and
            federal courts located in New Jersey. Each party waives any right to a jury trial and to
            participate in a class action to the extent permitted by law.
          </p>
        </Section>

        <Section id="general" title="17. General">
          <p>
            These Terms, together with any order form and our Privacy Notice, are the entire
            agreement between the parties. If any provision is unenforceable, the remainder stays in
            effect. Neither party is liable for delays caused by events beyond its reasonable
            control. You may not assign these Terms without our consent; we may assign them in
            connection with a merger, acquisition, or sale of assets. Failure to enforce a provision
            is not a waiver.
          </p>
        </Section>

        <Section id="contact" title="18. Contact">
          <p>
            Questions about these Terms can be sent to{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-primary underline underline-offset-2">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </Section>

        <footer className="border-t border-border/40 pt-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground">Home</Link>
          <Link to="/privacy-notice" className="hover:text-foreground">Privacy Notice</Link>
          <Link to="/security" className="hover:text-foreground">Security</Link>
          <span className="ml-auto">© {new Date().getFullYear()} ChecksOps</span>
        </footer>
      </div>
    </main>
  );
}
