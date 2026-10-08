import type { Metadata } from "next";
import Link from "next/link";

import {
  LegalCallout,
  LegalConspicuous,
  LegalDefinitions,
  LegalDocument,
  type LegalHighlight,
  type LegalSection,
} from "@/components/marketing/legal-document";
import {
  formatPublicPlatformPrice,
  PUBLIC_PAYMENTS_FEE_PERCENT,
  PUBLIC_PLATFORM_TRIAL_DAYS,
} from "@/lib/constants";
import { legalContact } from "@/lib/legal-documents";

const description =
  "The agreement between Koaryu and the studios, staff and payers who use Koaryu's studio management and billing tools.";

export const metadata: Metadata = {
  title: "Terms of Service | Koaryu",
  description,
  alternates: { canonical: "https://koaryu.app/terms" },
  openGraph: {
    title: "Terms of Service | Koaryu",
    description,
    url: "https://koaryu.app/terms",
  },
};

const price = formatPublicPlatformPrice();
const trialDays = PUBLIC_PLATFORM_TRIAL_DAYS;
const paymentsFee = `${PUBLIC_PAYMENTS_FEE_PERCENT}%`;
const supportEmail = legalContact.email;

const SupportEmail = () => <a href={`mailto:${supportEmail}`}>{supportEmail}</a>;

const highlights: readonly LegalHighlight[] = [
  {
    title: "An agreement with your studio",
    text: "The person who signs up accepts these Terms for their studio, and the studio is responsible for how its staff use Koaryu.",
  },
  {
    title: "Your records stay yours",
    text: "Your studio owns the data it puts into Koaryu. We use it only to run, secure and support the service.",
  },
  {
    title: `${trialDays} days free, then ${price} a month`,
    text: "One trial per new studio, with a payment method added at checkout. The subscription renews monthly until you cancel in Billing.",
  },
  {
    title: "Your studio is the seller",
    text: `With Koaryu Payments, Stripe processes the charges and your studio deals with refunds and disputes. Koaryu's fee is ${paymentsFee} per successful charge, plus Stripe's fees.`,
  },
  {
    title: "Limits on our liability",
    text: "Koaryu is provided as is, and our total liability is capped at what you paid us in the previous 12 months, or US$100 if that is more.",
  },
  {
    title: "Arbitration, not court",
    text: "Most disputes go to individual arbitration under California law, with no class actions. You can opt out within 30 days.",
  },
];

const sections: readonly LegalSection[] = [
  {
    id: "agreement",
    title: "Agreement to these Terms",
    body: (
      <>
        <p>
          These Terms of Service (the &ldquo;Terms&rdquo;) govern your access to and use of the
          Koaryu website at koaryu.app, the Koaryu web application and the related services we
          provide (together, the &ldquo;Service&rdquo;). &ldquo;Koaryu,&rdquo; &ldquo;we,&rdquo;
          &ldquo;us&rdquo; and &ldquo;our&rdquo; mean the operator of the Service.
        </p>
        <p>
          If you create an account or use the Service for a martial arts school or other business (a
          &ldquo;Studio&rdquo;), you accept these Terms on behalf of that Studio and confirm you
          have the authority to do so. In that case &ldquo;you&rdquo; means the Studio and, where
          the context requires, you as an individual user.
        </p>
        <p>
          You accept these Terms when you create an account, start a trial, sign in or otherwise use
          the Service. Our <Link href="/privacy">Privacy Policy</Link> explains how we handle
          personal information and is part of these Terms. If you don&rsquo;t agree, don&rsquo;t use
          the Service.
        </p>
        <LegalCallout label="Please read the dispute section">
          <p>
            The <a href="#disputes">Dispute resolution</a> section requires most disputes to be
            resolved through individual binding arbitration and waives class actions and jury
            trials. You can opt out within 30 days, as described there.
          </p>
        </LegalCallout>
      </>
    ),
  },
  {
    id: "definitions",
    title: "Key terms",
    body: (
      <>
        <p>These words have the following meanings throughout the Terms.</p>
        <LegalDefinitions
          items={[
            {
              term: "Studio",
              definition:
                "The martial arts school or other business that holds a Koaryu account, together with its workspace in the Service.",
            },
            {
              term: "Staff User",
              definition:
                "A person who uses a Studio's workspace as an Admin, Front Desk or Instructor, whether they signed up or were invited.",
            },
            {
              term: "Studio Data",
              definition:
                "Information a Studio or its Staff Users enter, upload, import or create in the Service, including records about students, guardians, leads, staff, classes, attendance, ranks and billing.",
            },
            {
              term: "Payer",
              definition:
                "A person or household a Studio bills through the Service, such as a parent or guardian who pays a student's tuition.",
            },
            {
              term: "Koaryu Core",
              definition: "The paid subscription that gives a Studio access to the Service.",
            },
            {
              term: "Koaryu Payments",
              definition:
                "The optional feature that lets an eligible Studio collect payments from Payers through Stripe Connect.",
            },
            {
              term: "Stripe",
              definition:
                "Stripe, Inc. and its affiliates, which process subscription and Koaryu Payments transactions.",
            },
          ]}
        />
      </>
    ),
  },
  {
    id: "accounts",
    title: "Eligibility, accounts and staff access",
    body: (
      <>
        <p>
          To accept these Terms for a Studio, you must be at least 18 years old, or the age of
          majority where you live if that is higher. Staff Users must be at least 16. The Service is
          a tool for studio staff: students, parents and guardians don&rsquo;t receive Koaryu
          accounts, and the Service is not directed to children.
        </p>
        <ul>
          <li>
            <strong>Accurate information.</strong> Give us accurate account and Studio information
            and keep it current.
          </li>
          <li>
            <strong>Sign-in security.</strong> You can sign in with an email and password or with a
            Google or Microsoft account. Keep your credentials confidential, don&rsquo;t share an
            account, and tell us right away at <SupportEmail /> if you suspect unauthorized access.
          </li>
          <li>
            <strong>Staff roles.</strong> Each Staff User has a role (Admin, Front Desk or
            Instructor) that controls what they can see and change. The Studio decides who gets
            access and which role they hold, and should remove access promptly when someone no
            longer needs it.
          </li>
          <li>
            <strong>Responsibility for activity.</strong> The Studio is responsible for everything
            done in its workspace by its Staff Users and for their compliance with these Terms.
          </li>
          <li>
            <strong>Audit records.</strong> The Service records certain actions, such as promotions,
            billing changes, exports and changes to staff and accounts, so Studios can see who did
            what and so we can investigate problems.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "koaryu-core",
    title: "Koaryu Core subscription, trial and billing",
    body: (
      <>
        <h3>Price</h3>
        <p>
          Koaryu Core costs {price} (US dollars) per Studio per month, as shown at checkout. One
          subscription covers one Studio, with no per-student tiers.
        </p>
        <h3>Free trial</h3>
        <p>
          Each new Studio may receive one {trialDays}-day free trial. To start it, you add a payment
          method at Stripe Checkout. You won&rsquo;t be charged during the trial. Unless you cancel
          before the trial ends, your paid subscription starts automatically and your payment method
          is charged the monthly fee. We may decline a trial for a Studio that has already had a
          trial or a subscription.
        </p>
        <h3>Automatic renewal</h3>
        <LegalConspicuous>
          Your subscription renews automatically every month, and you authorize us, through Stripe,
          to charge the monthly fee plus any applicable taxes to your payment method at the start of
          each billing period until you cancel.
        </LegalConspicuous>
        <h3>Cancellation</h3>
        <p>
          You can cancel at any time in Koaryu under Billing, which opens Stripe&rsquo;s secure
          billing portal. Cancellation stops future renewals. Unless the portal shows otherwise when
          you confirm, your access continues until the end of the period you have already paid for.
          If you cancel during the free trial, you won&rsquo;t be charged.
        </p>
        <h3>Payments, taxes and failed payments</h3>
        <p>
          Stripe processes subscription payments; we don&rsquo;t receive or store your full card
          number. Prices don&rsquo;t include taxes unless stated, and you are responsible for any
          taxes that apply to your purchase. If a payment fails, Stripe may retry it. If the
          subscription lapses, the Studio&rsquo;s workspace, including exports, is unavailable until
          the subscription is active again. Studio Data is kept, as described in{" "}
          <a href="#termination">Suspension and termination</a>.
        </p>
        <h3>Refunds</h3>
        <p>
          Fees are non-refundable except where the law requires a refund or these Terms say
          otherwise. If we charge you in error, contact us and we will correct it.
        </p>
        <h3>Price changes</h3>
        <p>
          We will tell you at least 30 days before a price change applies to your subscription. The
          new price takes effect at your next renewal after the notice period, and you can cancel
          before then if you don&rsquo;t want to continue.
        </p>
      </>
    ),
  },
  {
    id: "koaryu-payments",
    title: "Koaryu Payments",
    body: (
      <>
        <p>
          Koaryu Payments is optional, requires separate activation and is not yet generally
          available. We decide which Studios are eligible, and we may limit, pause or end the
          feature for a Studio, for example where Stripe requires it or where we see a risk of fraud
          or loss.
        </p>
        <h3>Stripe&rsquo;s terms</h3>
        <p>
          Payment processing services for Studios on Koaryu Payments are provided by Stripe and are
          subject to the{" "}
          <a href="https://stripe.com/connect-account/legal" rel="noopener noreferrer">
            Stripe Connected Account Agreement
          </a>
          , which includes the Stripe Terms of Service (collectively, the &ldquo;Stripe Services
          Agreement&rdquo;). By agreeing to these Terms or continuing to operate as a Studio on
          Koaryu Payments, you agree to be bound by the Stripe Services Agreement, as Stripe may
          modify it from time to time. As a condition of Koaryu enabling payment processing services
          through Stripe, you agree to provide Koaryu accurate and complete information about you
          and your business, and you authorize Koaryu to share it and transaction information
          related to your use of the payment processing services provided by Stripe.
        </p>
        <p>
          Koaryu is not a bank, money transmitter or payment processor, and does not hold Studio or
          Payer funds. Stripe controls payouts and may delay, hold, reserve or reject payments under
          its own terms. We cannot override Stripe&rsquo;s decisions.
        </p>
        <h3>Your Studio is the seller</h3>
        <p>
          Charges are made on your Studio&rsquo;s own Stripe account. You set your prices and
          tuition terms, and you are responsible for your agreements with families, your
          cancellation and refund policies, receipts, and compliance with consumer protection, tax
          and payment network rules.
        </p>
        <h3>Fees</h3>
        <p>
          Koaryu&rsquo;s standard fee is {paymentsFee} of each successful charge, unless a different
          rate is agreed when your Studio is activated. Stripe&rsquo;s processing fees apply in
          addition. Fees are deducted from the charge. If a payment is refunded, Koaryu&rsquo;s fee
          is refunded in proportion to the amount refunded; Stripe&rsquo;s fees follow
          Stripe&rsquo;s terms.
        </p>
        <h3>Payer authorization and autopay</h3>
        <ul>
          <li>
            Get the Payer&rsquo;s authorization before you charge them, and before you set up
            recurring charges.
          </li>
          <li>
            Payers accept autopay terms themselves on Stripe&rsquo;s checkout page. Staff cannot
            accept payment terms on a Payer&rsquo;s behalf.
          </li>
          <li>
            Honor a Payer&rsquo;s request to stop autopay, and keep billing plans and amounts
            accurate.
          </li>
        </ul>
        <h3>Refunds, disputes and chargebacks</h3>
        <p>
          Your Studio is responsible for refunds, disputes, chargebacks, reversals, negative
          balances and related fees on its transactions, as set out in the Stripe Services
          Agreement. If we are charged an amount that results from your Studio&rsquo;s transactions,
          you will reimburse us.
        </p>
        <h3>Payments recorded outside Koaryu</h3>
        <p>
          Recording a cash, check or other outside payment in Koaryu is recordkeeping only. Koaryu
          does not receive, hold or move those funds.
        </p>
      </>
    ),
  },
  {
    id: "payers",
    title: "If you pay a studio through Koaryu",
    body: (
      <>
        <p>
          This section applies to you if you are a Payer who enters payment details on a checkout
          page your Studio sends you.
        </p>
        <ul>
          <li>
            Your agreement for classes, tuition, cancellations and refunds is with your Studio, not
            with Koaryu. Contact your Studio first about any charge.
          </li>
          <li>
            Stripe processes your payment details. Koaryu does not receive your full card or bank
            account number.
          </li>
          <li>
            If you set up autopay, you authorize your Studio to charge your payment method as
            described when you accept, until you cancel. To cancel, contact your Studio. You also
            keep any rights you have with your bank or card issuer.
          </li>
          <li>
            Our <Link href="/privacy">Privacy Policy</Link> explains what happens to your
            information.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "studio-data",
    title: "Studio Data",
    body: (
      <>
        <h3>Ownership</h3>
        <p>
          As between you and Koaryu, your Studio keeps all rights in Studio Data. You give us a
          non-exclusive, worldwide, royalty-free license to host, copy, process, transmit and
          display Studio Data only as needed to provide, secure, support and maintain the Service,
          to comply with law, and as our Privacy Policy describes. We do not sell Studio Data.
        </p>
        <h3>Your responsibilities</h3>
        <ul>
          <li>
            You are responsible for the accuracy, quality and legality of Studio Data and for how
            you collected it.
          </li>
          <li>
            Give the notices and obtain the consents the law requires before you add someone&rsquo;s
            information, including consent from a parent or guardian for a child&rsquo;s information
            and photo where required.
          </li>
          <li>
            Only add what your Studio needs. Don&rsquo;t use notes or other free-text fields for
            medical diagnoses, government ID numbers, full card or bank account numbers, passwords
            or similar sensitive information.
          </li>
        </ul>
        <h3>How we handle it</h3>
        <p>
          We process Studio Data on your Studio&rsquo;s behalf and according to the instructions you
          give through the Service. If a student, guardian or other person asks us about their
          information in your workspace, we will refer them to you and help you respond.
        </p>
        <h3>Archiving, exports and deletion</h3>
        <ul>
          <li>
            Archiving a student removes them from active lists but keeps the record. To permanently
            delete a record, an Admin can contact us.
          </li>
          <li>
            While your subscription is active, Admins can export many records as CSV files from
            Reports, and Front Desk staff can export some of them. Some billing exports are not
            currently available. Keep your own copies of anything you need.
          </li>
        </ul>
        <h3>Aggregated data</h3>
        <p>
          We may create aggregated or de-identified information, such as performance measurements
          and usage counts, that does not identify your Studio or any person, and use it to operate
          and improve the Service.
        </p>
      </>
    ),
  },
  {
    id: "privacy-and-security",
    title: "Privacy and security",
    body: (
      <>
        <p>
          Our <Link href="/privacy">Privacy Policy</Link> describes how we collect, use and protect
          personal information. We maintain reasonable administrative, technical and organizational
          safeguards designed to protect Studio Data, including role-based access checks, database
          access controls and encryption in transit.
        </p>
        <p>
          No system is perfectly secure. If we become aware of unauthorized access to Studio Data in
          our systems, we will notify the affected Studio without undue delay and give it the
          information it reasonably needs to meet its own obligations.
        </p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>You agree not to, and not to let anyone else:</p>
        <ol>
          <li>
            break the law or infringe anyone&rsquo;s rights, including privacy and publicity rights,
            through the Service;
          </li>
          <li>
            add information you have no right to use, or information collected without a notice or
            consent the law requires;
          </li>
          <li>
            charge anyone without authorization, or use Koaryu Payments for a business or
            transaction Stripe does not allow;
          </li>
          <li>
            access another Studio&rsquo;s data or any account, record or system you are not
            authorized to use;
          </li>
          <li>
            probe, scan or test the Service for vulnerabilities, or get around security, rate limits
            or access controls. If you find a security issue, please report it to us instead;
          </li>
          <li>
            upload malware, or interfere with or overload the Service, including by load testing;
          </li>
          <li>
            scrape the Service, or access it by automated means other than features we provide;
          </li>
          <li>
            copy, modify, reverse engineer or decompile the Service, except where the law allows it
            despite this restriction;
          </li>
          <li>
            resell, sublicense or rent the Service, offer it to others as a service, or use it to
            build a competing product;
          </li>
          <li>share login credentials, or impersonate another person or organization; or</li>
          <li>use contact details stored in Koaryu to harass anyone or send unlawful messages.</li>
        </ol>
      </>
    ),
  },
  {
    id: "third-party-services",
    title: "Third-party services",
    body: (
      <>
        <p>
          The Service depends on and connects to services run by other companies, including Stripe
          for payments, Google and Microsoft for optional sign-in, and the hosting providers listed
          in our <Link href="/privacy#sharing">Privacy Policy</Link>. Your use of a third-party
          service may be subject to that company&rsquo;s own terms and privacy policy.
        </p>
        <p>
          We are not responsible for third-party services we don&rsquo;t control. Changes they make
          may affect parts of the Service.
        </p>
      </>
    ),
  },
  {
    id: "intellectual-property",
    title: "Koaryu's intellectual property",
    body: (
      <>
        <p>
          Koaryu and its licensors own the Service, including its software, design, text, graphics
          and the Koaryu name and logo. Subject to these Terms and payment of applicable fees, we
          give your Studio a limited, non-exclusive, non-transferable and revocable right to access
          and use the Service for its internal business during its subscription. We reserve all
          rights not expressly granted.
        </p>
        <p>
          If you send us feedback or suggestions, we may use them without any obligation to you.
          Sample studios, people and records in our demo and marketing pages are fictional.
        </p>
      </>
    ),
  },
  {
    id: "availability",
    title: "Availability, support and changes",
    body: (
      <>
        <p>
          We work to keep the Service available and reliable, but we do not promise it will be
          uninterrupted or error-free. Maintenance, updates, network problems and outages at our
          providers can affect availability.
        </p>
        <ul>
          <li>
            <strong>Support.</strong> Signed-in users can contact support from Help in the account
            menu. You can also email <SupportEmail />.
          </li>
          <li>
            <strong>Changes.</strong> We improve the Service continuously and may add, change or
            remove features. If we remove a feature that is material to your subscription, we will
            give you reasonable notice where practical.
          </li>
          <li>
            <strong>Features in limited release.</strong> Features that are labeled as a preview or
            that require separate activation, including Koaryu Payments, may change or end.
          </li>
          <li>
            <strong>Your copies.</strong> We maintain backups for our own recovery purposes, but we
            do not guarantee that any particular record can be restored. Use exports to keep your
            own copies.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "termination",
    title: "Suspension and termination",
    body: (
      <>
        <h3>By you</h3>
        <p>
          You can cancel your subscription at any time, as described in{" "}
          <a href="#koaryu-core">Koaryu Core</a>. Any user can request deletion of their own account
          from Account settings; deletion is scheduled 30 days out and can be cancelled before then.
          A Studio owner must transfer ownership first, and a Studio must keep at least one Admin.
        </p>
        <h3>By us</h3>
        <p>We may suspend or end access to the Service, in whole or in part, if:</p>
        <ul>
          <li>
            you materially breach these Terms and don&rsquo;t fix the breach within 10 days after we
            notify you, or immediately if the breach can&rsquo;t be fixed;
          </li>
          <li>fees are overdue;</li>
          <li>
            your use creates a security, legal or financial risk, or could harm the Service, other
            Studios or other people; or
          </li>
          <li>the law, a court, or Stripe for Koaryu Payments, requires it.</li>
        </ul>
        <p>
          Where reasonably practical, we will tell you before we suspend access and restore it once
          the problem is resolved. If we discontinue the Service entirely, we will give at least 30
          days&rsquo; notice and refund any prepaid fees for the period after it ends.
        </p>
        <h3>What happens next</h3>
        <p>
          When your subscription or access ends, your right to use the Service ends and any fees
          already owed remain payable. Export what you need before your subscription ends. If you
          need a copy afterward, contact us within 30 days and we will make reasonable efforts to
          provide one. We keep and delete Studio Data as our Privacy Policy describes. Sections that
          by their nature should survive, including those on Studio Data, fees owed, disclaimers,
          liability, indemnification and disputes, survive termination.
        </p>
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <>
        <p>
          Koaryu is a recordkeeping and administration tool. Rank eligibility, attendance totals,
          balances and reports are there to help your staff, but decisions about promotions,
          billing, safety and your students remain your Studio&rsquo;s. The Service does not provide
          legal, tax or financial advice.
        </p>
        <LegalConspicuous>
          To the fullest extent permitted by law, the Service is provided &ldquo;as is&rdquo; and
          &ldquo;as available.&rdquo; Koaryu disclaims all warranties, express or implied, including
          warranties of merchantability, fitness for a particular purpose, title and
          non-infringement, and any warranty that the Service will be uninterrupted, secure or
          error-free, or that data will never be lost.
        </LegalConspicuous>
      </>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <>
        <LegalConspicuous>
          To the fullest extent permitted by law, Koaryu will not be liable for any indirect,
          incidental, special, consequential, exemplary or punitive damages, or for any loss of
          profits, revenue, goodwill or data, arising out of or relating to these Terms or the
          Service, even if we have been told such damages are possible.
        </LegalConspicuous>
        <LegalConspicuous>
          Koaryu&rsquo;s total liability for all claims arising out of or relating to these Terms or
          the Service will not exceed the greater of the amounts you paid Koaryu in the 12 months
          before the event giving rise to the claim, or US$100.
        </LegalConspicuous>
        <p>
          These limits apply to every theory of liability and even if a remedy fails of its
          essential purpose. They do not limit liability that cannot be limited under applicable
          law. Some jurisdictions don&rsquo;t allow certain exclusions, so some of these limits may
          not apply to you.
        </p>
      </>
    ),
  },
  {
    id: "indemnification",
    title: "Indemnification",
    body: (
      <>
        <p>
          Your Studio will defend Koaryu and its personnel against any third-party claim, and pay
          the resulting losses, damages, fines and reasonable legal fees, to the extent the claim
          arises from:
        </p>
        <ul>
          <li>Studio Data, including any missing notice or consent;</li>
          <li>
            your Studio&rsquo;s charges, refunds and disputes, or its relationships with students,
            families and Payers; or
          </li>
          <li>your breach of these Terms or of the law.</li>
        </ul>
        <p>
          We will notify you promptly of the claim, let you control the defense and settlement
          (provided you don&rsquo;t admit fault for us or bind us without our consent), and give
          reasonable cooperation at your expense.
        </p>
      </>
    ),
  },
  {
    id: "disputes",
    title: "Dispute resolution and arbitration",
    body: (
      <>
        <h3>Try to resolve it informally first</h3>
        <p>
          Before starting an arbitration or court case, the party with the dispute will send the
          other a written notice describing it and the relief sought. Send yours to <SupportEmail />
          ; we will send ours to your account email. Both parties will try in good faith to resolve
          the dispute for 30 days after the notice is received.
        </p>
        <h3>Binding individual arbitration</h3>
        <p>
          If the dispute isn&rsquo;t resolved, you and Koaryu agree that any dispute, claim or
          controversy arising out of or relating to these Terms or the Service will be resolved by
          final and binding arbitration administered by the American Arbitration Association
          (&ldquo;AAA&rdquo;) before a single arbitrator. The AAA&rsquo;s Commercial Arbitration
          Rules apply, except that its Consumer Arbitration Rules apply where the AAA determines
          they should, for example for a Payer who uses the Service for personal purposes. Hearings
          will take place by video conference or, if the arbitrator decides an in-person hearing is
          needed, in the county where your Studio is located (or where you live, if you are a
          Payer). Filing, administrative and arbitrator fees are allocated under the AAA&rsquo;s
          rules. The Federal Arbitration Act governs this section.
        </p>
        <h3>Exceptions</h3>
        <p>
          Either party may bring an individual claim in small claims court if it qualifies, and
          either party may ask a court for an injunction to protect its intellectual property or to
          stop unauthorized access to or misuse of the Service.
        </p>
        <h3>No class actions or jury trials</h3>
        <LegalConspicuous>
          You and Koaryu may bring claims against each other only individually, and not as a
          plaintiff or class member in any class, collective, consolidated or representative
          proceeding. You and Koaryu waive any right to a jury trial.
        </LegalConspicuous>
        <p>
          If a court decides that the class action waiver can&rsquo;t be enforced for a particular
          claim or remedy, that claim or remedy will be decided in court and not in arbitration. A
          court, not the arbitrator, decides any question about the enforceability of the class
          action waiver.
        </p>
        <h3>Your right to opt out</h3>
        <p>
          You can opt out of this arbitration agreement by emailing <SupportEmail /> within 30 days
          after you first accept these Terms. Use the subject &ldquo;Arbitration opt-out&rdquo; and
          include your name, your Studio&rsquo;s name and your account email. Opting out does not
          affect any other part of these Terms.
        </p>
        <h3>Changes to this section</h3>
        <p>
          If we make a material change to this section, you can reject it by emailing us within 30
          days after the change takes effect. The version you previously accepted will then continue
          to apply.
        </p>
      </>
    ),
  },
  {
    id: "governing-law",
    title: "Governing law and venue",
    body: (
      <p>
        These Terms are governed by the laws of the State of California, without regard to its
        conflict-of-laws rules, except that the Federal Arbitration Act governs the arbitration
        section. Any matter that is not subject to arbitration will be decided exclusively in the
        state or federal courts located in California, and you and Koaryu consent to their personal
        jurisdiction. The United Nations Convention on Contracts for the International Sale of Goods
        does not apply.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    body: (
      <>
        <p>
          We may update these Terms as the Service and the law change. We will post the new version
          on this page with a new effective date and record it in the revision history below.
        </p>
        <p>
          If a change is material, we will give you at least 30 days&rsquo; notice by email to the
          account owner or through a notice in Koaryu before it takes effect, unless the change is
          required sooner by law or relates only to new features. By continuing to use the Service
          after a change takes effect, you accept the updated Terms. If you don&rsquo;t agree,
          cancel before the effective date. Changes don&rsquo;t apply retroactively or to disputes
          either party knew about before the change.
        </p>
      </>
    ),
  },
  {
    id: "general",
    title: "General terms",
    body: (
      <LegalDefinitions
        items={[
          {
            term: "Entire agreement",
            definition:
              "These Terms, the Privacy Policy and any terms you accept when activating Koaryu Payments are the whole agreement between you and Koaryu about the Service, and they replace any earlier agreements on the same subject.",
          },
          {
            term: "Assignment",
            definition:
              "You may not transfer these Terms without our written consent. We may transfer them as part of a merger, acquisition or sale of assets, and we will tell you if we do.",
          },
          {
            term: "Severability and waiver",
            definition:
              "If any part of these Terms is found unenforceable, the rest stays in effect. Not enforcing a right is not a waiver of it.",
          },
          {
            term: "Force majeure",
            definition:
              "Neither party is liable for a delay or failure caused by events beyond its reasonable control, such as natural disasters, power or internet failures, provider outages, labor actions or government action. This does not excuse payment obligations.",
          },
          {
            term: "Notices",
            definition: (
              <>
                We send notices by email to your account email or through the Service, and you agree
                to receive them electronically. Send notices to us at <SupportEmail />.
              </>
            ),
          },
          {
            term: "Relationship",
            definition:
              "You and Koaryu are independent contractors. There are no third-party beneficiaries of these Terms.",
          },
          {
            term: "Export and sanctions",
            definition:
              "You may not use the Service in violation of U.S. export control or sanctions laws, or if you are on a U.S. government restricted-party list.",
          },
          {
            term: "Interpretation",
            definition:
              "Headings are for convenience only. “Including” means “including without limitation.”",
          },
        ]}
      />
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about these Terms, notices and arbitration opt-outs go to <SupportEmail />.
        Signed-in users can also open Help from the account menu and choose Contact support. Please
        include your Studio&rsquo;s name and your account email.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalDocument
      documentKey="terms"
      description={description}
      highlights={highlights}
      sections={sections}
      contactPrompt="Email us with your studio's name and your account email, and we'll get back to you."
      contactTitle="Questions about these Terms?"
      contactSubject="Question about the Terms of Service"
    />
  );
}
