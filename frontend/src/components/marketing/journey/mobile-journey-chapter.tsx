"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { PUBLIC_PAYMENTS_FEE_PERCENT } from "../../../lib/constants";
import type {
  JourneyAction,
  JourneyChapter,
  JourneyFaqChapter,
} from "../../../lib/landing-page-content";
import styles from "./mobile-journey-chapter.module.css";

function Action({ action, primary = false }: { action: JourneyAction; primary?: boolean }) {
  return (
    <Link
      href={action.href}
      prefetch={false}
      className={primary ? styles.primaryAction : styles.link}
    >
      {action.label}
      {!primary ? <span aria-hidden="true"> →</span> : null}
    </Link>
  );
}

function Panel({
  intro,
  children,
  dark = false,
  layout,
}: {
  intro: ReactNode;
  children: ReactNode;
  dark?: boolean;
  layout?: "directory" | "morning" | "faq" | "pricing";
}) {
  return (
    <article className={styles.panel} data-dark={dark || undefined} data-layout={layout}>
      <div className={styles.intro}>{intro}</div>
      <div className={styles.body}>{children}</div>
    </article>
  );
}

function Heading({ kicker, title }: { kicker: string; title: string }) {
  return (
    <>
      <p className={styles.kicker}>{kicker}</p>
      <h2>{title}</h2>
    </>
  );
}

function Directory({
  label,
  heading,
  entries,
  overview,
}: {
  label: string;
  heading: string;
  entries: readonly JourneyAction[];
  overview?: JourneyAction;
}) {
  return (
    <Panel
      layout="directory"
      intro={
        <>
          <Heading kicker={label} title={heading} />
          {overview ? <Action action={overview} /> : null}
        </>
      }
    >
      <nav className={styles.destinations} aria-label={label}>
        {entries.map((entry) => (
          <Action key={entry.href} action={entry} />
        ))}
      </nav>
    </Panel>
  );
}

function MobileFaq({
  chapter,
  groupIndex,
  itemIndex,
  onChange,
}: {
  chapter: JourneyFaqChapter;
  groupIndex: number;
  itemIndex: number;
  onChange: (group: number, item: number) => void;
}) {
  const group = chapter.groups[groupIndex] ?? chapter.groups[0]!;
  const item = group.items[Math.max(0, itemIndex)] ?? group.items[0]!;
  return (
    <Panel
      layout="faq"
      intro={
        <>
          <label className={styles.kicker} htmlFor="mobile-faq-question">
            Questions owners ask
          </label>
          <select
            id="mobile-faq-question"
            aria-label="Choose a question"
            value={`${groupIndex}:${Math.max(0, itemIndex)}`}
            onChange={(event) => {
              const [nextGroup, nextItem] = event.target.value.split(":").map(Number);
              onChange(nextGroup!, nextItem!);
            }}
          >
            {chapter.groups.map((topic, topicIndex) => (
              <optgroup key={topic.title} label={topic.title}>
                {topic.items.map((question, questionIndex) => (
                  <option key={question.question} value={`${topicIndex}:${questionIndex}`}>
                    {question.question}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </>
      }
    >
      <div aria-live="polite" aria-atomic="true" className={styles.answer}>
        <h2 className={styles.question}>{item.question}</h2>
        <p>{item.answer}</p>
      </div>
    </Panel>
  );
}

export function MobileJourneyChapter({
  chapter,
  index,
  position,
  count,
  faqGroup,
  faqItem,
  onFaqChange,
}: {
  chapter: JourneyChapter;
  index: number;
  position: number;
  count: number;
  faqGroup: number;
  faqItem: number;
  onFaqChange: (group: number, item: number) => void;
}) {
  let content: ReactNode;
  switch (chapter.kind) {
    case "features":
    case "use-cases":
      content = (
        <Directory
          label={chapter.kind === "features" ? "Features" : "Workflows"}
          heading={chapter.heading}
          entries={chapter.rows.map((row) => ({ label: row.title, href: row.detail.href }))}
          overview={chapter.link}
        />
      );
      break;
    case "explore":
      content = (
        <Directory
          label="Reading guides"
          heading={chapter.heading}
          entries={chapter.routes.map((route) => ({ label: route.title, href: route.href }))}
        />
      );
      break;
    case "about":
      content = (
        <Panel intro={<Heading kicker={chapter.kicker} title={chapter.heading} />}>
          <p>{chapter.lede}</p>
          <Action action={chapter.link} />
        </Panel>
      );
      break;
    case "morning":
      content = (
        <Panel
          layout="morning"
          intro={<Heading kicker={chapter.proofLabel} title={chapter.title} />}
        >
          <dl className={styles.examples}>
            {chapter.examples.map((example) => (
              <div key={example.condition}>
                <dt>{example.condition}</dt>
                <dd>{example.action}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      );
      break;
    case "product-intro":
      content = (
        <Panel dark intro={<Heading kicker={chapter.kicker} title={chapter.title} />}>
          <p>{chapter.lede}</p>
        </Panel>
      );
      break;
    case "pricing":
      content = (
        <Panel
          layout="pricing"
          intro={
            <>
              <p className={styles.kicker}>{chapter.kicker}</p>
              <h2 className={styles.price}>{chapter.displayPrice}</h2>
              <p>{chapter.period}</p>
              <p className={styles.studentCount}>No per-student tiers.</p>
              <Action action={chapter.setupAction} primary />
            </>
          }
        >
          <p>Students, ranks, leads, attendance, reports and billing records.</p>
          <p>
            Payments: standard {PUBLIC_PAYMENTS_FEE_PERCENT}% + Stripe fees per charge. Studio rates
            may vary.
          </p>
          <p>Tuition collection requires separate activation and is not generally available.</p>
        </Panel>
      );
      break;
    case "faq":
      content = (
        <MobileFaq
          chapter={chapter}
          groupIndex={faqGroup}
          itemIndex={faqItem}
          onChange={onFaqChange}
        />
      );
      break;
    case "hero":
      content = (
        <div className={styles.openCopy}>
          <div className={styles.intro}>
            <p className={styles.kicker}>{chapter.kicker}</p>
            <h1>
              {chapter.headline.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </h1>
          </div>
          <div className={styles.body}>
            <p>{chapter.lede}</p>
            <div className={styles.actions}>
              {chapter.actions.map((action, i) => (
                <Action key={action.href} action={action} primary={i === 0} />
              ))}
            </div>
          </div>
        </div>
      );
      break;
    case "problem":
      content = (
        <div className={styles.openCopy} data-light="true">
          <div className={styles.intro}>
            <h2>{chapter.title}</h2>
          </div>
          <div className={styles.body}>
            <p>{chapter.question}</p>
          </div>
        </div>
      );
      break;
    case "transition":
      content = (
        <div className={styles.openCopy} data-placement={chapter.placement}>
          <div className={styles.intro}>
            <Heading kicker={chapter.kicker} title={chapter.title} />
          </div>
          {chapter.lede ? (
            <div className={styles.body}>
              <p>{chapter.lede}</p>
            </div>
          ) : null}
        </div>
      );
      break;
    case "final":
      content = (
        <Panel
          intro={
            <>
              <Heading kicker={chapter.kicker} title={chapter.title} />
              <p className={styles.lede}>{chapter.lede}</p>
              <Action action={chapter.action} primary />
            </>
          }
        >
          <nav className={styles.footerLinks} aria-label="Footer">
            {chapter.footerLinks.map((link) => (
              <Link key={link.href} href={link.href} prefetch={false}>
                {link.label}
              </Link>
            ))}
          </nav>
          <p className={styles.copyright}>{chapter.copyright}</p>
        </Panel>
      );
      break;
  }
  return (
    <main className={styles.stage} data-mobile-stage="">
      <section
        id={chapter.id}
        className={styles.chapter}
        data-journey-chapter=""
        data-chapter-index={index}
        data-chapter-id={chapter.id}
        data-kind={chapter.kind}
        aria-label={`Chapter ${position + 1} of ${count}`}
        aria-hidden="false"
      >
        {content}
      </section>
    </main>
  );
}
