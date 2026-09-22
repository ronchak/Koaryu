import Link from "next/link";
import type { ReactNode } from "react";

import { MarketingActionLink } from "@/components/marketing/marketing-primitives";
import { PublicPageShell } from "@/components/marketing/public-pages";
import { useCasePages, type MarketingPage } from "@/lib/marketing-pages";

import styles from "./workflow-pages.module.css";

const workflowStories = {
  "spreadsheets-to-studio-crm": {
    title: "Bring the roster. Leave the patchwork.",
    intro:
      "Your spreadsheet got the school this far. Move the student records into Koaryu, check the details, and give the next class a better starting point.",
    question: "Which spreadsheet has the right version?",
    answer: "Move student records into one roster, with a chance to review before you import.",
    step: "Start with your student CSV",
    action: "Plan your first import",
  },
  "student-retention": {
    title: "Notice the empty spot on the mat.",
    intro:
      "A missed week can turn into a missing student. Put attendance history, family context, and the next conversation together before the gap gets harder to explain.",
    question: "Who haven't we seen in a while?",
    answer: "Use attendance gaps to find the students who need a personal check-in.",
    step: "Review students going quiet",
    action: "Follow the attendance signal",
  },
  "trial-to-enrollment": {
    title: "A good first class deserves a next step.",
    intro:
      "Keep the inquiry, the trial, and the follow-up in the same record. When a family is ready to join, carry that context into enrollment.",
    question: "Did anyone call the trial family?",
    answer: "Give each inquiry a stage, a follow-up date, and notes for the next conversation.",
    step: "Check the due follow-ups",
    action: "Walk through the handoff",
  },
  "tuition-cleanup": {
    title: "Understand the tuition issue before the conversation.",
    intro:
      "A missing payer, an overdue invoice, and a payment made elsewhere need different responses. Koaryu helps authorized staff see which record needs attention and why.",
    question: "What actually happened with this payment?",
    answer: "Separate missing records, Stripe invoices, and payments recorded outside Koaryu.",
    step: "Identify the record that needs attention",
    action: "Sort out the next action",
  },
  "belt-test-readiness": {
    title: "A test list with a reason beside every name.",
    intro:
      "Class counts and time at rank can build a shortlist. Your instructors bring the judgment. Prepare for testing with both in view.",
    question: "Who's ready, and what are we basing that on?",
    answer: "Review the requirements and student history behind the next belt decision.",
    step: "Open the readiness shortlist",
    action: "Build the review list",
  },
} as const;

type WorkflowSlug = keyof typeof workflowStories;

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className={styles.eyebrow}>{children}</p>;
}

function Example({ children, label }: { children: ReactNode; label: string }) {
  return (
    <figure className={styles.example} aria-label={label}>
      <figcaption className={styles.exampleCaption}>
        <span>{label}</span>
        <span>Illustrative example</span>
      </figcaption>
      {children}
    </figure>
  );
}

function RosterExample() {
  return (
    <Example label="A student record, connected">
      <div className={styles.importSlip}>
        <span className={styles.fileLabel}>STUDENTS.csv</span>
        <dl className={styles.csvFields}>
          <div>
            <dt>Full name</dt>
            <dd>Alex Morgan</dd>
          </div>
          <div>
            <dt>Program</dt>
            <dd>Juniors</dd>
          </div>
          <div>
            <dt>Current belt</dt>
            <dd>Yellow</dd>
          </div>
        </dl>
      </div>
      <p className={styles.mapConnector}>
        <span aria-hidden="true">↓</span> Map columns · Review · Import
      </p>
      <div className={styles.studentSlip}>
        <div className={styles.studentIdentity}>
          <span className={styles.monogram} aria-hidden="true">
            AM
          </span>
          <div>
            <strong>Alex Morgan</strong>
            <span>Juniors · Yellow belt</span>
          </div>
        </div>
        <div className={styles.recordLinks}>
          <span>Student profile</span>
          <span>Attendance</span>
          <span>Rank history</span>
        </div>
      </div>
    </Example>
  );
}

function RetentionExample() {
  return (
    <Example label="A gap worth checking">
      <div className={styles.attendanceHeading}>
        <span>Attendance history</span>
        <strong>Last seen 14 days ago</strong>
      </div>
      <div
        className={styles.attendanceWeeks}
        aria-label="Example pattern: four attended classes, followed by four missed classes"
      >
        {[
          ["Week 1", true],
          ["Week 2", true],
          ["Week 3", false],
          ["Week 4", false],
        ].map(([week, attended]) => (
          <div key={String(week)}>
            <span>{week}</span>
            <div aria-hidden="true">
              <i className={attended ? styles.attended : styles.missed} />
              <i className={attended ? styles.attended : styles.missed} />
            </div>
          </div>
        ))}
      </div>
      <div className={styles.attendanceKey}>
        <span>
          <i className={styles.attended} /> Attended
        </span>
        <span>
          <i className={styles.missed} /> Missed
        </span>
      </div>
      <div className={styles.deskNote}>
        <span className={styles.noteLabel}>Before you reach out</span>
        <p>Check the history. Read the notes. Ask what has changed.</p>
      </div>
    </Example>
  );
}

function TrialExample() {
  return (
    <Example label="The conversation continues">
      <div className={styles.trialReceipt}>
        <div className={styles.receiptTop}>
          <span>Trial completed</span>
          <span aria-hidden="true">✓</span>
        </div>
        <h2>
          They enjoyed class.
          <br />
          Now what?
        </h2>
        <dl className={styles.receiptFields}>
          <div>
            <dt>Program interest</dt>
            <dd>Junior martial arts</dd>
          </div>
          <div>
            <dt>Family question</dt>
            <dd>Which days can we attend?</dd>
          </div>
          <div>
            <dt>Next follow-up</dt>
            <dd>Tomorrow</dd>
          </div>
        </dl>
        <div className={styles.receiptAction}>
          <span>Next conversation</span>
          <strong>Confirm the schedule and discuss joining.</strong>
        </div>
      </div>
    </Example>
  );
}

function TuitionExample() {
  return (
    <Example label="Three issues, three responses">
      <div className={styles.tuitionLedger}>
        {[
          ["01", "Payer missing", "Check the family record", "Record gap"],
          ["02", "Invoice overdue", "Review the linked invoice", "Stripe invoice"],
          ["03", "Paid by check", "Record the check payment", "External payment"],
        ].map(([number, title, detail, kind]) => (
          <div key={title}>
            <span className={styles.ledgerNumber}>{number}</span>
            <div>
              <small>{kind}</small>
              <strong>{title}</strong>
              <p>{detail}</p>
            </div>
          </div>
        ))}
      </div>
      <p className={styles.exampleFootnote}>
        Recording a payment made elsewhere does not move money.
      </p>
    </Example>
  );
}

function BeltExample() {
  return (
    <Example label="Readiness is a review">
      <div className={styles.beltSheet}>
        <div className={styles.beltHeading}>
          <span className={styles.rankSwatch} aria-hidden="true" />
          <div>
            <span>Next rank</span>
            <strong>Yellow belt review</strong>
          </div>
        </div>
        <div className={styles.readinessRow}>
          <span>Classes attended</span>
          <strong>24 / 24</strong>
          <span className={styles.readinessBar}>
            <i />
          </span>
        </div>
        <div className={styles.readinessRow}>
          <span>Time at rank</span>
          <strong>3 / 3 months</strong>
          <span className={styles.readinessBar}>
            <i />
          </span>
        </div>
        <div className={styles.approvalRow}>
          <span aria-hidden="true">◎</span>
          <div>
            <strong>Instructor review</strong>
            <span>Requirements met. Teaching judgment still needed.</span>
          </div>
        </div>
      </div>
      <p className={styles.exampleFootnote}>
        Example requirements only. Each school sets its own rank rules.
      </p>
    </Example>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className={styles.sectionHeading}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
    </div>
  );
}

function Step({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <li className={styles.step}>
      <span className={styles.stepNumber}>{number}</span>
      <div>
        <h3>{title}</h3>
        {children}
      </div>
    </li>
  );
}

function RosterWorkflow() {
  return (
    <>
      <section id="page-details" className={styles.section}>
        <SectionHeading
          eyebrow="The first import"
          title="A move you can check as you go."
          description="Bring a student-roster CSV. You don't need to solve every old spreadsheet at the same time."
        />
        <ol className={styles.steps}>
          <Step number="01" title="Choose the roster you trust most">
            <p>
              Start with the list of people who train at your school. Keep your original file as a
              reference, and export a copy as CSV.
            </p>
            <p className={styles.stepAside}>
              Useful fields: student names, contact details, guardian details, program, current
              belt, status, and notes.
            </p>
          </Step>
          <Step number="02" title="Tell Koaryu what the columns mean">
            <p>
              Map your column names to student fields. Match programs and current belts to your
              school. An unusual column can become a note instead of disappearing.
            </p>
          </Step>
          <Step number="03" title="Review before you commit">
            <p>
              Preview the records and address validation issues or duplicate warnings. Decide how to
              handle missing programs and belts before importing.
            </p>
          </Step>
          <Step number="04" title="Use the roster in the next class">
            <p>
              Check a few student profiles with your staff. Add the schedule, start recording
              attendance, and use that same roster for future rank reviews.
            </p>
          </Step>
        </ol>
      </section>
      <section className={styles.importBoundary}>
        <div className={styles.sectionInner}>
          <SectionHeading
            eyebrow="What comes with you"
            title="Move the records. Check the assumptions."
          />
          <div className={styles.boundaryColumns}>
            <div>
              <h3>Student-roster import</h3>
              <ul className={styles.bulletList}>
                <li>Names, contact information, and guardian details</li>
                <li>Program and current-belt mapping</li>
                <li>Student status, membership start date, and notes</li>
                <li>A preview so you can resolve issues before import</li>
              </ul>
            </div>
            <div>
              <h3>Handle separately</h3>
              <ul className={styles.bulletList}>
                <li>Historical payments and subscriptions</li>
                <li>Old attendance and promotion histories</li>
                <li>Processor setup and tuition collection</li>
                <li>Details that need a conversation with a family</li>
              </ul>
              <p className={styles.smallCopy}>
                The roster importer skips billing columns. Importing a current belt does not
                recreate every past promotion.
              </p>
            </div>
          </div>
        </div>
      </section>
      <section className={`${styles.section} ${styles.compactSection}`}>
        <SectionHeading
          eyebrow="After the move"
          title="Retire one duplicate list at a time."
          description="Start with the roster. Then let attendance, rank tracking, and lead follow-up use the same student context. Keep your source files until you've checked what you brought over."
        />
        <div className={styles.linkStack}>
          <Link href="/features/student-management">
            See the student record <Arrow />
          </Link>
          <Link href="/features/attendance">
            See how attendance uses it <Arrow />
          </Link>
        </div>
      </section>
    </>
  );
}

function RetentionWorkflow() {
  return (
    <>
      <section id="page-details" className={styles.section}>
        <SectionHeading
          eyebrow="The daily check"
          title="The gap is a signal. The reason needs a person."
          description="Koaryu highlights students who haven't attended in 14 or more days. Use that list to start a review, then bring what you know about the student."
        />
        <ol className={styles.steps}>
          <Step number="01" title="Open the attendance gap">
            <p>
              Review the students going quiet from the dashboard. Read the attendance history before
              deciding whether the pattern needs attention.
            </p>
          </Step>
          <Step number="02" title="Put the absence in context">
            <p>
              Check the student&apos;s status, program, notes, and guardian contact. A planned break
              calls for a different conversation than a family you&apos;ve lost touch with.
            </p>
          </Step>
          <Step number="03" title="Make a personal check-in">
            <p>
              Contact the student or guardian through your usual channel. Ask about the gap, agree
              on a useful next step, and save the relevant context in their notes.
            </p>
            <p className={styles.stepAside}>
              The queue helps you notice. Your staff decides when to reach out and what to say.
            </p>
          </Step>
        </ol>
      </section>
      <section className={styles.retentionBand}>
        <div className={styles.sectionInner}>
          <SectionHeading
            eyebrow="A conversation with context"
            title="Ask a better first question."
          />
          <div className={styles.conversation}>
            <p className={styles.conversationPrompt}>An example check-in</p>
            <blockquote>
              &quot;We haven&apos;t seen Alex in a couple of weeks. Is the class schedule still
              working for your family?&quot;
            </blockquote>
            <p>
              A useful next step might be a different class time, a return date, or simply knowing
              the family is away. The attendance gap alone cannot tell you which.
            </p>
          </div>
        </div>
      </section>
      <section className={styles.section}>
        <SectionHeading
          eyebrow="Read the rest of the story"
          title="Attendance is where you start."
        />
        <div className={styles.contextList}>
          <article>
            <span aria-hidden="true">01</span>
            <div>
              <h3>A trial waiting for a reply</h3>
              <p>
                Review dated lead follow-ups separately. A family can be interested and still need
                one clear conversation to choose their next class.
              </p>
              <Link href="/use-cases/trial-to-enrollment">
                Follow the trial handoff <Arrow />
              </Link>
            </div>
          </article>
          <article>
            <span aria-hidden="true">02</span>
            <div>
              <h3>A milestone that needs attention</h3>
              <p>
                Readiness requirements and promotion history give an instructor context for
                discussing progress. Meeting a count does not promise a promotion.
              </p>
              <Link href="/use-cases/belt-test-readiness">
                Prepare the readiness review <Arrow />
              </Link>
            </div>
          </article>
          <article>
            <span aria-hidden="true">03</span>
            <div>
              <h3>A payment question left unresolved</h3>
              <p>
                Authorized staff can check the family&apos;s existing billing records before
                starting a tuition conversation.
              </p>
              <Link href="/use-cases/tuition-cleanup">
                Understand tuition attention <Arrow />
              </Link>
            </div>
          </article>
        </div>
      </section>
    </>
  );
}

function TrialWorkflow() {
  const stages = [
    {
      title: "Inquiry",
      question: "What brought them here?",
      body: "Record the lead source, program interest, contact details, and what the family wants from training. Set the next follow-up date while the conversation is fresh.",
    },
    {
      title: "Trial scheduled",
      question: "What should staff know before class?",
      body: "Keep the trial date and useful notes with the lead. A question about confidence, age group, or schedule should reach the person welcoming the family.",
    },
    {
      title: "Trial completed",
      question: "What happened in the room?",
      body: "Record how the trial went and what still needs an answer. Give the next conversation a date so it appears in the follow-up queue.",
    },
    {
      title: "Offer sent",
      question: "What is holding up the decision?",
      body: "Keep the enrollment conversation visible while the family decides. Update the notes and next follow-up instead of treating an unanswered offer as a finished task.",
    },
    {
      title: "Enrolled",
      question: "What should the student record carry forward?",
      body: "When the family joins, authorized staff can convert the lead into a student. Contact details, program context, and notes support the handoff into the roster.",
    },
  ];
  return (
    <>
      <section id="page-details" className={styles.trialSection}>
        <SectionHeading
          eyebrow="Five stages. One conversation."
          title="Know the next question to ask."
          description="The lead pipeline shows where each family is. A follow-up date tells you when the next conversation is due."
        />
        <ol className={styles.trialStages}>
          {stages.map((stage, index) => (
            <li key={stage.title}>
              <span className={styles.stageNumber}>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <p className={styles.stageLabel}>{stage.title}</p>
                <h3>{stage.question}</h3>
                <p>{stage.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className={styles.trialHandoff}>
        <div className={styles.sectionInner}>
          <SectionHeading
            eyebrow="Before the next class"
            title="A short list beats a long memory."
          />
          <div>
            <p className={styles.featureCopy}>
              The follow-up queue separates due and overdue conversations. Open the lead, read the
              notes, and record what you learn after you contact the family.
            </p>
            <div className={styles.handoffNotes}>
              <h3>If the answer is &quot;not now&quot;</h3>
              <p>
                Record the reason when closing a lead, such as timing, no response, or a no-show. A
                truthful status is more useful than leaving every family in the active pipeline.
              </p>
            </div>
            <p className={styles.smallCopy}>
              Pipeline stages organize your work. Staff still handles the conversation; moving a
              lead to &quot;Offer sent&quot; is not a promise of an automated message.
            </p>
          </div>
        </div>
      </section>
      <section className={`${styles.section} ${styles.compactSection}`}>
        <SectionHeading
          eyebrow="Once they join"
          title="Start with what you already know."
          description="Review the new student profile, guardian details, and program. Enrollment and tuition setup are separate steps, so confirm the studio's billing availability before activating payments."
        />
        <div className={styles.linkStack}>
          <Link href="/features/student-management">
            See the student CRM <Arrow />
          </Link>
          <Link href="/features/billing">
            Understand billing availability <Arrow />
          </Link>
        </div>
      </section>
    </>
  );
}

function TuitionWorkflow() {
  return (
    <>
      <section id="page-details" className={styles.tuitionSection}>
        <SectionHeading
          eyebrow="Start with the record"
          title="Same queue. Different next steps."
          description="Read the student and payer context first. Then choose the path that matches the issue, instead of assuming every alert calls for another charge."
        />
        <div className={styles.tuitionPaths}>
          <article>
            <span className={styles.pathNumber}>01 / A record is missing</span>
            <h3>Find the gap.</h3>
            <p>
              Check the student&apos;s billing assignment and payer context. Confirm who is
              responsible and how the family pays.
            </p>
            <div className={styles.pathDecision}>
              <strong>Useful next action</strong>
              <p>
                Where appropriate, attach an external-only local billing record. This records the
                arrangement without creating a Stripe subscription.
              </p>
            </div>
          </article>
          <article>
            <span className={styles.pathNumber}>02 / An invoice needs attention</span>
            <h3>Check the Stripe invoice.</h3>
            <p>
              Read the existing invoice and its payment status alongside the family record. An
              overdue or failed status is a reason to investigate.
            </p>
            <div className={styles.pathDecision}>
              <strong>Useful next action</strong>
              <p>
                When available to your role and studio, refresh an existing Stripe-linked invoice
                from Stripe to update the Koaryu record.
              </p>
            </div>
          </article>
          <article>
            <span className={styles.pathNumber}>03 / The family paid elsewhere</span>
            <h3>Record what happened.</h3>
            <p>
              A cash, check, Zelle, Venmo, or other external payment needs a clear record of what
              was paid and how.
            </p>
            <div className={styles.pathDecision}>
              <strong>Useful next action</strong>
              <p>
                Authorized staff can record the payment against the payer. Koaryu keeps a record of
                the payment made elsewhere; it does not transfer money.
              </p>
            </div>
          </article>
        </div>
      </section>
      <section className={styles.billingBoundary}>
        <div className={styles.sectionInner}>
          <SectionHeading
            eyebrow="Before you activate payments"
            title="Visibility and collection have different requirements."
          />
          <div>
            <p className={styles.featureCopy}>
              Tuition collection is not generally available without separate activation for the
              exact studio. Available Stripe actions depend on the staff member&apos;s role and what
              has been activated for the studio.
            </p>
            <ul className={styles.bulletList}>
              <li>Review existing records and identify what needs attention.</li>
              <li>Confirm studio activation before promising payment collection.</li>
              <li>Keep records of external payments distinct from Stripe transactions.</li>
            </ul>
            <Link href="/features/billing" className={styles.lightLink}>
              Read the billing scope <Arrow />
            </Link>
          </div>
        </div>
      </section>
      <section className={`${styles.section} ${styles.compactSection}`}>
        <SectionHeading
          eyebrow="At the front desk"
          title="One conversation, with the right context."
          description="Keep student, guardian, payer, and invoice information connected. Authorized staff should be able to explain the record before asking a family to act on it."
        />
        <div className={styles.deskNote}>
          <span className={styles.noteLabel}>A useful check before you call</span>
          <p>
            Who is the payer? Which record needs attention? Has a payment already happened
            elsewhere?
          </p>
        </div>
      </section>
    </>
  );
}

function BeltWorkflow() {
  return (
    <>
      <section id="page-details" className={styles.section}>
        <SectionHeading
          eyebrow="Before the test list"
          title="Make your school's requirements visible."
          description="Ordered rank ladders can use class-count, time-at-rank, and instructor-approval requirements. Review the rules for the student's program before relying on the shortlist."
        />
        <div className={styles.requirements}>
          <article>
            <span className={styles.requirementSymbol} aria-hidden="true">
              24
            </span>
            <h3>Classes at rank</h3>
            <p>
              Compare recorded attendance with the class requirement for the next rank. Check
              missing or incorrect attendance before making the decision.
            </p>
          </article>
          <article>
            <span className={styles.requirementSymbol} aria-hidden="true">
              3m
            </span>
            <h3>Time at rank</h3>
            <p>
              Review time against the configured requirement. The recorded rank history gives that
              waiting period its starting point.
            </p>
          </article>
          <article>
            <span className={styles.requirementSymbol} aria-hidden="true">
              ◎
            </span>
            <h3>Instructor approval</h3>
            <p>
              Where required, keep approval as a separate part of the review. Technical readiness,
              confidence, and judgment belong to the instructor.
            </p>
          </article>
        </div>
      </section>
      <section className={styles.beltDecision}>
        <div className={styles.sectionInner}>
          <div>
            <Eyebrow>The teaching decision</Eyebrow>
            <h2>Meeting the numbers earns a review.</h2>
            <p>It does not award a belt.</p>
          </div>
          <div className={styles.decisionCopy}>
            <p>
              Koaryu shows the requirements and the student&apos;s history. Instructors decide
              whether the student is ready to test or needs more time.
            </p>
            <p>
              For a student who needs more time, record a useful note about what to work on. The
              next review can start from that conversation.
            </p>
          </div>
        </div>
      </section>
      <section className={styles.section}>
        <SectionHeading
          eyebrow="After the review"
          title="Leave a record for the next instructor."
        />
        <ol className={styles.steps}>
          <Step number="01" title="Review the shortlist together">
            <p>
              Look at the current rank, attendance, time, and any approval requirement. Discuss the
              students whose history needs a closer look before planning the test.
            </p>
          </Step>
          <Step number="02" title="Record the promotion after the decision">
            <p>
              When a student earns the next rank, record the change and date. The student profile
              keeps that promotion history.
            </p>
          </Step>
          <Step number="03" title="Let the next period build on it">
            <p>
              Keep recording attendance against the same student record. The next readiness review
              has the new rank and its history to work from.
            </p>
          </Step>
        </ol>
      </section>
    </>
  );
}

const workflowViews: Record<WorkflowSlug, { Example: () => ReactNode; Body: () => ReactNode }> = {
  "spreadsheets-to-studio-crm": { Example: RosterExample, Body: RosterWorkflow },
  "student-retention": { Example: RetentionExample, Body: RetentionWorkflow },
  "trial-to-enrollment": { Example: TrialExample, Body: TrialWorkflow },
  "tuition-cleanup": { Example: TuitionExample, Body: TuitionWorkflow },
  "belt-test-readiness": { Example: BeltExample, Body: BeltWorkflow },
};

function WorkflowNextSteps({ pages }: { pages: MarketingPage[] }) {
  return (
    <section className={styles.nextSteps}>
      <div className={styles.nextHeading}>
        <Eyebrow>See the tools behind the workflow</Eyebrow>
        <h2>Keep exploring.</h2>
      </div>
      <ul className={styles.relatedLinks}>
        {pages.map((page) => (
          <li key={page.href}>
            <Link href={page.href}>
              <span>
                <strong>{page.eyebrow}</strong>
                <span>{page.description}</span>
              </span>
              <Arrow />
            </Link>
          </li>
        ))}
      </ul>
      <div className={styles.closing}>
        <div>
          <h3>Start with your school.</h3>
          <p>Build the roster, then work through the next task that needs attention.</p>
        </div>
        <MarketingActionLink href="/signup" prefetch={false} className={styles.action}>
          Start setup
        </MarketingActionLink>
      </div>
    </section>
  );
}

export function WorkflowDetailPage({
  page,
  relatedPages,
}: {
  page: MarketingPage;
  relatedPages: MarketingPage[];
}) {
  const slug = page.slug as WorkflowSlug;
  const story = workflowStories[slug];
  const view = workflowViews[slug];
  if (!story || !view) return null;
  const { Example: StoryExample, Body } = view;

  return (
    <PublicPageShell>
      <div className={styles.workflow} data-workflow={slug}>
        <section className={styles.detailHero}>
          <div className={styles.heroCopy}>
            <Link href="/use-cases" className={styles.backLink}>
              <span aria-hidden="true">←</span> All studio workflows
            </Link>
            <Eyebrow>{page.eyebrow}</Eyebrow>
            <h1>{story.title}</h1>
            <p className={styles.lede}>{story.intro}</p>
            <a href="#page-details" className={styles.textAction}>
              {story.action}
              <span aria-hidden="true">↓</span>
            </a>
          </div>
          <StoryExample />
        </section>
        <Body />
        <WorkflowNextSteps pages={relatedPages} />
      </div>
    </PublicPageShell>
  );
}

export function WorkflowIndexPage() {
  return (
    <PublicPageShell>
      <div className={styles.workflow}>
        <section className={styles.indexHero}>
          <div>
            <Eyebrow>Studio workflows</Eyebrow>
            <h1>Start with the thing on your mind.</h1>
            <p className={styles.lede}>
              The roster is scattered. A student has gone quiet. A trial family needs a call. See
              how Koaryu helps you work through the ordinary things that keep a school running.
            </p>
            <a href="#workflows" className={styles.textAction}>
              Find your workflow<span aria-hidden="true">↓</span>
            </a>
          </div>
          <div className={styles.indexNote}>
            <span className={styles.noteLabel}>Before the doors open</span>
            <p>
              One record.
              <br />
              One next step.
              <br />
              <em>Back to class.</em>
            </p>
            <span>Five practical guides for the person running the school.</span>
          </div>
        </section>
        <section
          id="workflows"
          className={styles.workflowDirectory}
          aria-labelledby="workflow-heading"
        >
          <div className={styles.directoryHeading}>
            <Eyebrow>Where to begin</Eyebrow>
            <h2 id="workflow-heading">Which question sounds familiar?</h2>
          </div>
          <ol>
            {useCasePages.map((page, index) => {
              const story = workflowStories[page.slug as WorkflowSlug];
              return (
                <li key={page.slug}>
                  <Link href={page.href} className={styles.directoryLink}>
                    <span className={styles.directoryNumber}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className={styles.directoryMain}>
                      <span className={styles.directoryLabel}>{page.eyebrow}</span>
                      <h3>{story.question}</h3>
                      <p>{story.answer}</p>
                    </div>
                    <div className={styles.directoryStart}>
                      <span>First step</span>
                      <strong>{story.step}</strong>
                      <span className={styles.directoryAction}>
                        Read the workflow <Arrow />
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ol>
        </section>
        <section className={styles.indexConnection}>
          <div className={styles.sectionInner}>
            <SectionHeading
              eyebrow="The work connects"
              title="Solve the next problem with the same records."
            />
            <div>
              <p className={styles.featureCopy}>
                The roster you import becomes the roster you take attendance against. Attendance
                gives retention and rank reviews their history. A trial that becomes an enrolled
                student joins that same record system.
              </p>
              <p className={styles.smallCopy}>
                Each guide shows a practical starting point, what staff still decides, and where
                product availability matters.
              </p>
              <div className={styles.indexActions}>
                <MarketingActionLink href="/features" className={styles.action}>
                  Explore the features
                </MarketingActionLink>
                <Link href="/studio-types/family-martial-arts-schools">
                  Running a family school? <Arrow />
                </Link>
              </div>
            </div>
          </div>
        </section>
      </div>
    </PublicPageShell>
  );
}
