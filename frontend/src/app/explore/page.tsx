import type { Metadata } from "next";
import Link from "next/link";

import { DiscoveryClosing, DiscoveryLink } from "@/components/marketing/discovery-pages";
import styles from "@/components/marketing/discovery-pages.module.css";
import {
  BreadcrumbJsonLd,
  PageStructuredData,
  PublicPageShell,
} from "@/components/marketing/public-pages";
import { APP_NAME } from "@/lib/constants";
import { featurePages, useCasePages } from "@/lib/marketing-pages";

export const metadata: Metadata = {
  title: "Explore Koaryu | Martial Arts Studio Software Guide",
  description:
    "A quiet guide to Koaryu's feature pages, studio workflows, and fit for independent martial arts schools.",
  alternates: { canonical: "https://koaryu.app/explore" },
  openGraph: {
    title: "Explore Koaryu | Martial Arts Studio Software Guide",
    description:
      "Find the Koaryu product page, use case, or studio path that matches what you are trying to understand.",
    url: "https://koaryu.app/explore",
  },
};

const questions = [
  {
    question: "Our records live in too many places.",
    answer: "Start with a roster import, then connect the records around it.",
    href: "/use-cases/spreadsheets-to-studio-crm",
    label: "Leaving spreadsheets",
  },
  {
    question: "Students stop coming. We notice too late.",
    answer: "Use attendance history to decide who needs a personal check-in.",
    href: "/use-cases/student-retention",
    label: "Student retention",
  },
  {
    question: "Good trials don't always become enrollments.",
    answer: "Keep the inquiry, class notes, and next conversation together.",
    href: "/use-cases/trial-to-enrollment",
    label: "Trial follow-up",
  },
  {
    question: "Tuition questions take too much digging.",
    answer: "Review the payer, invoice, and existing payment record before the conversation.",
    href: "/use-cases/tuition-cleanup",
    label: "Tuition cleanup",
  },
  {
    question: "Every belt test starts with another list.",
    answer: "Review attendance and time at rank, then let the instructor make the call.",
    href: "/use-cases/belt-test-readiness",
    label: "Test readiness",
  },
];

const featureNotes = [
  "Who trains here, who to contact, and what staff need to know.",
  "Program-specific ranks, requirements, and the history behind a promotion.",
  "Class sessions, attendance records, and signs that a student needs attention.",
  "Existing plans, payers, invoices, and payment issues for authorized staff.",
];

export default function ExplorePage() {
  return (
    <PublicPageShell>
      <BreadcrumbJsonLd
        items={[
          { name: APP_NAME, url: "https://koaryu.app/" },
          { name: "Explore", url: "https://koaryu.app/explore" },
        ]}
      />
      <PageStructuredData
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: "Explore Koaryu",
          description: "A guide to Koaryu feature pages, use cases, and studio-fit pages.",
          url: "https://koaryu.app/explore",
          isPartOf: { "@type": "WebSite", name: APP_NAME, url: "https://koaryu.app/" },
        }}
      />

      <section className={`${styles.wrap} ${styles.exploreHero}`}>
        <div>
          <p className={styles.eyebrow}>The Koaryu field guide</p>
          <h1 className={styles.display}>
            What brought
            <br />
            you here?
          </h1>
          <p className={styles.lead}>
            A crowded spreadsheet. A missed follow-up. A parent asking about the next belt. Start
            with the question you already have.
          </p>
        </div>
        <nav className={styles.guideContents} aria-label="Explore this guide">
          <p className={styles.eyebrow}>Find your starting point</p>
          <a href="#studio-problems">
            <span>01</span>
            <strong>A problem at the studio</strong>
            <span aria-hidden="true">↓</span>
          </a>
          <a href="#product-map">
            <span>02</span>
            <strong>What the product does</strong>
            <span aria-hidden="true">↓</span>
          </a>
          <a href="#school-fit">
            <span>03</span>
            <strong>Whether it fits your school</strong>
            <span aria-hidden="true">↓</span>
          </a>
        </nav>
      </section>

      <section
        id="studio-problems"
        className={`${styles.wrap} ${styles.section}`}
        aria-labelledby="problems-heading"
      >
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>01 / Start with the work</p>
            <h2 id="problems-heading">Find a familiar problem.</h2>
          </div>
          <p>
            Each guide walks through a real studio task: what to check, how the records connect, and
            what still needs your judgment.
          </p>
        </header>
        <ol className={styles.questionList}>
          {questions.map((item, index) => (
            <li key={item.href}>
              <Link href={item.href} className={styles.questionLink}>
                <span className={styles.questionNumber}>0{index + 1}</span>
                <span>
                  <strong>{item.question}</strong>
                  <span>{item.answer}</span>
                </span>
                <span className={styles.questionAction}>
                  {item.label}
                  <span aria-hidden="true">↗</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
        <DiscoveryLink href="/use-cases">
          See all {useCasePages.length} studio workflows
        </DiscoveryLink>
      </section>

      <section id="product-map" className={styles.paperBand} aria-labelledby="product-map-heading">
        <div className={`${styles.wrap} ${styles.section}`}>
          <header className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>02 / See the pieces</p>
              <h2 id="product-map-heading">One student. A connected record.</h2>
            </div>
            <p>
              Choose a product area for a closer look at the information it holds and how your staff
              use it during the day.
            </p>
          </header>
          <div className={styles.featureMap}>
            {featurePages.map((page, index) => (
              <Link href={page.href} className={styles.featureRoute} key={page.href}>
                <span className={styles.featureMark} aria-hidden="true">
                  0{index + 1}
                </span>
                <h3>{page.eyebrow}</h3>
                <p>{featureNotes[index]}</p>
                <span className={styles.smallAction}>
                  Read the feature guide <span aria-hidden="true">→</span>
                </span>
              </Link>
            ))}
          </div>
          <p className={styles.contextNote}>
            Tuition collection needs separate activation for the exact studio and is not generally
            available. The billing guide explains what you can review today.
          </p>
          <DiscoveryLink href="/features">See how the features connect</DiscoveryLink>
        </div>
      </section>

      <section
        id="school-fit"
        className={`${styles.wrap} ${styles.section}`}
        aria-labelledby="fit-heading"
      >
        <header className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>03 / Find your fit</p>
            <h2 id="fit-heading">Built around the school you run.</h2>
          </div>
          <p>
            Koaryu focuses on independent martial arts schools with a small staff. It supports one
            studio per user, with distinct Admin, Front Desk, and Instructor roles.
          </p>
        </header>
        <div className={styles.fitRoutes}>
          <article className={styles.familyInvite}>
            <p className={styles.eyebrow}>Kids, siblings, guardians</p>
            <h3>One family can mean several different records.</h3>
            <p>
              See how children&apos;s programs, guardian contacts, trial follow-up, rank progress,
              and payer context fit into a family-focused school.
            </p>
            <DiscoveryLink href="/studio-types/family-martial-arts-schools">
              Explore the family-school guide
            </DiscoveryLink>
          </article>
          <article className={styles.aboutInvite}>
            <p className={styles.eyebrow}>The product&apos;s focus</p>
            <h3>Know what you&apos;re choosing.</h3>
            <p>
              Read why Koaryu centers the daily work of an independent school, where staff judgment
              matters, and the product&apos;s current limits.
            </p>
            <DiscoveryLink href="/about">About Koaryu</DiscoveryLink>
          </article>
        </div>
      </section>
      <DiscoveryClosing
        title="Ready to put your own roster in the picture?"
        description="Start setup when you are ready to organize your studio. You can review the platform price and tuition availability first."
      />
    </PublicPageShell>
  );
}
