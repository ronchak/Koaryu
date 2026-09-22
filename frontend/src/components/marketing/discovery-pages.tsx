import Link from "next/link";
import type { ReactNode } from "react";

import { MarketingActionLink } from "@/components/marketing/marketing-primitives";
import { PublicPageShell } from "@/components/marketing/public-pages";
import type { MarketingPage } from "@/lib/marketing-pages";

import styles from "./discovery-pages.module.css";

export function DiscoveryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={styles.textLink}>
      {children}
      <span aria-hidden="true">→</span>
    </Link>
  );
}

export function DiscoveryClosing({
  title,
  description,
  secondaryHref = "/#pricing",
  secondaryLabel = "Review pricing",
}: {
  title: string;
  description: string;
  secondaryHref?: string;
  secondaryLabel?: string;
}) {
  return (
    <section className={`${styles.wrap} ${styles.closing}`} aria-labelledby="discovery-next-step">
      <div>
        <p className={styles.eyebrow}>Your next step</p>
        <h2 id="discovery-next-step">{title}</h2>
        <p>{description}</p>
      </div>
      <div className={styles.actions}>
        <MarketingActionLink href="/signup" prefetch={false} className={styles.primaryAction}>
          Start setup
        </MarketingActionLink>
        <DiscoveryLink href={secondaryHref}>{secondaryLabel}</DiscoveryLink>
      </div>
    </section>
  );
}

const familyMoments = [
  {
    label: "The first visit",
    question: '"Can both children try a class?"',
    description:
      "A trial begins with a conversation. Record who is interested, the guardian's questions, the program they are considering, and the next follow-up date. Review the trial notes during the enrollment handoff.",
    check: "Before the follow-up, review the trial notes and who staff should contact.",
    href: "/use-cases/trial-to-enrollment",
    action: "Follow a trial through enrollment",
  },
  {
    label: "A normal training week",
    question: '"Has Maya been making it to class?"',
    description:
      "Siblings can have different programs, schedules, and attendance patterns. Review the individual student's history instead of assuming the whole family is training on the same rhythm.",
    check: "Use missed-class patterns as a reason to check in. Staff choose the conversation.",
    href: "/use-cases/student-retention",
    action: "See the retention workflow",
  },
  {
    label: "Approaching a belt test",
    question: '"Is Leo ready for the next belt?"',
    description:
      "Open Leo's program, current rank, attendance, and promotion history. Requirements help instructors prepare a review list, with human approval where the school requires it.",
    check: "Readiness is a review signal. It is not a promise of a promotion to the family.",
    href: "/use-cases/belt-test-readiness",
    action: "Prepare for a testing conversation",
  },
  {
    label: "A tuition question",
    question: '"Which student is this invoice for?"',
    description:
      "Authorized staff can review existing student billing assignments, payer context, and invoices. Keeping those relationships visible helps staff understand which record needs attention before contacting the family.",
    check: "An external payment note records what happened elsewhere. It does not move money.",
    href: "/use-cases/tuition-cleanup",
    action: "Review the tuition workflow",
  },
];

export function StudioTypeDetailPage({
  page,
  relatedPages,
}: {
  page: MarketingPage;
  relatedPages: MarketingPage[];
}) {
  return (
    <PublicPageShell>
      <section className={`${styles.wrap} ${styles.familyHero}`}>
        <div>
          <Link href="/explore" className={styles.backLink}>
            ← Explore Koaryu
          </Link>
          <p className={styles.eyebrow}>For family-focused martial arts schools</p>
          <h1 className={styles.display}>
            Know the family.
            <br />
            Keep each student&apos;s story.
          </h1>
          <p className={styles.lead}>
            Two siblings. Different programs. One parent asking a tuition question. Koaryu keeps the
            people and records connected without treating them as the same thing.
          </p>
          <DiscoveryLink href="#family-records">See how the records fit</DiscoveryLink>
        </div>
        <figure className={styles.householdExample}>
          <figcaption className={styles.eyebrow}>
            An illustrative family, not live student data
          </figcaption>
          <div className={styles.familyStudents}>
            <div>
              <span className={styles.initial} aria-hidden="true">
                M
              </span>
              <span className={styles.eyebrow}>Student</span>
              <strong>Maya</strong>
              <p>
                Kids karate
                <br />
                Her attendance and rank
              </p>
            </div>
            <div>
              <span className={styles.initial} aria-hidden="true">
                L
              </span>
              <span className={styles.eyebrow}>Student</span>
              <strong>Leo</strong>
              <p>
                Teen karate
                <br />
                His attendance and rank
              </p>
            </div>
          </div>
          <span className={styles.relationshipLabel}>Connected family context</span>
          <div className={styles.familyAdult}>
            <span className={styles.eyebrow}>Guardian contact</span>
            <strong>Alex</strong>
            <p>Contact details and family questions</p>
          </div>
          <div className={styles.familyPayer}>
            <span className={styles.eyebrow}>Payer context</span>
            <p>
              The adult responsible for tuition can also be a guardian. The billing role is a
              separate relationship.
            </p>
          </div>
        </figure>
      </section>

      <section
        id="family-records"
        className={styles.paperBand}
        aria-labelledby="family-records-heading"
      >
        <div className={`${styles.wrap} ${styles.section}`}>
          <header className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Different people. Different responsibilities.</p>
              <h2 id="family-records-heading">Give each record the right job.</h2>
            </div>
            <p>
              The student trains. A guardian provides contact and family context. A payer is
              responsible for tuition. Programs define what each student is working toward.
            </p>
          </header>
          <dl className={styles.relationships}>
            <div>
              <dt>The student</dt>
              <dd>
                Keep each child&apos;s status, program, current rank, attendance, and internal notes
                with their own profile. A sibling&apos;s progress never explains the whole picture.
              </dd>
            </div>
            <div>
              <dt>The guardian</dt>
              <dd>
                Keep guardian contact and emergency details near the student record, so staff know
                where to look when a family question comes up.
              </dd>
            </div>
            <div>
              <dt>The payer</dt>
              <dd>
                Review existing payer and student billing relationships with Admin or Front Desk
                access. Instructors do not have access to billing data.
              </dd>
            </div>
            <div>
              <dt>The program</dt>
              <dd>
                Connect each student to the class and rank context of their program. Siblings can
                train toward different milestones at different times.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className={`${styles.wrap} ${styles.section}`} aria-labelledby="family-day-heading">
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>The questions at your front desk</p>
            <h2 id="family-day-heading">Useful through every stage of training.</h2>
          </div>
          <p>Here&apos;s how the same records help with four familiar family conversations.</p>
        </header>
        <div className={styles.familyMoments}>
          {familyMoments.map((moment) => (
            <article key={moment.label}>
              <p className={styles.eyebrow}>{moment.label}</p>
              <h3>{moment.question}</h3>
              <p>{moment.description}</p>
              <div className={styles.staffCheck}>
                <span className={styles.eyebrow}>The staff check</span>
                <p>{moment.check}</p>
              </div>
              <DiscoveryLink href={moment.href}>{moment.action}</DiscoveryLink>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.darkBand} aria-labelledby="family-fit-heading">
        <div className={`${styles.wrap} ${styles.section} ${styles.familyFit}`}>
          <div>
            <p className={styles.eyebrow}>Before moving your school</p>
            <h2 id="family-fit-heading">Start with your roster and the next real task.</h2>
            <p>
              Koaryu supports one studio per user. It is built for an independent school with Admin,
              Front Desk, and Instructor responsibilities.
            </p>
            <DiscoveryLink href="/use-cases/spreadsheets-to-studio-crm">
              Plan the move from spreadsheets
            </DiscoveryLink>
          </div>
          <div className={styles.availabilityNote}>
            <h3>Check your tuition needs separately.</h3>
            <p>
              Existing billing records and external payment notes help authorized staff understand
              the account. Tuition collection requires separate activation for the exact studio and
              is not generally available. New billing exports are currently unavailable.
            </p>
            <DiscoveryLink href="/features/billing">Read the full billing scope</DiscoveryLink>
          </div>
        </div>
      </section>

      <section
        className={`${styles.wrap} ${styles.section}`}
        aria-labelledby="family-related-heading"
      >
        <p className={styles.eyebrow}>{page.eyebrow} / Next reading</p>
        <h2 id="family-related-heading">Look closer at the parts your school needs.</h2>
        <ul className={styles.relatedReading}>
          {relatedPages.map((related) => (
            <li key={related.href}>
              <Link href={related.href}>
                <span>
                  <span className={styles.eyebrow}>{related.eyebrow}</span>
                  <strong>{related.title}</strong>
                </span>
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <DiscoveryClosing
        title="Bring your own school into the picture."
        description="Start with your studio setup, then use a real roster and a familiar task to see how Koaryu fits."
      />
    </PublicPageShell>
  );
}
