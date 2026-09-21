"use client";

import Link from "next/link";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  JourneyAction,
  JourneyChapter,
  JourneyFaqChapter,
} from "../../../lib/landing-page-content";
import styles from "./mobile-journey-chapter.module.css";

type Detail = { title: string; body: string; href?: string; meta?: string };

function useDetailFocus(selected: number | null) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const previous = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (selected !== null) titleRef.current?.focus({ preventScroll: true });
    else if (previous.current !== null) {
      overviewRef.current
        ?.querySelector<HTMLElement>(
          `[data-detail-index="${previous.current}"], select, [data-detail-trigger]`,
        )
        ?.focus({ preventScroll: true });
    }
    previous.current = selected;
  }, [selected]);
  return { titleRef, overviewRef };
}

function Action({ action, primary = false }: { action: JourneyAction; primary?: boolean }) {
  return (
    <Link
      href={action.href}
      prefetch={false}
      className={primary ? styles.primaryAction : styles.link}
    >
      {action.label}
      <span aria-hidden="true">{primary ? "" : " →"}</span>
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
  layout?: "overview" | "questions" | "pricing";
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

function Choices({
  label,
  heading,
  entries,
  link,
}: {
  label: string;
  heading: string;
  entries: readonly Detail[];
  link: JourneyAction;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const { titleRef, overviewRef } = useDetailFocus(selected);
  const detail = selected === null ? null : entries[selected];
  if (detail)
    return (
      <Panel
        intro={
          <>
            <button type="button" className={styles.back} onClick={() => setSelected(null)}>
              ← {label}
            </button>
            <h2 ref={titleRef} tabIndex={-1}>
              {detail.title}
            </h2>
          </>
        }
      >
        <p>{detail.body}</p>
        {detail.meta ? <p className={styles.meta}>{detail.meta}</p> : null}
        {detail.href ? (
          <Action
            action={{
              href: detail.href,
              label:
                "Explore this " +
                (label === "Features" ? "feature" : label === "Use cases" ? "workflow" : "guide"),
            }}
          />
        ) : (
          <Action action={link} />
        )}
      </Panel>
    );
  return (
    <Panel layout="overview" intro={<Heading kicker={label} title={heading} />}>
      <div ref={overviewRef}>
        <div className={styles.choices} aria-label={`${label} details`}>
          {entries.map((entry, index) => (
            <button
              key={entry.title}
              data-detail-index={index}
              type="button"
              onClick={() => setSelected(index)}
            >
              {entry.title}
              <span aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      </div>
      <Action action={link} />
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
  const [view, setView] = useState<"topics" | "questions" | "answer">(() =>
    typeof window !== "undefined" && window.location.hash.startsWith("#faq-")
      ? "questions"
      : "topics",
  );
  const group = chapter.groups[groupIndex] ?? chapter.groups[0]!;
  const item = group.items[Math.max(0, itemIndex)] ?? group.items[0]!;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const topicsRef = useRef<HTMLDivElement>(null);
  const questionsRef = useRef<HTMLDivElement>(null);
  const previousView = useRef<typeof view | null>(null);
  useLayoutEffect(() => {
    if (view === "topics" && previousView.current !== null) {
      topicsRef.current
        ?.querySelector<HTMLElement>(`[data-mobile-topic="${groupIndex}"]`)
        ?.focus({ preventScroll: true });
    } else if (view === "questions" && previousView.current === "answer") {
      questionsRef.current
        ?.querySelector<HTMLElement>(`[data-mobile-question="${itemIndex}"]`)
        ?.focus({ preventScroll: true });
    } else if (view !== "topics" && previousView.current !== view) {
      titleRef.current?.focus({ preventScroll: true });
    }
    previousView.current = view;
  }, [view, groupIndex, itemIndex]);
  if (view === "topics")
    return (
      <Panel layout="overview" intro={<h2>{chapter.kicker}</h2>}>
        <div ref={topicsRef} className={styles.choices} aria-label="Question topics">
          {chapter.groups.map((topic, i) => (
            <button
              key={topic.title}
              type="button"
              data-mobile-topic={i}
              onClick={() => {
                setView("questions");
                onChange(i, 0);
              }}
            >
              {topic.title}
              <span aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      </Panel>
    );
  if (view === "questions")
    return (
      <Panel
        layout="questions"
        intro={
          <>
            <button type="button" className={styles.back} onClick={() => setView("topics")}>
              ← Question topics
            </button>
            <h2 ref={titleRef} tabIndex={-1}>
              {group.title}
            </h2>
          </>
        }
      >
        <div
          ref={questionsRef}
          className={styles.choices}
          data-count={group.items.length}
          aria-label="Questions"
        >
          {group.items.map((question, i) => (
            <button
              key={question.question}
              data-mobile-question={i}
              type="button"
              onClick={() => {
                setView("answer");
                onChange(groupIndex, i);
              }}
            >
              {question.question}
              <span aria-hidden="true">↗</span>
            </button>
          ))}
        </div>
      </Panel>
    );
  return (
    <Panel
      intro={
        <>
          <button type="button" className={styles.back} onClick={() => setView("questions")}>
            ← {group.title}
          </button>
          <h2 className={styles.question} ref={titleRef} tabIndex={-1}>
            {item.question}
          </h2>
        </>
      }
    >
      <p>{item.answer}</p>
    </Panel>
  );
}

export function MobileJourneyChapter({
  chapter,
  index,
  count,
  faqGroup,
  faqItem,
  onFaqChange,
}: {
  chapter: JourneyChapter;
  index: number;
  count: number;
  faqGroup: number;
  faqItem: number;
  onFaqChange: (group: number, item: number) => void;
}) {
  const [detail, setDetail] = useState<number | null>(null);
  const { titleRef, overviewRef } = useDetailFocus(detail);
  let content: ReactNode;
  switch (chapter.kind) {
    case "features":
    case "use-cases":
      content = (
        <Choices
          label={chapter.kind === "features" ? "Features" : "Use cases"}
          heading={chapter.heading}
          entries={chapter.rows.map((row, rowIndex) => ({
            title: row.title,
            body:
              chapter.kind === "features" && rowIndex === 0
                ? `${chapter.lede} ${row.description}`
                : row.description,
            href: row.detail.href,
          }))}
          link={chapter.link}
        />
      );
      break;
    case "explore":
      content = (
        <Choices
          label="Explore"
          heading={chapter.heading}
          entries={chapter.routes}
          link={chapter.link}
        />
      );
      break;
    case "about":
      content = (
        <Choices
          label="About Koaryu"
          heading={chapter.heading}
          entries={[
            { title: "Why Koaryu", body: chapter.lede },
            ...chapter.principles.map((item) => ({ title: item.title, body: item.description })),
          ]}
          link={chapter.link}
        />
      );
      break;
    case "morning":
      content =
        detail === null ? (
          <Panel intro={<Heading kicker={chapter.kicker} title={chapter.title} />}>
            <p>{chapter.lede}</p>
            <button
              type="button"
              className={styles.link}
              data-detail-trigger=""
              onClick={() => setDetail(0)}
            >
              {chapter.proofLabel} →
            </button>
          </Panel>
        ) : (
          <Panel
            intro={
              <>
                <button type="button" className={styles.back} onClick={() => setDetail(null)}>
                  ← Your morning
                </button>
                <h2 ref={titleRef} tabIndex={-1}>
                  {chapter.proofLabel}
                </h2>
              </>
            }
          >
            <p>{chapter.proof}</p>
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
    case "pricing": {
      const fact = detail === null ? null : chapter.facts[detail];
      content = fact ? (
        <Panel
          intro={
            <>
              <button type="button" className={styles.back} onClick={() => setDetail(null)}>
                ← Pricing
              </button>
              <h2 ref={titleRef} tabIndex={-1}>
                {fact.label}
              </h2>
            </>
          }
        >
          <p>{fact.description}</p>
          <Action action={chapter.setupAction} primary />
        </Panel>
      ) : (
        <Panel layout="pricing" intro={<Heading kicker={chapter.kicker} title={chapter.heading} />}>
          <div className={styles.priceRow}>
            <p className={styles.price}>{chapter.displayPrice}</p>
            <p>{chapter.period}</p>
          </div>
          <p className={styles.feeNote}>Stripe processing fees are billed separately.</p>
          <div className={`${styles.choices} ${styles.priceChoices}`} aria-label="Pricing details">
            {chapter.facts.map((item, i) => (
              <button
                key={item.label}
                data-detail-index={i}
                type="button"
                onClick={() => setDetail(i)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Action action={chapter.setupAction} primary />
        </Panel>
      );
      break;
    }
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
        <div className={`${styles.openCopy} ${styles.hero}`}>
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
            <p className={styles.aside}>{chapter.aside}</p>
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
    <main ref={overviewRef} className={styles.stage} data-mobile-stage="">
      <section
        id={chapter.id}
        className={styles.chapter}
        data-journey-chapter=""
        data-chapter-index={index}
        data-chapter-id={chapter.id}
        data-kind={chapter.kind}
        aria-label={`Chapter ${index + 1} of ${count}`}
        aria-hidden="false"
      >
        {content}
      </section>
    </main>
  );
}
