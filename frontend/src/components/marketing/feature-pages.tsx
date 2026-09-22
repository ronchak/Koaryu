import Link from "next/link";
import type { ReactNode } from "react";

import { MarketingActionLink } from "@/components/marketing/marketing-primitives";
import { PublicPageShell } from "@/components/marketing/public-pages";
import { formatPublicPlatformPrice } from "@/lib/constants";
import { featurePages, type MarketingPage } from "@/lib/marketing-pages";

import styles from "./feature-pages.module.css";

const featureStories = {
  "student-management": {
    title: "Know the student. Remember the details.",
    description:
      "The guardian at the desk, the instructor on the mat, the owner catching up later. Give your team one student record to work from.",
    shortTitle: "Student records",
    question: "Who trains here, and what should we know?",
    summary:
      "Keep programs, guardians, emergency contacts, notes, and rank history with the student they belong to.",
    points: ["Students & guardians", "Programs & status", "Notes & history"],
    jump: "Inside the record",
  },
  "belt-tracking": {
    title: "Every belt has a history. Keep it.",
    description:
      "Build your school's rank ladders, see the requirements behind a promotion shortlist, and leave the teaching decision with the instructor.",
    shortTitle: "Rank progression",
    question: "Who is ready for the next conversation?",
    summary:
      "Bring class counts, time at rank, and instructor approval into the same review. Your programs keep their own rank ladders.",
    points: ["Program ladders", "Readiness signals", "Promotion history"],
    jump: "How readiness works",
  },
  attendance: {
    title: "Take attendance. Put it to work.",
    description:
      "Open the class, mark the roster, and keep a record that is useful after everyone goes home. Training history feeds retention and rank review.",
    shortTitle: "Schedule & attendance",
    question: "Who came to class? Who hasn't been back?",
    summary:
      "Run recurring classes by program, take attendance from the roster, and use that history in your next student conversation.",
    points: ["Weekly schedule", "Class check-in", "Attendance history"],
    jump: "A class from start to finish",
  },
  billing: {
    title: "Have the tuition conversation with the facts.",
    description:
      "See the student, family payer, and existing billing records together. Give authorized staff enough context to understand what needs attention.",
    shortTitle: "Billing visibility",
    question: "Who pays, what is recorded, and what needs attention?",
    summary:
      "Review existing plans, invoices, payment status, and external payment notes. Tuition collection requires separate studio activation.",
    points: ["Family payers", "Existing invoices", "Payment attention"],
    jump: "What is available",
  },
} as const;

type FeatureSlug = keyof typeof featureStories;

function isFeatureSlug(slug: string): slug is FeatureSlug {
  return Object.hasOwn(featureStories, slug);
}

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} prefetch={href === "/signup" ? false : undefined} className={styles.textLink}>
      <span>{children}</span>
      <Arrow />
    </Link>
  );
}

function SectionIntro({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.sectionIntro}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

function StudentRecord() {
  return (
    <figure className={`${styles.example} ${styles.studentExample}`}>
      <figcaption>Illustrative student record</figcaption>
      <div className={styles.recordIdentity}>
        <span className={styles.monogram} aria-hidden="true">
          MT
        </span>
        <div>
          <p className={styles.smallLabel}>Student / active</p>
          <h2>Maya Tanaka</h2>
          <p>Juniors karate · Yellow belt</p>
        </div>
      </div>
      <dl className={styles.recordFields}>
        <div>
          <dt>Guardian</dt>
          <dd>Alex Tanaka · Parent</dd>
        </div>
        <div>
          <dt>Program</dt>
          <dd>Juniors karate</dd>
        </div>
        <div>
          <dt>Recent class</dt>
          <dd>Tuesday · 4:30 pm</dd>
        </div>
      </dl>
      <div className={styles.recordNote}>
        <p className={styles.smallLabel}>Instructor note</p>
        <p>Good focus in partner work. Review the opening sequence together next class.</p>
      </div>
      <p className={styles.exampleFootnote}>
        One student&apos;s context, ready for the next member of staff.
      </p>
    </figure>
  );
}

function RankReview() {
  return (
    <figure className={`${styles.example} ${styles.rankExample}`}>
      <figcaption>Illustrative readiness review</figcaption>
      <p className={styles.smallLabel}>Juniors karate / next rank</p>
      <h2>Yellow → Orange</h2>
      <div className={styles.beltDrawing} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <dl className={styles.readinessSignals}>
        <div>
          <dt>Classes at current rank</dt>
          <dd>
            <strong>24 / 24</strong>
            <span>Requirement met</span>
          </dd>
        </div>
        <div>
          <dt>Time at current rank</dt>
          <dd>
            <strong>3 / 3 months</strong>
            <span>Requirement met</span>
          </dd>
        </div>
        <div>
          <dt>Instructor approval</dt>
          <dd>
            <strong>To review</strong>
            <span>Your decision</span>
          </dd>
        </div>
      </dl>
      <p className={styles.exampleFootnote}>Example requirements only. Your school sets its own.</p>
    </figure>
  );
}

function ClassRegister() {
  return (
    <figure className={`${styles.example} ${styles.attendanceExample}`}>
      <figcaption>Illustrative class register</figcaption>
      <div className={styles.classHeading}>
        <div>
          <p className={styles.smallLabel}>Tuesday / 4:30 pm</p>
          <h2>Juniors karate</h2>
        </div>
        <span className={styles.classMark} aria-hidden="true">
          道
        </span>
      </div>
      <ul className={styles.register}>
        <li>
          <span>Maya Tanaka</span>
          <span>
            <i aria-hidden="true">✓</i> Present
          </span>
        </li>
        <li>
          <span>Leo Rivera</span>
          <span>
            <i aria-hidden="true">✓</i> Present
          </span>
        </li>
        <li>
          <span>Sam Patel</span>
          <span>
            <i aria-hidden="true">−</i> Unmarked
          </span>
        </li>
      </ul>
      <div className={styles.registerNote}>
        <span aria-hidden="true">↳</span>
        <p>Each attendance change saves as you mark it.</p>
      </div>
      <p className={styles.exampleFootnote}>A sample class, not a live check-in screen.</p>
    </figure>
  );
}

function PayerRecord() {
  return (
    <figure className={`${styles.example} ${styles.billingExample}`}>
      <figcaption>Illustrative family billing context</figcaption>
      <p className={styles.smallLabel}>Family payer</p>
      <h2>Alex Tanaka</h2>
      <div className={styles.payerStudents}>
        <div>
          <span>Student</span>
          <strong>Maya</strong>
          <span>Juniors karate</span>
        </div>
        <div>
          <span>Student</span>
          <strong>Ren</strong>
          <span>Little dragons</span>
        </div>
      </div>
      <dl className={styles.recordFields}>
        <div>
          <dt>Existing invoice</dt>
          <dd>Needs attention</dd>
        </div>
        <div>
          <dt>External payment</dt>
          <dd>Check recorded locally</dd>
        </div>
      </dl>
      <p className={styles.exampleFootnote}>Recording an external payment does not move money.</p>
    </figure>
  );
}

const illustrations = {
  "student-management": StudentRecord,
  "belt-tracking": RankReview,
  attendance: ClassRegister,
  billing: PayerRecord,
};

function FeatureMotif({ slug }: { slug: FeatureSlug }) {
  return (
    <div className={`${styles.motif} ${styles[`${slug}Motif`]}`} aria-hidden="true">
      {slug === "student-management" ? (
        <>
          <span>MT</span>
          <span>
            Profile
            <br />
            Program
            <br />
            History
          </span>
        </>
      ) : null}
      {slug === "belt-tracking" ? (
        <>
          <span />
          <span />
          <span />
          <span />
        </>
      ) : null}
      {slug === "attendance" ? (
        <>
          <span>M</span>
          <span>T</span>
          <span>W</span>
          <span>T</span>
          <span>F</span>
        </>
      ) : null}
      {slug === "billing" ? (
        <>
          <span>Family payer</span>
          <span>
            Student ↗<br />
            Student ↗
          </span>
        </>
      ) : null}
    </div>
  );
}

export function FeatureIndexPage() {
  return (
    <PublicPageShell>
      <div className={styles.page}>
        <section className={`${styles.hero} ${styles.indexHero}`}>
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>The Koaryu product</p>
            <h1>
              One school.
              <br />
              One shared picture.
            </h1>
            <p className={styles.lede}>
              Students, classes, rank progress, and tuition context. The everyday work of a martial
              arts school, connected by the people who train there.
            </p>
            <div className={styles.actions}>
              <MarketingActionLink href="#feature-map" className={styles.primaryAction}>
                Find your starting point
              </MarketingActionLink>
              <TextLink href="/use-cases">See it in a workflow</TextLink>
            </div>
          </div>
          <div className={styles.indexDiagram} aria-label="Students connect the four product areas">
            <div className={styles.diagramCenter}>
              <span className={styles.eyebrow}>At the center</span>
              <strong>Your students</strong>
              <p>The same people, throughout the school day.</p>
            </div>
            <ol>
              <li>
                <span>01</span>
                <strong>Know the person</strong>
                <small>Student records</small>
              </li>
              <li>
                <span>02</span>
                <strong>Record the class</strong>
                <small>Attendance</small>
              </li>
              <li>
                <span>03</span>
                <strong>Review the progress</strong>
                <small>Rank progression</small>
              </li>
              <li>
                <span>04</span>
                <strong>Understand the account</strong>
                <small>Billing visibility</small>
              </li>
            </ol>
          </div>
        </section>

        <section id="feature-map" className={styles.section} aria-labelledby="feature-map-heading">
          <div className={styles.indexHeading}>
            <div>
              <p className={styles.eyebrow}>Four places to start</p>
              <h2 id="feature-map-heading">What do you need to know?</h2>
            </div>
            <p>
              Choose a product area for a closer look at the records, decisions, and daily work it
              supports.
            </p>
          </div>
          <div className={styles.featureGrid}>
            {featurePages.map((page, index) => {
              if (!isFeatureSlug(page.slug)) return null;
              const story = featureStories[page.slug];
              return (
                <article key={page.slug} className={styles.featureEntry}>
                  <div className={styles.entryTop}>
                    <span className={styles.eyebrow}>
                      0{index + 1} / {story.shortTitle}
                    </span>
                    <FeatureMotif slug={page.slug} />
                  </div>
                  <h3>{story.question}</h3>
                  <p>{story.summary}</p>
                  <ul className={styles.featurePoints}>
                    {story.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                  <TextLink href={page.href}>Explore {story.shortTitle.toLowerCase()}</TextLink>
                </article>
              );
            })}
          </div>
        </section>

        <section className={styles.connectionSection}>
          <SectionIntro
            eyebrow="The connection matters"
            title="A class ends. The record keeps working."
          >
            A useful attendance record helps answer more than whether someone was in the room.
          </SectionIntro>
          <ol className={styles.connectionSteps}>
            <li>
              <span>01</span>
              <div>
                <h3>On the mat</h3>
                <p>An instructor marks attendance for the class.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>At the next check-in</h3>
                <p>Staff can review training history and notice when a student has gone quiet.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>Before the next test</h3>
                <p>
                  Class counts contribute to rank readiness where the school&apos;s requirements use
                  them.
                </p>
              </div>
            </li>
          </ol>
          <TextLink href="/use-cases/student-retention">Follow the retention workflow</TextLink>
        </section>

        <section className={`${styles.section} ${styles.fitSection}`}>
          <SectionIntro eyebrow="A practical fit" title="Built around one independent school.">
            Koaryu is for owners and small teams who teach, manage the roster, and run the front
            desk. Current scope is one studio location.
          </SectionIntro>
          <div className={styles.fitNotes}>
            <article>
              <h3>Keep your existing roster</h3>
              <p>
                Use the CSV import path to bring student records forward. Review the fields and
                resolve import issues before treating the roster as ready.
              </p>
              <TextLink href="/use-cases/spreadsheets-to-studio-crm">Plan the move</TextLink>
            </article>
            <article>
              <h3>Understand billing before you start</h3>
              <p>
                Existing billing records and external payment notes are distinct from collecting
                tuition. Provider actions require separate activation for the exact studio.
              </p>
              <TextLink href="/features/billing">Read the billing scope</TextLink>
            </article>
          </div>
        </section>
        <FeatureClosing />
      </div>
    </PublicPageShell>
  );
}

function StudentStory() {
  return (
    <>
      <section id="page-details" className={`${styles.section} ${styles.studentStory}`}>
        <SectionIntro eyebrow="Inside the record" title="The details you need before saying hello.">
          A student profile should answer the questions that come up in a real lobby, with a family
          waiting in front of you.
        </SectionIntro>
        <div className={styles.recordTopics}>
          <article>
            <span className={styles.topicNumber}>01</span>
            <h3>Who trains here?</h3>
            <p>
              Names, student status, programs, and current rank help staff understand where someone
              fits. Search and status filters make a growing roster easier to work through.
            </p>
          </article>
          <article>
            <span className={styles.topicNumber}>02</span>
            <h3>Who should we contact?</h3>
            <p>
              Keep guardian details and emergency contacts with the student&apos;s record. A
              child&apos;s class conversation and the family&apos;s account conversation do not have
              to start from scratch.
            </p>
          </article>
          <article>
            <span className={styles.topicNumber}>03</span>
            <h3>What happened last time?</h3>
            <p>
              Internal notes preserve the useful details between shifts. Training and promotion
              history give the next instructor context before class begins.
            </p>
          </article>
          <article>
            <span className={styles.topicNumber}>04</span>
            <h3>What needs attention?</h3>
            <p>
              Use status, attendance, and rank context to decide where to look next. Authorized
              staff can connect the student to the relevant family payer and billing records.
            </p>
          </article>
        </div>
      </section>
      <section className={styles.connectionSection}>
        <div className={styles.splitSection}>
          <SectionIntro
            eyebrow="A handoff that holds up"
            title="The note should outlast the shift."
          >
            A parent mentions a concern to the front desk. An instructor can review the
            student&apos;s context before the next class. The owner can pick up the conversation
            later.
          </SectionIntro>
          <div className={styles.handoff}>
            <p className={styles.smallLabel}>Illustrative staff handoff</p>
            <p className={styles.handoffQuote}>
              &quot;Maya enjoyed partner drills. Her parent asked what to practice before the next
              class.&quot;
            </p>
            <ol>
              <li>Front desk records the conversation</li>
              <li>Instructor reviews the student notes</li>
              <li>The next conversation starts with context</li>
            </ol>
            <p className={styles.exampleFootnote}>
              Sample note. Staff access depends on their role.
            </p>
          </div>
        </div>
      </section>
      <section className={`${styles.section} ${styles.splitSection}`}>
        <SectionIntro
          eyebrow="Start with the people you have"
          title="Your roster does not need a fresh start."
        >
          Bring existing records through the CSV import path, then review the students, programs,
          and family details your school uses every day.
        </SectionIntro>
        <div className={styles.plainCopy}>
          <h3>Keep access appropriate to the job</h3>
          <p>
            Admins, instructors, and front-desk staff have different responsibilities. Koaryu
            applies role-aware access, including separate boundaries for sensitive billing
            information.
          </p>
          <TextLink href="/use-cases/spreadsheets-to-studio-crm">
            See the spreadsheet-to-roster workflow
          </TextLink>
        </div>
      </section>
    </>
  );
}

function RankStory() {
  return (
    <>
      <section id="page-details" className={styles.section}>
        <SectionIntro
          eyebrow="Your school's progression"
          title="The ladder should match what you teach."
        >
          Kids, adults, and different disciplines can follow different rank ladders. Order the
          ranks, include tips where you use them, and define the requirements for each step.
        </SectionIntro>
        <figure className={styles.ladderFigure}>
          <figcaption>
            Illustrative rank ladder / your names, order, and requirements may differ
          </figcaption>
          <ol className={styles.ladder}>
            <li>
              <span className={styles.rankSwatch} data-rank="white" />
              <strong>White</strong>
              <span>Starting point</span>
            </li>
            <li>
              <span className={styles.rankSwatch} data-rank="yellow" />
              <strong>Yellow</strong>
              <span>Current rank</span>
            </li>
            <li>
              <span className={styles.rankSwatch} data-rank="orange" />
              <strong>Orange</strong>
              <span>Next review</span>
            </li>
            <li>
              <span className={styles.rankSwatch} data-rank="green" />
              <strong>Green</strong>
              <span>Later in the ladder</span>
            </li>
          </ol>
        </figure>
        <div className={styles.requirements}>
          <article>
            <h3>Classes at rank</h3>
            <p>
              Set a minimum class count when attendance is part of your requirements. Recorded
              training contributes to the readiness review.
            </p>
          </article>
          <article>
            <h3>Time at rank</h3>
            <p>
              Set a minimum time requirement to give students room to develop between promotions.
            </p>
          </article>
          <article>
            <h3>Instructor approval</h3>
            <p>
              Require a human review where your school needs one. Meeting the numbers does not
              replace the instructor&apos;s assessment.
            </p>
          </article>
        </div>
      </section>
      <section className={styles.judgmentSection}>
        <p className={styles.eyebrow}>A shortlist, with reasons</p>
        <h2>
          Ready for review
          <br />
          is a conversation.
        </h2>
        <p>
          A student can meet the class and time requirements while still needing instructor
          approval. Koaryu makes those signals visible so you can review the person behind the
          numbers.
        </p>
        <TextLink href="/use-cases/belt-test-readiness">
          Walk through belt test preparation
        </TextLink>
      </section>
      <section className={`${styles.section} ${styles.splitSection}`}>
        <SectionIntro eyebrow="After the decision" title="The next review starts with a history.">
          Recorded promotions stay attached to the student. Profile edits do not rewrite those
          chronological entries.
        </SectionIntro>
        <ol className={styles.history} aria-label="Illustrative promotion history">
          <li>
            <span>Joined the program</span>
            <strong>White belt</strong>
            <p>A clear starting point for the training record.</p>
          </li>
          <li>
            <span>Promotion recorded</span>
            <strong>Yellow belt</strong>
            <p>The rank change and date remain in the student&apos;s history.</p>
          </li>
          <li>
            <span>Next review</span>
            <strong>Orange belt</strong>
            <p>Review fresh attendance, time at rank, and the required approval.</p>
          </li>
        </ol>
      </section>
    </>
  );
}

function AttendanceStory() {
  return (
    <>
      <section id="page-details" className={styles.section}>
        <SectionIntro eyebrow="A class from start to finish" title="Built for the weekly rhythm.">
          Set up recurring classes with their program, day, time, and capacity. Work from
          today&apos;s schedule when it is time to teach.
        </SectionIntro>
        <div className={styles.classDay}>
          <article>
            <p className={styles.eyebrow}>Before class</p>
            <h3>Open the right session.</h3>
            <p>
              The class brings together its time, program, and current roster. Staff can work from
              the session they are about to teach.
            </p>
            <span className={styles.dayDetail}>Program · Day · Time · Capacity</span>
          </article>
          <article>
            <p className={styles.eyebrow}>As students arrive</p>
            <h3>Mark the roster.</h3>
            <p>
              Attendance saves one student at a time. The class view shows the recorded status,
              including who is still unmarked.
            </p>
            <span className={styles.dayDetail}>Present · Absent · Unmarked</span>
          </article>
          <article>
            <p className={styles.eyebrow}>After class</p>
            <h3>Keep the history.</h3>
            <p>
              Those check-ins become part of the student&apos;s training record and the reports you
              use to review attendance.
            </p>
            <span className={styles.dayDetail}>Student history · Reports · Rank review</span>
          </article>
        </div>
      </section>
      <section className={styles.connectionSection}>
        <div className={styles.splitSection}>
          <SectionIntro
            eyebrow="When someone goes quiet"
            title="An empty place on the mat deserves a look."
          >
            Attendance history gives you somewhere to start when a regular student stops coming.
            Review the record, check the notes, then decide whether to follow up.
          </SectionIntro>
          <figure className={styles.trainingPattern}>
            <figcaption>Illustrative attendance pattern</figcaption>
            <div className={styles.trainingWeeks}>
              <div>
                <span>Week 1</span>
                <strong>2 classes</strong>
                <i data-count="two" />
              </div>
              <div>
                <span>Week 2</span>
                <strong>2 classes</strong>
                <i data-count="two" />
              </div>
              <div>
                <span>Week 3</span>
                <strong>1 class</strong>
                <i data-count="one" />
              </div>
              <div>
                <span>Week 4</span>
                <strong>No classes</strong>
                <i data-count="zero" />
              </div>
            </div>
            <p>
              A change in attendance is a reason to check in. It does not tell you the reason on its
              own.
            </p>
          </figure>
        </div>
        <TextLink href="/use-cases/student-retention">See the follow-up workflow</TextLink>
      </section>
      <section className={`${styles.section} ${styles.splitSection}`}>
        <SectionIntro
          eyebrow="Before the next belt test"
          title="Count the classes you already recorded."
        >
          Where your school uses class minimums, attendance contributes to promotion readiness. The
          instructor can review that signal alongside time at rank and any required approval.
        </SectionIntro>
        <div className={styles.plainCopy}>
          <h3>One record, several useful questions</h3>
          <ul>
            <li>Has this student been training recently?</li>
            <li>What does their class history look like?</li>
            <li>Have they met the attendance requirement for the next rank?</li>
          </ul>
          <TextLink href="/features/belt-tracking">Connect attendance to rank progression</TextLink>
        </div>
      </section>
    </>
  );
}

function BillingStory() {
  return (
    <>
      <section id="page-details" className={styles.section}>
        <SectionIntro eyebrow="Know the scope" title="See the account. Know what happens next.">
          There is a difference between understanding an existing account, recording a payment
          received elsewhere, and collecting tuition through Stripe.
        </SectionIntro>
        <div className={styles.billingScope}>
          <article>
            <p className={styles.eyebrow}>01 / Existing records</p>
            <h3>Read the account.</h3>
            <p>
              Authorized Admin and Front Desk staff can review existing plans, family payers,
              students linked to a plan, invoices, and payment status.
            </p>
            <ul>
              <li>See who is associated with the student</li>
              <li>Find missing account details or failed payments</li>
              <li>See which invoices are overdue</li>
              <li>Refresh existing Stripe invoices to see their latest status</li>
            </ul>
          </article>
          <article>
            <p className={styles.eyebrow}>02 / External payments</p>
            <h3>Record what happened elsewhere.</h3>
            <p>
              Record cash, check, Zelle, Venmo, or payments received elsewhere. These notes stay in
              Koaryu and do not change Stripe.
            </p>
            <ul>
              <li>Keep payment notes with the family payer</li>
              <li>Distinguish payments received elsewhere from Stripe payments</li>
              <li>Record an outcome without moving money</li>
            </ul>
          </article>
          <article className={styles.activationScope}>
            <p className={styles.eyebrow}>03 / Collecting tuition</p>
            <h3>Activate for the exact studio.</h3>
            <p>
              Tuition collection is not generally available. Stripe collection actions require
              separate activation for your studio and the appropriate staff role.
            </p>
            <ul>
              <li>Sign-up alone does not enable tuition collection</li>
              <li>Staff see the actions enabled for their school</li>
            </ul>
          </article>
        </div>
      </section>
      <section className={styles.connectionSection}>
        <div className={styles.splitSection}>
          <SectionIntro
            eyebrow="The family behind the account"
            title="Start with who pays. Then understand the issue."
          >
            A student attends class. A parent may handle tuition for more than one child. Keeping
            the family payer in view helps staff have a useful conversation.
          </SectionIntro>
          <ol className={styles.billingQuestions}>
            <li>
              <span>01</span>
              <div>
                <h3>Whose account is this?</h3>
                <p>Review the payer and the associated student billing records.</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>What is already recorded?</h3>
                <p>
                  Check existing invoices, status, and external payment notes before making
                  assumptions.
                </p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>What needs a conversation?</h3>
                <p>
                  Use the tuition attention view to identify gaps, overdue invoices, or
                  failed-payment context.
                </p>
              </div>
            </li>
          </ol>
        </div>
        <TextLink href="/use-cases/tuition-cleanup">Walk through tuition cleanup</TextLink>
      </section>
      <section className={`${styles.section} ${styles.billingBoundaries}`}>
        <article>
          <p className={styles.eyebrow}>Staff access</p>
          <h2>The teaching role stays separate.</h2>
          <p>
            Billing visibility is for Admin and Front Desk. Instructors do not receive access to
            billing records, so teaching staff can focus on the students without seeing family
            finances.
          </p>
        </article>
        <article>
          <p className={styles.eyebrow}>Platform subscription</p>
          <h2>{formatPublicPlatformPrice()}</h2>
          <p>
            This is the Koaryu platform price. It is separate from your students&apos; tuition and
            does not by itself activate tuition collection.
          </p>
          <TextLink href="/#pricing">Review platform pricing</TextLink>
        </article>
      </section>
    </>
  );
}

const detailStories = {
  "student-management": StudentStory,
  "belt-tracking": RankStory,
  attendance: AttendanceStory,
  billing: BillingStory,
};

const featureQuestions: Record<FeatureSlug, { question: string; answer: string }[]> = {
  "student-management": [
    {
      question: "Can I bring over an existing student spreadsheet?",
      answer:
        "Koaryu has a CSV import path for student records. Review the import fields and resolve validation issues as part of the move. The switching workflow explains where to begin.",
    },
    {
      question: "Does each staff member see the same information?",
      answer:
        "Staff work from the same underlying student records, but access depends on their role. Billing information has a separate access boundary for Admin and Front Desk.",
    },
    {
      question: "What happens to promotion history when I edit a profile?",
      answer:
        "Recorded promotions remain chronological history entries. Editing the profile does not rewrite or remove those entries.",
    },
  ],
  "belt-tracking": [
    {
      question: "Can different programs use different belts?",
      answer:
        "Yes. Programs can use their own ordered rank ladders and requirements, including tips where your school uses them.",
    },
    {
      question: "Does meeting the requirements automatically promote a student?",
      answer:
        "Readiness supports a staff decision. Review the class and time requirements, complete any required instructor approval, and make the promotion decision through the school's workflow.",
    },
    {
      question: "Which requirements can I set?",
      answer:
        "Ranks support minimum class counts, minimum time at rank, and instructor approval requirements. Set the rules to reflect how your school evaluates progress.",
    },
  ],
  attendance: [
    {
      question: "Can I set up a recurring class schedule?",
      answer:
        "Yes. Recurring class templates include the program, day, time, and capacity, so the schedule reflects the school's weekly routine.",
    },
    {
      question: "Does attendance need a separate save at the end?",
      answer:
        "Each attendance change saves as you mark a student. The class view shows saving and error states so staff can see whether a change was recorded.",
    },
    {
      question: "Does a missed class explain why a student is absent?",
      answer:
        "No. Attendance is a signal to review alongside notes and other student context. Staff still need to decide whether and how to follow up.",
    },
  ],
  billing: [
    {
      question: "Can every new studio start collecting tuition immediately?",
      answer:
        "No. Tuition collection is not generally available. Stripe collection actions require separate activation for your studio, and the staff member must have the appropriate role.",
    },
    {
      question: "Does recording a cash or check payment charge the family?",
      answer:
        "No. It records a payment received elsewhere. It does not charge the family or move money through Stripe.",
    },
    {
      question: "What happens when I refresh an existing Stripe invoice?",
      answer:
        "Koaryu checks the existing invoice in Stripe and updates its recorded status. That check does not charge the family or create another invoice.",
    },
    {
      question: "Can instructors view billing records?",
      answer:
        "No. Billing access is for Admin and Front Desk. The instructor role cannot view family billing records.",
    },
  ],
};

function FeatureClosing() {
  return (
    <section className={styles.closing}>
      <div>
        <p className={styles.eyebrow}>Your next step</p>
        <h2>
          Start with the part
          <br />
          of the day that needs help.
        </h2>
        <p>Browse the workflows, or begin setting up your school&apos;s account.</p>
      </div>
      <div className={styles.closingActions}>
        <MarketingActionLink href="/signup" prefetch={false} className={styles.primaryAction}>
          Start setup
        </MarketingActionLink>
        <TextLink href="/use-cases">Browse studio workflows</TextLink>
      </div>
    </section>
  );
}

export function FeatureDetailPage({
  page,
  relatedPages,
}: {
  page: MarketingPage;
  relatedPages: MarketingPage[];
}) {
  if (!isFeatureSlug(page.slug)) return null;
  const story = featureStories[page.slug];
  const Illustration = illustrations[page.slug];
  const Story = detailStories[page.slug];

  return (
    <PublicPageShell>
      <div className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <Link className={styles.backLink} href="/features">
              <span aria-hidden="true">←</span> All features
            </Link>
            <p className={styles.eyebrow}>{story.shortTitle} / Koaryu</p>
            <h1>{story.title}</h1>
            <p className={styles.lede}>{story.description}</p>
            <div className={styles.actions}>
              <MarketingActionLink href="#page-details" className={styles.primaryAction}>
                {story.jump}
              </MarketingActionLink>
              <TextLink href="/signup">Start setup</TextLink>
            </div>
            {page.slug === "billing" ? (
              <p className={styles.heroCaveat}>
                Tuition collection requires separate activation for your studio.
              </p>
            ) : null}
          </div>
          <Illustration />
        </section>
        <Story />
        <section className={`${styles.section} ${styles.faqSection}`}>
          <SectionIntro eyebrow="A few practical questions" title="Before you get started." />
          <div className={styles.questions}>
            {featureQuestions[page.slug].map(({ question, answer }) => (
              <details key={question}>
                <summary>
                  {question}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className={styles.relatedSection} aria-labelledby="related-features-heading">
          <div className={styles.indexHeading}>
            <div>
              <p className={styles.eyebrow}>Keep the picture connected</p>
              <h2 id="related-features-heading">Where this goes next.</h2>
            </div>
            <TextLink href="/features">All features</TextLink>
          </div>
          <div className={styles.relatedGrid}>
            {relatedPages.map((related) => (
              <Link key={related.href} href={related.href}>
                <span className={styles.eyebrow}>{related.eyebrow}</span>
                <strong>
                  {isFeatureSlug(related.slug)
                    ? featureStories[related.slug].question
                    : related.title}
                </strong>
                <span>
                  {isFeatureSlug(related.slug)
                    ? featureStories[related.slug].summary
                    : related.description}
                </span>
                <span className={styles.relatedArrow} aria-hidden="true">
                  ↗
                </span>
              </Link>
            ))}
          </div>
        </section>
        <FeatureClosing />
      </div>
    </PublicPageShell>
  );
}
