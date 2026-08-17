import type { Metadata } from "next";

import { MarketingActionLink } from "@/components/marketing/marketing-primitives";
import {
  BreadcrumbJsonLd,
  detailNextSteps,
  MarketingHero,
  MarketingNextSteps,
  PageStructuredData,
  PublicPageShell,
} from "@/components/marketing/public-pages";
import styles from "@/components/marketing/public-pages.module.css";
import { APP_NAME } from "@/lib/constants";

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

const principles = [
  {
    title: "Built for independent schools",
    description:
      "Koaryu is focused on owner-operated and small-team martial arts studios, not enterprise gym chains.",
  },
  {
    title: "Studio data should stay understandable",
    description:
      "Student, guardian, attendance, rank, lead, and supported billing records stay visible and scoped to the school; new billing exports are currently unavailable.",
  },
  {
    title: "Daily action beats dashboard theater",
    description:
      "The product should answer what needs attention today: follow-ups, classes, promotions, retention, and tuition issues.",
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
          description:
            "Koaryu is a martial arts studio operating system for independent schools.",
          url: "https://koaryu.app/about",
          isPartOf: {
            "@type": "WebSite",
            name: APP_NAME,
            url: "https://koaryu.app/",
          },
        }}
      />
      <MarketingHero
        eyebrow="About Koaryu"
        title="Serious studio software for schools that still feel personal."
        description="Koaryu exists for martial arts owners who need a calmer way to run students, ranks, attendance, trials, billing, and retention without inheriting enterprise software complexity."
        cta="Start setup"
        sceneLabel="Product philosophy"
        sceneFocus="Independent studios"
      />

      <section
        className={styles.aboutPositioning}
        aria-labelledby="about-positioning-heading"
      >
        <div className={styles.aboutStatement}>
          <p className={styles.eyebrow}>Positioning</p>
          <h2 id="about-positioning-heading">
            Koaryu is intentionally narrower than generic gym software.
          </h2>
          <p>
            The product is built around the rhythm of a martial arts school:
            the student who misses class, the trial family waiting for a call,
            the instructor reviewing promotions, and the owner who needs to
            know whether the school is healthy before the evening rush.
          </p>
          <div className={styles.editorialActions}>
            <MarketingActionLink href="/features">
              Explore features
            </MarketingActionLink>
            <MarketingActionLink href="/use-cases" variant="secondary">
              See use cases
            </MarketingActionLink>
          </div>
        </div>
        <ul className={styles.aboutPrinciples} aria-label="Koaryu principles">
          {principles.map((principle) => (
            <li key={principle.title}>
              <h3>{principle.title}</h3>
              <p>{principle.description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.aboutScope} aria-labelledby="about-scope-heading">
        <div className={styles.aboutScopeInner}>
          <p className={styles.aboutScopeEyebrow}>Koaryu</p>
          <div>
            <h2 id="about-scope-heading">
              Reliable daily operations for one independent studio.
            </h2>
            <p>
              Koaryu supports one studio per user with explicit Admin, Front
              Desk, and Instructor boundaries. It centers the roster, ranks,
              schedule, attendance, leads, and honest visibility into existing billing
              records. Provider-backed billing changes and live Stripe activation are
              currently unavailable.
            </p>
          </div>
        </div>
      </section>

      <MarketingNextSteps
        title="See how the product works"
        description=""
        steps={detailNextSteps}
      />
    </PublicPageShell>
  );
}
