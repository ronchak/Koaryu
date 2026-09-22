import type { Metadata } from "next";

import { DiscoveryClosing, DiscoveryLink } from "@/components/marketing/discovery-pages";
import styles from "@/components/marketing/discovery-pages.module.css";
import {
  BreadcrumbJsonLd,
  PageStructuredData,
  PublicPageShell,
} from "@/components/marketing/public-pages";
import { APP_NAME, formatPublicPlatformPrice } from "@/lib/constants";

export const metadata: Metadata = {
  title: "About Koaryu | Martial Arts Studio Software",
  description:
    "Koaryu is a flat-rate operating system for independent martial arts studios, built around students, ranks, attendance, leads, billing, and retention.",
  alternates: { canonical: "https://koaryu.app/about" },
  openGraph: {
    title: "About Koaryu | Martial Arts Studio Software",
    description:
      "The product philosophy behind Koaryu and its focus on independent martial arts schools.",
    url: "https://koaryu.app/about",
  },
};

const dailyWork = [
  {
    moment: "Before class",
    task: "A trial family needs a call.",
    record: "Open the lead's notes and next follow-up date.",
    href: "/use-cases/trial-to-enrollment",
  },
  {
    moment: "On the mat",
    task: "Take attendance once.",
    record: "Keep the class history attached to each student.",
    href: "/features/attendance",
  },
  {
    moment: "After class",
    task: "A familiar face is missing.",
    record: "Review the attendance pattern before reaching out.",
    href: "/use-cases/student-retention",
  },
  {
    moment: "Before testing",
    task: "Decide who is ready.",
    record: "Use class counts, time at rank, and instructor review.",
    href: "/use-cases/belt-test-readiness",
  },
];

export default function AboutPage() {
  return (
    <PublicPageShell>
      <BreadcrumbJsonLd
        items={[
          { name: APP_NAME, url: "https://koaryu.app/" },
          { name: "About", url: "https://koaryu.app/about" },
        ]}
      />
      <PageStructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "AboutPage",
          name: "About Koaryu",
          description: "Koaryu is a martial arts studio operating system for independent schools.",
          url: "https://koaryu.app/about",
          isPartOf: { "@type": "WebSite", name: APP_NAME, url: "https://koaryu.app/" },
        }}
      />

      <section className={`${styles.wrap} ${styles.aboutHero}`}>
        <p className={styles.eyebrow}>About Koaryu</p>
        <h1 className={styles.aboutTitle}>
          The school is personal.
          <br />
          <span>The paperwork shouldn&apos;t take all of you.</span>
        </h1>
        <div className={styles.aboutIntroduction}>
          <p>
            Knowing your students is part of the job. Remembering every missed class, tuition
            question, trial conversation, and promotion date is a lot to ask of one person&apos;s
            memory.
          </p>
          <p>
            Koaryu puts those records in one place so a small team can see what happened and choose
            what to do next. The teaching, relationships, and decisions stay with you.
          </p>
        </div>
      </section>

      <section className={styles.darkBand} aria-labelledby="daily-work-heading">
        <div className={`${styles.wrap} ${styles.section}`}>
          <header className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Built around your working day</p>
              <h2 id="daily-work-heading">The useful part is what happens next.</h2>
            </div>
            <p>
              A record earns its place when it helps someone do the next job. Attendance informs a
              check-in. Class history informs a testing conversation. Trial notes inform an
              enrollment.
            </p>
          </header>
          <ol className={styles.dailyWork}>
            {dailyWork.map((item) => (
              <li key={item.moment}>
                <p className={styles.eyebrow}>{item.moment}</p>
                <h3>{item.task}</h3>
                <p>{item.record}</p>
                <DiscoveryLink href={item.href}>See the workflow</DiscoveryLink>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section
        className={`${styles.wrap} ${styles.section} ${styles.aboutPrinciples}`}
        aria-labelledby="choices-heading"
      >
        <div>
          <p className={styles.eyebrow}>A few deliberate choices</p>
          <h2 id="choices-heading">Keep the work understandable.</h2>
          <p className={styles.sectionIntro}>
            The product&apos;s focus comes from the way an independent martial arts school operates.
          </p>
        </div>
        <div className={styles.principleList}>
          <article>
            <span className={styles.eyebrow}>01 / The student record</span>
            <h3>Context should survive the handoff.</h3>
            <p>
              The person at the front desk and the instructor on the mat need different views of the
              same student. Programs, attendance, rank history, and guardian details belong with
              that record, so staff don&apos;t have to reconstruct the last conversation.
            </p>
            <DiscoveryLink href="/features/student-management">
              See the student record
            </DiscoveryLink>
          </article>
          <article>
            <span className={styles.eyebrow}>02 / Instructor judgment</span>
            <h3>A shortlist is the start of a decision.</h3>
            <p>
              Class counts and time at rank can help identify students for review. They cannot judge
              how a student moves, learns, or handles a difficult class. Instructors make the
              promotion decision.
            </p>
            <DiscoveryLink href="/features/belt-tracking">How rank readiness works</DiscoveryLink>
          </article>
          <article>
            <span className={styles.eyebrow}>03 / Staff responsibilities</span>
            <h3>Access follows the job.</h3>
            <p>
              Admin, Front Desk, and Instructor roles have different boundaries. Admin and Front
              Desk can review supported billing records. Instructors do not have access to billing
              data.
            </p>
            <DiscoveryLink href="/features/billing">Read the billing scope</DiscoveryLink>
          </article>
          <article>
            <span className={styles.eyebrow}>04 / Platform pricing</span>
            <h3>{formatPublicPlatformPrice()} for the studio.</h3>
            <p>
              The Koaryu platform subscription is flat-rate. It does not increase with every student
              you add. Platform access and tuition collection are separate, so review the billing
              availability before planning a payment migration.
            </p>
            <DiscoveryLink href="/#pricing">Review pricing</DiscoveryLink>
          </article>
        </div>
      </section>

      <section className={styles.paperBand} aria-labelledby="scope-heading">
        <div className={`${styles.wrap} ${styles.section}`}>
          <header className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Before you choose</p>
              <h2 id="scope-heading">A clear view of the current product.</h2>
            </div>
            <p>
              These boundaries matter when you compare software or plan a move. Start with the work
              Koaryu supports today.
            </p>
          </header>
          <dl className={styles.scopeList}>
            <div>
              <dt>One studio per user</dt>
              <dd>
                Koaryu is designed for independent, owner-operated schools and small teams. A user
                works within one studio; this is not a multi-location management product.
              </dd>
            </div>
            <div>
              <dt>Daily studio operations</dt>
              <dd>
                The roster, leads, schedule, attendance, rank progress, and supported billing
                records are the focus.{" "}
                <DiscoveryLink href="/features">Browse the product areas</DiscoveryLink>
              </dd>
            </div>
            <div>
              <dt>Tuition availability</dt>
              <dd>
                Existing billing records are visible to authorized staff. Tuition collection
                requires separate activation for the exact studio and is not generally available.
              </dd>
            </div>
            <div>
              <dt>Billing exports</dt>
              <dd>
                New billing exports are currently unavailable. If exports are part of your
                accounting process, account for that before switching.
              </dd>
            </div>
          </dl>
        </div>
      </section>
      <DiscoveryClosing
        title="See how it fits the work you already do."
        description="Choose a feature guide, read through a workflow, or begin with your studio's setup."
        secondaryHref="/explore"
        secondaryLabel="Find your starting point"
      />
    </PublicPageShell>
  );
}
