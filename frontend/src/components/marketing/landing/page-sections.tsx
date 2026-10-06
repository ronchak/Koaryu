import Link from "next/link";
import type { CSSProperties } from "react";

import { formatPublicPlatformPrice } from "../../../lib/constants.ts";
import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { ChapterAction } from "../journey/journey-chapters";
import { MarketingBrandLink } from "../marketing-primitives";
import { CLOSE_RIDGES, CLOSE_RIDGE_PATHS } from "./close-hills";
import styles from "./page.module.css";

function Check() {
  return (
    <svg className={styles.check} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** One price, laid out like the plan card in the app, with the roster sizes that do not change it. */
function Pricing() {
  const { pricing } = landingPageContent;
  return (
    <section id={pricing.id} className={styles.pricing} aria-labelledby="pricing-title">
      <div className={styles.pricingLead}>
        <h2 id="pricing-title" className={styles.title}>
          {pricing.title.split(/(?<=\.)\s+/).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </h2>
        <p className={styles.lede}>{pricing.lede}</p>
        <p className={styles.price} data-price-amount={pricing.amount}>
          {pricing.displayPrice}
          <span className={styles.pricePeriod}>{pricing.period}</span>
        </p>
        <p className={styles.trial}>{pricing.trial}</p>
        <div className={styles.actions}>
          <ChapterAction {...pricing.setupAction} variant="primary" className={styles.action} />
        </div>
        <p className={styles.note}>
          {pricing.paymentsNote.lead}{" "}
          <Link href={pricing.paymentsNote.href}>{pricing.paymentsNote.label}</Link>
        </p>
      </div>
      <div className={styles.plan}>
        <div className={styles.planHeader}>
          <h3>{pricing.plan.name}</h3>
          <p>{pricing.plan.scope}</p>
        </div>
        <ul className={styles.included} aria-label="Included in the studio plan">
          {pricing.included.map((item) => (
            <li key={item}>
              <Check />
              {item}
            </li>
          ))}
        </ul>
        <div className={styles.planFooter}>
          <p>{pricing.rosterNote}</p>
          <dl className={styles.rosters}>
            {pricing.rosterSizes.map((size) => (
              <div key={size}>
                <dt>{size} students</dt>
                <dd>{formatPublicPlatformPrice()}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
      <div className={styles.start}>
        <h3 className={styles.startTitle}>{pricing.start.title}</h3>
        <ol className={styles.steps}>
          {pricing.start.steps.map((step) => (
            <li key={step.title}>
              <span className={styles.stepTitle}>{step.title}</span>
              <span className={styles.stepText}>{step.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** A still of the hands-on demo that comes alive as it arrives: the class is marked and Maya is ready. */
function Miniature() {
  const { miniature } = landingPageContent.tryIt;
  return (
    <div className={styles.miniature} aria-hidden="true">
      <div className={styles.miniSidebar}>
        <span className={styles.miniBrand}>Koaryu</span>
        <span className={styles.miniNav} data-current="">
          Schedule
        </span>
        <span className={styles.miniNav}>Belt Tracker</span>
        <span className={styles.miniNav}>Leads</span>
      </div>
      <div className={styles.miniMain}>
        <div className={styles.miniBar}>
          <span>{miniature.studio}</span>
          <span className={styles.miniSample}>Sample data</span>
        </div>
        <div className={styles.miniClass}>
          <p className={styles.miniClassName}>
            {miniature.className} <span>Scheduled</span>
          </p>
          <p className={styles.miniWhen}>{miniature.when}</p>
        </div>
        <ol className={styles.miniRoster}>
          {miniature.students.map((student, index) => {
            const ready = student.attended + 1 >= student.required;
            return (
              <li
                key={student.name}
                className={styles.miniRow}
                data-ready={ready ? "true" : undefined}
                style={
                  {
                    "--row": index,
                    "--from": student.attended / student.required,
                    "--to": Math.min(1, (student.attended + 1) / student.required),
                  } as CSSProperties
                }
              >
                <span className={styles.miniAvatar}>{student.initials}</span>
                <span className={styles.miniWho}>
                  <span className={styles.miniName}>{student.name}</span>
                  <span className={styles.miniBeltLine}>
                    <span className={styles.miniBelt} data-belt={student.belt}>
                      {student.beltLabel}
                    </span>
                    {ready ? (
                      <span className={styles.miniReady}>{miniature.readyLabel}</span>
                    ) : null}
                  </span>
                </span>
                <span className={styles.miniProgress}>
                  <span className={styles.miniTrack}>
                    <span className={styles.miniFill} />
                  </span>
                  <span className={styles.miniCount}>
                    <span className={styles.miniBefore}>
                      {student.attended}/{student.required}
                    </span>
                    <span className={styles.miniAfter}>
                      {student.attended + 1}/{student.required}
                    </span>
                  </span>
                </span>
                <span className={styles.miniStatus}>
                  <span className={styles.miniCheckIn}>Check in</span>
                  <span className={styles.miniPresent}>Present</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function TryIt() {
  const { tryIt } = landingPageContent;
  return (
    <section id={tryIt.id} className={styles.try} aria-labelledby="try-title">
      <div className={styles.tryCopy}>
        <h2 id="try-title" className={styles.title}>
          {tryIt.title}
        </h2>
        <p className={styles.lede}>{tryIt.lede}</p>
        <ol className={styles.tasks}>
          {tryIt.tasks.map((task) => (
            <li key={task.title}>
              <span className={styles.taskTitle}>{task.title}</span>
              <span className={styles.taskText}>{task.description}</span>
            </li>
          ))}
        </ol>
        <div className={styles.actions}>
          <ChapterAction {...tryIt.action} variant="primary" className={styles.action} />
          <ChapterAction {...tryIt.secondaryAction} className={styles.action} />
        </div>
      </div>
      <figure className={styles.tryFigure}>
        <div className={styles.tryWindow}>
          <Miniature />
        </div>
        <figcaption className={styles.caption}>{tryIt.miniature.caption}</figcaption>
      </figure>
    </section>
  );
}

function Faq() {
  const { faq } = landingPageContent;
  return (
    <section id={faq.id} className={styles.faq} aria-labelledby="faq-title">
      <header className={styles.faqHeader}>
        <h2 id="faq-title" className={styles.title}>
          {faq.title}
        </h2>
        <p className={styles.lede}>{faq.lede}</p>
      </header>
      <div className={styles.faqGroups}>
        {faq.groups.map((group) => (
          <section key={group.id} id={group.id} className={styles.faqGroup}>
            <h3>{group.title}</h3>
            {group.items.map((item) => (
              <details key={item.question} className={styles.faqItem}>
                <summary>
                  <span>{item.question}</span>
                  <span className={styles.faqIcon} aria-hidden="true" />
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}

/** The story began in the hills; the page ends there, with the footer on the nearest ridge. */
function Close() {
  const { close } = landingPageContent;
  return (
    <section id={close.id} className={styles.close} aria-labelledby="close-title">
      <div className={styles.closeCopy}>
        <h2 id="close-title" className={styles.closeTitle}>
          {close.title.split(/(?<=\.)\s+/).map((line) => (
            <span key={line}>{line}</span>
          ))}
        </h2>
        <p className={styles.closeLede}>{close.lede}</p>
        <div className={styles.actions}>
          <ChapterAction {...close.action} variant="primary" className={styles.action} />
        </div>
      </div>
      <div className={styles.closeArt} aria-hidden="true">
        <div className={styles.closeSun} />
        {CLOSE_RIDGES.map((ridge, index) => (
          <svg
            key={ridge.baseY}
            className={styles.closeRidge}
            data-ridge={index}
            viewBox="0 0 1600 1000"
            preserveAspectRatio="xMidYMax slice"
            style={{ "--rise": ridge.rise } as CSSProperties}
          >
            <path d={CLOSE_RIDGE_PATHS[index]} />
          </svg>
        ))}
      </div>
      <footer className={styles.footer}>
        <MarketingBrandLink href="/" className={styles.footerBrand} />
        <nav aria-label="Footer">
          {close.footerLinks.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
        <p>{close.copyright}</p>
      </footer>
    </section>
  );
}

/** Act two: after the hand-off the page scrolls naturally. */
export function LandingPageSections() {
  return (
    <div className={styles.page}>
      <Pricing />
      <TryIt />
      <Faq />
      <Close />
    </div>
  );
}
