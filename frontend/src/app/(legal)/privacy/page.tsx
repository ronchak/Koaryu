import type { Metadata } from "next";
import Link from "next/link";

import {
  LegalCallout,
  LegalDocument,
  LegalTable,
  type LegalHighlight,
  type LegalSection,
} from "@/components/marketing/legal-document";
import { legalContact } from "@/lib/legal-documents";

const description =
  "What information Koaryu collects, how it is used and shared, how long it is kept, and the choices and rights you have.";

export const metadata: Metadata = {
  title: "Privacy Policy | Koaryu",
  description,
  alternates: { canonical: "https://koaryu.app/privacy" },
  openGraph: {
    title: "Privacy Policy | Koaryu",
    description,
    url: "https://koaryu.app/privacy",
  },
};

const supportEmail = legalContact.email;

const SupportEmail = () => <a href={`mailto:${supportEmail}`}>{supportEmail}</a>;

const highlights: readonly LegalHighlight[] = [
  {
    title: "We don't sell personal information",
    text: "There are no ads in Koaryu, and no third-party analytics or tracking scripts. We never share personal information for targeted advertising.",
  },
  {
    title: "Studios control student records",
    text: "We hold student, family and lead records on each studio's behalf. Students and families should contact their studio about their information.",
  },
  {
    title: "Only essential cookies",
    text: "Cookies keep you signed in and remember your studio. Nothing tracks you across other sites.",
  },
  {
    title: "Card details stay with Stripe",
    text: "Stripe processes payments. Koaryu never receives full card or bank account numbers.",
  },
  {
    title: "Stored in the United States",
    text: "Koaryu's database, servers and website run on U.S. infrastructure in Oregon.",
  },
  {
    title: "You can delete your account",
    text: "Request deletion in Account settings. You have 30 days to change your mind before it's carried out.",
  },
];

const sections: readonly LegalSection[] = [
  {
    id: "scope",
    title: "Who we are and what this policy covers",
    body: (
      <>
        <p>
          Koaryu provides studio management software for independent martial arts schools.
          &ldquo;Koaryu,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo; and &ldquo;our&rdquo; mean the
          operator of koaryu.app and the Koaryu app.
        </p>
        <p>
          This Privacy Policy explains how we collect, use, share and protect personal information
          when you visit koaryu.app, create or use a Koaryu account, are added to a studio&rsquo;s
          records, or pay a studio through Koaryu. It should be read with our{" "}
          <Link href="/terms">Terms of Service</Link>, which use the same defined terms, such as
          &ldquo;Studio,&rdquo; &ldquo;Staff User,&rdquo; &ldquo;Studio Data&rdquo; and
          &ldquo;Payer.&rdquo;
        </p>
        <p>
          This policy does not cover how a studio itself collects or uses information outside
          Koaryu. Each studio has its own privacy practices.
        </p>
      </>
    ),
  },
  {
    id: "our-role",
    title: "Koaryu's role for studio records",
    body: (
      <>
        <p>Koaryu handles personal information in two different roles.</p>
        <ul>
          <li>
            <strong>For our own customers and visitors.</strong> We decide how to use account,
            subscription, support and website information about studios and their staff. For this
            information we act as a &ldquo;business&rdquo; or &ldquo;controller.&rdquo;
          </li>
          <li>
            <strong>For Studio Data.</strong> Records a studio keeps in Koaryu about its students,
            guardians, leads, Payers and staff belong to the studio. We process them on the
            studio&rsquo;s behalf and according to its instructions, as a &ldquo;service
            provider&rdquo; or &ldquo;processor.&rdquo; The studio decides what to collect and is
            responsible for giving notice and obtaining any consent required.
          </li>
        </ul>
        <LegalCallout label="Students, parents and guardians">
          <p>
            Students and families don&rsquo;t have Koaryu accounts. If you want to see, correct or
            delete information a studio keeps about you or your child, contact the studio directly.
            If you contact us instead, we will refer your request to the studio and help it respond.
          </p>
        </LegalCallout>
      </>
    ),
  },
  {
    id: "information-we-collect",
    title: "Information we collect",
    body: (
      <>
        <p>
          The information we handle depends on how you use Koaryu. Most of it is entered by studio
          staff; some comes from you directly, from the sign-in provider you choose, or from Stripe.
        </p>
        <LegalTable
          caption="Categories of information and their sources"
          columns={["Category", "What it includes", "Where it comes from"]}
          rows={[
            [
              "Account details",
              "Your name, email address and password (stored securely by our authentication provider, never in readable form), your role and the studios you belong to. With Google or Microsoft sign-in, the name, email address and profile picture that provider shares.",
              "You, an Admin who invites you, and your sign-in provider",
            ],
            [
              "Studio details",
              "Studio name, logo, time zone, programs, class schedules and rank ladders.",
              "Studio staff",
            ],
            [
              "Student and family records",
              "Legal and preferred names, date of birth and whether a student is a minor, email, phone, address, emergency contact, guardians, photo, programs, rank and promotion history, attendance, notes and tags.",
              "Studio staff, entered by hand or imported from a CSV file",
            ],
            [
              "Leads",
              "Name, contact details, program interest, guardian details for minors, visits, calls, follow-ups and notes.",
              "Studio staff",
            ],
            [
              "Billing records",
              "Koaryu Core subscription status and Stripe references. With Koaryu Payments: Payer names, emails, phone numbers and addresses, billing plans, invoices, payments, refunds, disputes, fees and records of autopay authorization.",
              "Studio staff, Payers and Stripe",
            ],
            [
              "Support requests",
              "Your name and email, the topic and message you send, the page you were on and basic browser details.",
              "You",
            ],
            [
              "Activity records",
              "Audit entries showing who changed what and when, for promotions, billing, exports and staff and account changes.",
              "Created as staff use Koaryu",
            ],
            [
              "Technical information",
              "IP address, browser and device type, request and error logs, and page-speed measurements that contain no user or studio identifiers.",
              "Your browser and our hosting providers",
            ],
          ]}
        />
        <p>
          Koaryu does not ask for government ID numbers, precise location, or health or medical
          information, and we ask studios not to store them in free-text notes.
        </p>
      </>
    ),
  },
  {
    id: "sign-in-providers",
    title: "Google and Microsoft sign-in",
    body: (
      <>
        <p>
          You can sign in with a Google or Microsoft account instead of a password. Sign-in is
          handled by Supabase, our authentication provider.
        </p>
        <ul>
          <li>
            <strong>Google</strong> shares your name, email address and profile picture.
          </li>
          <li>
            <strong>Microsoft</strong> shares your account identifier, name and email address.
          </li>
        </ul>
        <p>
          We use this information only to sign you in, link you to your existing Koaryu account and
          show your name on your profile. We never receive your Google or Microsoft password, and we
          do not request access to your email, files, contacts or calendar.
        </p>
        <p>
          Koaryu&rsquo;s use and transfer of information received from Google APIs adheres to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            rel="noopener noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. You can remove Koaryu&rsquo;s access at any time
          from your Google or Microsoft account settings.
        </p>
      </>
    ),
  },
  {
    id: "how-we-use-information",
    title: "How we use information",
    body: (
      <>
        <p>We use personal information to:</p>
        <ul>
          <li>
            provide the Service: sign you in, show each staff member the records their role allows,
            and run attendance, ranks, leads, reports and exports;
          </li>
          <li>manage Koaryu Core subscriptions and, where enabled, Koaryu Payments;</li>
          <li>
            send service messages, such as email confirmations, password resets, staff invitations,
            and billing, security and policy notices;
          </li>
          <li>answer support requests and investigate problems you report;</li>
          <li>
            keep Koaryu secure, including enforcing access controls, keeping audit records and
            preventing fraud and abuse;
          </li>
          <li>
            measure and improve reliability and performance, using aggregated measurements that
            don&rsquo;t identify you; and
          </li>
          <li>comply with the law and enforce our Terms.</li>
        </ul>
        <p>
          We don&rsquo;t sell personal information, show advertising, or use Studio Data to market
          to students, families or leads. We don&rsquo;t use Studio Data to train artificial
          intelligence models. Koaryu does not make automated decisions that have legal or similarly
          significant effects on anyone: features like rank eligibility help staff, but people make
          the decisions.
        </p>
      </>
    ),
  },
  {
    id: "sharing",
    title: "How we share information",
    body: (
      <>
        <h3>Within your studio</h3>
        <p>
          Staff Users see Studio Data according to their role. For example, Instructors can work
          with student profiles, attendance and ranks but cannot see billing.
        </p>
        <h3>With service providers</h3>
        <p>
          We use the following providers to run Koaryu. They process personal information only on
          our instructions and only as needed to provide their services to us.
        </p>
        <LegalTable
          caption="Service providers that process personal information"
          columns={["Provider", "What they do for Koaryu", "Where"]}
          rows={[
            [
              "Supabase",
              "Database, sign-in, private photo storage, and account emails such as confirmations, password resets and staff invitations",
              "United States (Oregon)",
            ],
            [
              "Vercel",
              "Hosts the website and web app, runs server functions and keeps short-lived logs",
              "United States",
            ],
            ["Render", "Hosts the Koaryu application server", "United States (Oregon)"],
            [
              "Stripe",
              "Processes Koaryu Core subscriptions and Koaryu Payments, including checkout, payer records, receipts and payouts",
              "United States and other countries where Stripe operates",
            ],
            [
              "Google and Microsoft",
              "Optional sign-in, only if you choose it",
              "United States and other countries",
            ],
          ]}
        />
        <p>
          Stripe also uses some information for its own purposes, such as fraud prevention and legal
          compliance, under the{" "}
          <a href="https://stripe.com/privacy" rel="noopener noreferrer">
            Stripe Privacy Policy
          </a>
          .
        </p>
        <h3>Other situations</h3>
        <ul>
          <li>
            <strong>People who help us.</strong> Contractors and professional advisers who need
            access to help us build, maintain and support Koaryu, under confidentiality obligations
            and only as needed.
          </li>
          <li>
            <strong>Legal and safety.</strong> When we believe in good faith that the law, a court
            order or a valid legal request requires it, or that it is needed to protect the rights,
            property or safety of Koaryu, our users or others.
          </li>
          <li>
            <strong>Business transfers.</strong> As part of a merger, acquisition, financing or sale
            of assets, subject to this policy&rsquo;s protections.
          </li>
          <li>
            <strong>With permission.</strong> When you or your studio direct us to share
            information.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: "payments",
    title: "Payments and Stripe",
    body: (
      <>
        <p>
          When a studio subscribes to Koaryu Core, Stripe Checkout and Stripe&rsquo;s billing portal
          collect the payment details. We send Stripe the studio&rsquo;s name and internal
          references, and receive back subscription and payment status. We never receive full card
          numbers.
        </p>
        <p>
          With Koaryu Payments, staff add a Payer&rsquo;s name, email, phone and address, which we
          share with Stripe to create invoices and checkout pages. Payers enter their own payment
          details on Stripe&rsquo;s checkout page and accept autopay terms there. We keep a record
          of that acceptance, including the terms version, the time and Stripe references, so the
          studio can show the charge was authorized. Stripe may email receipts and invoices to
          Payers directly.
        </p>
      </>
    ),
  },
  {
    id: "communications",
    title: "Emails and other communications",
    body: (
      <>
        <p>
          Account emails, such as sign-up confirmations, password resets and staff invitations, are
          sent for us by Supabase and may come from Supabase&rsquo;s sending domain rather than
          koaryu.app. Stripe may send billing emails, such as receipts and invoices. We may also
          contact you about your account, a support request, security or changes to our terms.
        </p>
        <p>
          Koaryu does not send marketing email or text messages, and it does not message students,
          families or leads on a studio&rsquo;s behalf. If we ever offer marketing email, it will
          include a way to unsubscribe.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and browser storage",
    body: (
      <>
        <p>
          Koaryu uses only the cookies and browser storage it needs to work. We don&rsquo;t use
          advertising or analytics cookies, and we don&rsquo;t load third-party analytics,
          advertising or tracking scripts.
        </p>
        <LegalTable
          caption="Cookies and storage Koaryu sets"
          columns={["Name", "Purpose", "How long"]}
          rows={[
            [
              "Supabase session cookies (sb-…-auth-token)",
              "Keep you signed in securely",
              "Until you sign out, or up to 400 days",
            ],
            [
              "koaryu-studio-state",
              "Remembers your studio access so pages load quickly",
              "5 minutes",
            ],
            ["koaryu-active-studio", "Remembers which studio you are working in", "30 days"],
            [
              "Local and session storage",
              "Your theme and layout choices, dashboard arrangement, list positions, and safeguards against submitting the same action twice",
              "Until you clear it, or until the tab closes",
            ],
          ]}
        />
        <p>
          The <Link href="/try">demo</Link> keeps your changes in your browser only and sends
          nothing to us. To measure page speed, the site sends anonymous timing data with no user or
          studio identifiers. Fonts are served from koaryu.app, so loading a page does not contact
          other companies&rsquo; font servers.
        </p>
        <p>
          You can block or delete cookies in your browser settings, but you won&rsquo;t be able to
          sign in without them. Because we don&rsquo;t track you across other websites, we
          don&rsquo;t change our practices in response to browser &ldquo;Do Not Track&rdquo;
          signals. We treat a Global Privacy Control signal as a request to opt out of the sale or
          sharing of personal information, which we don&rsquo;t do in any case.
        </p>
      </>
    ),
  },
  {
    id: "retention",
    title: "How long we keep information",
    body: (
      <>
        <ul>
          <li>
            <strong>Your account.</strong> We keep account details while your account exists. When
            you request deletion, it is scheduled 30 days out so you can cancel. We then delete your
            sign-in account, staff profile and studio roles. Records you created for a studio stay
            with that studio but are no longer linked to you. We keep a minimal record of the
            deletion request, including the email address, and audit entries that refer to an
            internal ID, to show the request was carried out and for security.
          </li>
          <li>
            <strong>Studio Data.</strong> We keep it for as long as the studio has a Koaryu account,
            including after a subscription ends, so the studio can come back. An Admin can ask us to
            delete the studio&rsquo;s data, and we will do so within 30 days of confirming the
            request, apart from the exceptions below.
          </li>
          <li>
            <strong>Archived students.</strong> Archiving hides a student from active lists but
            keeps the record. Permanent deletion is available on request from an Admin.
          </li>
          <li>
            <strong>Support requests.</strong> We keep them while the studio&rsquo;s account is
            active so we can see past issues, and delete them with the studio&rsquo;s data.
          </li>
          <li>
            <strong>Billing and payment records.</strong> We keep them for as long as tax,
            accounting and other laws require.
          </li>
          <li>
            <strong>Technical logs.</strong> Our hosting providers keep logs for short periods set
            by their own retention schedules.
          </li>
          <li>
            <strong>Backups.</strong> Deleted information can remain in encrypted backups until
            those backups are replaced in our normal backup cycle. We don&rsquo;t restore deleted
            information from backups except to recover from an incident.
          </li>
        </ul>
        <p>
          We may keep information longer where the law requires it, or where we need it to resolve
          disputes, enforce our agreements or protect against fraud and abuse.
        </p>
      </>
    ),
  },
  {
    id: "security",
    title: "How we protect information",
    body: (
      <>
        <p>We use safeguards designed for the kind of information studios keep, including:</p>
        <ul>
          <li>
            membership and role checks on every request, so staff see only what their role allows;
          </li>
          <li>
            database row-level security, with direct browser access to studio tables turned off;
          </li>
          <li>encryption in transit (HTTPS) and encryption at rest by our database provider;</li>
          <li>private storage for student photos, shown only through short-lived links;</li>
          <li>
            audit records of sensitive actions, such as promotions, billing changes and exports;
          </li>
          <li>
            card and bank details handled only by Stripe, a PCI DSS Level 1 certified service
            provider; and
          </li>
          <li>limiting access within Koaryu to the people who need it.</li>
        </ul>
        <p>
          You help too: use a strong, unique password or a secured Google or Microsoft account, and
          remove staff access promptly. No method of transmission or storage is completely secure.
          If a security incident affects personal information, we will notify affected studios and,
          where the law requires, individuals and regulators.
        </p>
      </>
    ),
  },
  {
    id: "childrens-information",
    title: "Children's information",
    body: (
      <>
        <p>
          Many studios teach children, so Studio Data can include information about minors, such as
          names, dates of birth, guardians, photos, attendance and ranks. Studio staff enter this
          information. Children do not use Koaryu or have accounts, the Service is not directed to
          children, and we don&rsquo;t knowingly collect personal information directly from children
          under 13.
        </p>
        <p>
          Studios are responsible for giving parents and guardians notice and obtaining their
          consent where the law requires it, and for handling their requests. If you believe a child
          has given us personal information directly, contact us at <SupportEmail /> and we will
          delete it.
        </p>
      </>
    ),
  },
  {
    id: "your-rights",
    title: "Your privacy rights and choices",
    body: (
      <>
        <h3>What everyone can do</h3>
        <ul>
          <li>
            <strong>Update your profile</strong> in Account settings.
          </li>
          <li>
            <strong>Delete your account</strong> in Account settings. Deletion is scheduled 30 days
            out and can be cancelled until then.
          </li>
          <li>
            <strong>Export studio records.</strong> Admins can download CSV exports from Reports,
            and Front Desk staff can download some of them.
          </li>
          <li>
            <strong>Ask us</strong> for a copy of your information, or to correct or delete it, by
            emailing <SupportEmail />.
          </li>
        </ul>
        <h3>Rights under privacy laws</h3>
        <p>
          Depending on where you live, including California and other U.S. states with privacy laws,
          and the European Economic Area, the United Kingdom and Switzerland, you may have the right
          to:
        </p>
        <ul>
          <li>know what personal information we hold about you and get a copy;</li>
          <li>correct inaccurate information;</li>
          <li>delete your information;</li>
          <li>receive your information in a portable format;</li>
          <li>
            opt out of the sale or sharing of personal information or its use for targeted
            advertising (we don&rsquo;t do these);
          </li>
          <li>object to or restrict certain processing, and withdraw consent; and</li>
          <li>appeal our decision on your request.</li>
        </ul>
        <h3>How to make a request</h3>
        <p>
          Email <SupportEmail /> from the address on your account, or describe your relationship to
          Koaryu if you don&rsquo;t have an account. We verify requests by confirming control of the
          account email, and may ask for more information where needed. You can use an authorized
          agent, who must provide your signed permission. We respond within the time the law
          requires, and we won&rsquo;t treat you differently for exercising your rights.
        </p>
        <p>
          If we decline your request, you can appeal by replying with &ldquo;Appeal&rdquo; in the
          subject line. If you&rsquo;re not satisfied with the result, you can contact your state
          attorney general or your local data protection authority.
        </p>
        <p>
          If your request concerns records a studio keeps about you, such as a student or Payer
          record, we will refer it to that studio, as described in{" "}
          <a href="#our-role">Koaryu&rsquo;s role for studio records</a>.
        </p>
      </>
    ),
  },
  {
    id: "us-state-notice",
    title: "Notice for California and other U.S. state residents",
    body: (
      <>
        <p>
          This notice describes the categories of personal information we have collected in the past
          12 months, as defined by the California Consumer Privacy Act and similar state laws. The
          sources, purposes and retention periods are described above.
        </p>
        <LegalTable
          caption="Categories of personal information and who receives them"
          columns={["Category", "Examples", "Disclosed for business purposes to"]}
          rows={[
            [
              "Identifiers",
              "Name, email, phone, address, account and Stripe references, IP address",
              "Hosting, database and payment providers",
            ],
            [
              "Customer records",
              "Contact, emergency contact and billing details",
              "Hosting, database and payment providers",
            ],
            [
              "Protected characteristics",
              "Date of birth and whether a student is a minor",
              "Hosting and database providers",
            ],
            [
              "Commercial information",
              "Subscriptions, invoices, payments, refunds and disputes",
              "Hosting, database and payment providers",
            ],
            ["Internet activity", "Request and error logs, audit records", "Hosting providers"],
            ["Visual information", "Student photos", "Database and storage provider"],
            [
              "Professional information",
              "Staff roles and the studios people work with",
              "Hosting and database providers",
            ],
            [
              "Sensitive personal information",
              "Account sign-in credentials",
              "Authentication provider",
            ],
          ]}
        />
        <p>
          We have not sold or shared personal information for cross-context behavioral advertising
          in the past 12 months, including that of consumers under 16. We use sensitive personal
          information only to provide the Service and keep it secure, and not to infer
          characteristics about anyone. We don&rsquo;t disclose personal information to third
          parties for their own direct marketing.
        </p>
      </>
    ),
  },
  {
    id: "international",
    title: "International users and data transfers",
    body: (
      <>
        <p>
          Koaryu is designed for studios in the United States, and information is stored and
          processed in the United States. If you use Koaryu from elsewhere, your information will be
          transferred to the United States, where data protection laws may differ from those where
          you live. Where the law requires it, we rely on appropriate safeguards for these
          transfers, such as the European Commission&rsquo;s Standard Contractual Clauses.
        </p>
        <p>
          If the GDPR or UK GDPR applies, we rely on these legal bases: performing our contract with
          you or your studio; our legitimate interests in running, securing, supporting and
          improving Koaryu, balanced against your rights; compliance with legal obligations; and
          your consent where we ask for it, which you can withdraw at any time. You can also lodge a
          complaint with your local supervisory authority.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        We will update this policy when our practices or the law change. We post the new version on
        this page with a new effective date and record it in the revision history below. If we make
        a material change, we will notify account owners by email or through a notice in Koaryu
        before it takes effect.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact us",
    body: (
      <>
        <p>
          For privacy questions or requests, email <SupportEmail />. Signed-in users can also open
          Help from the account menu and choose Contact support. Please include your studio&rsquo;s
          name and your account email so we can find your records.
        </p>
        <p>
          If your question is about a studio&rsquo;s records about you or your child, please contact
          that studio first.
        </p>
      </>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalDocument
      documentKey="privacy"
      description={description}
      highlights={highlights}
      sections={sections}
      contactPrompt="Email us for questions, copies, corrections or deletion requests. We respond within the time the law requires."
      contactTitle="Questions about your privacy?"
      contactSubject="Privacy request"
    />
  );
}
