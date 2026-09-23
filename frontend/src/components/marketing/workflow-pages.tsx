import Link from "next/link";
import type { ReactNode } from "react";

import { PublicPageShell } from "@/components/marketing/public-pages";
import { useCasePages, type MarketingPage } from "@/lib/marketing-pages";

import styles from "./workflow-pages.module.css";

const guides = {
  "spreadsheets-to-studio-crm": {
    title: "Prepare a student roster for CSV import",
    intro:
      "In Koaryu, open Students and choose Import CSV. Upload your file, map its columns, and review the rows before importing. Use the sample below to prepare that file. Keep your old attendance, promotion history, and billing records separately.",
    link: "Prepare a roster import",
    ready: "Your student CSV and the program and belt names used by your school.",
    output: "A checked column mapping, a sample CSV, and a way to verify the import result.",
  },
  "student-retention": {
    title: "Review an attendance gap before contacting a family",
    intro:
      "Open the dashboard item for students going quiet to reach the filtered Students list. A student can appear there because they stopped coming, took a planned break, or attended a class nobody marked. Check which explanation fits before you send a message.",
    link: "Review an attendance gap",
    ready: "Attendance history, student status, any hold dates, and the family contact.",
    output:
      "A decision to contact, correct attendance, or check a planned break, plus wording you can use.",
  },
  "trial-to-enrollment": {
    title: "Follow up with a trial family and create their student record",
    intro:
      "Open Leads and choose Add lead for a new inquiry, or select an existing lead to open its details. Admin and Front Desk can assign it, change its stage, schedule a follow-up, and convert it to a student. This example follows the actions and resulting records.",
    link: "Follow up on a trial inquiry",
    ready: "The lead's contact details, selected program, stage, and follow-up date.",
    output: "A supported follow-up action and a field-by-field check after conversion.",
  },
  "tuition-cleanup": {
    title: "Choose the right action for a tuition record",
    intro:
      "Start with the student, the payer, and the evidence of what happened. A missing billing enrollment, a stale Stripe invoice, and a check received at the desk need different actions.",
    link: "Check a tuition problem",
    ready: "Student and payer names, the invoice if there is one, and any payment evidence.",
    output: "The record to change, the expected result, and anything that still needs resolving.",
  },
  "belt-test-readiness": {
    title: "Prepare a belt-test shortlist with reasons",
    intro:
      "Open Belt Tracker, select the program, and choose Eligibility. Compare the class counts and time at rank with the next rank's requirements. Keep a reason beside each student's name so instructors can distinguish a teaching decision from missing or uncertain records.",
    link: "Prepare a belt-test review",
    ready: "The program's rank ladder, qualifying attendance, and each student's rank history.",
    output: "A shortlist marked for instructor review, more classes, or a history check.",
  },
} as const;

type WorkflowSlug = keyof typeof guides;

function GuideTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: ReactNode[][];
}) {
  return (
    <table className={styles.table} role="table">
      <caption>{caption}</caption>
      <thead role="rowgroup">
        <tr role="row">
          {columns.map((column) => (
            <th scope="col" key={column} role="columnheader">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody role="rowgroup">
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex} role="row">
            {row.map((cell, cellIndex) => (
              <td key={columns[cellIndex]} role="cell">
                <span className={styles.cellLabel} aria-hidden="true">
                  {columns[cellIndex]}
                </span>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RosterGuide() {
  return (
    <>
      <section className={styles.section} aria-labelledby="sample-heading">
        <h2 id="sample-heading">A two-student file you can adapt</h2>
        <p>
          These are fictional records. Replace them with your own students before importing. For the
          results shown here, the school already has a Juniors program with White and Yellow ranks
          in its ladder. Use each student&#39;s confirmed date of birth, and match your program and
          belt names before reviewing your own file.
        </p>
        <a
          className={styles.download}
          href="/marketing/resources/student-roster-example.csv"
          download="koaryu-student-roster-example.csv"
        >
          Download the sample CSV
          <span aria-hidden="true">↓</span>
        </a>
        <GuideTable
          caption="How to map the sample's columns"
          columns={["CSV column and example", "Choose in Koaryu", "Result to check"]}
          rows={[
            [
              "First Name: Alex / Last Name: Morgan",
              "First Name / Last Name",
              "Alex Morgan has separate first and last names.",
            ],
            [
              "Date of Birth: 2016-06-15 for Alex / 2017-03-08 for Sam",
              "Date of Birth",
              "Both example students are under 18 in September 2026. Koaryu derives minor status from this date, so their profiles can display Primary guardian.",
            ],
            [
              "Guardian Name: Jordan Morgan / Guardian Email: jordan@example.com",
              "Guardian Name / Guardian Email",
              "Jordan is linked as Alex's guardian. This does not create a tuition payer.",
            ],
            [
              "Program: Juniors / Current Belt: Yellow",
              "Program / Current Belt",
              "Alex joins Juniors with its matching Yellow rank. No earlier promotions are created.",
            ],
            [
              "Status: Active or Trial",
              "Status",
              "With status normalization enabled, Active becomes active and Trial becomes trialing. This is the student's roster status.",
            ],
            [
              "Membership Start Date: 2026-06-01",
              "Membership Start Date",
              "The student's start date is June 1, 2026. This is not the date they earned Yellow.",
            ],
            [
              "Schedule note / Office note",
              "Map both columns to Notes",
              "Alex's notes contain 'Schedule note: Tuesday classes' and 'Office note: Prefers email'. The column labels stay with the text.",
            ],
            [
              "Tuition balance: 150",
              "Skip this column",
              "No balance, invoice, payment, or billing enrollment is created.",
            ],
          ]}
        />
      </section>

      <section className={styles.section} aria-labelledby="mapping-heading">
        <h2 id="mapping-heading">Fix the mapping before you import</h2>
        <p>
          First Name and Last Name must be mapped. A Full Name column can supply both, but check how
          compound names split in the preview. Other supported fields include date of birth,
          preferred name, student contact details, address, tags, emergency contact, and guardian
          phone and relation.
        </p>
        <p>
          Only Notes can receive more than one column. If two columns map to another field, choose
          one and skip the other. Leave payment columns unmapped. A column called Payment Status
          cannot stand in for the student&#39;s Status, and an unfamiliar billing header may need
          you to skip it manually.
        </p>
        <GuideTable
          caption="What a preview result means"
          columns={["What you see", "What to do"]}
          rows={[
            [
              "Missing last name or invalid date",
              "Correct that row in the source file, then review it again. A column mapping alone cannot fill a missing value.",
            ],
            [
              "Program cannot be matched",
              "Use the existing program's name, set it up first, or review the option to create missing programs if available. Do not assume the row will join the intended program.",
            ],
            [
              "Current belt cannot be matched",
              "The default keeps the unmatched belt text in Notes, for example 'Imported current belt (unresolved): Yellow'. A configured program starts the student at its first full belt; without one, the student remains unranked. Review any offered belt-setup option if you want to create the missing rank instead.",
            ],
            [
              "8 valid rows and 2 rows with blockers",
              "Import 8 students imports those valid rows and skips the two blocked rows. To keep the roster together, fix the blockers before importing. Otherwise, identify the skipped rows and later import only those corrected students.",
            ],
          ]}
        />
      </section>

      <section className={styles.section} aria-labelledby="retry-heading">
        <h2 id="retry-heading">A retry is different from an updated roster</h2>
        <p>
          If the connection drops during import, retry with the exact file, mapping, and options.
          Koaryu recognizes that import attempt and avoids creating its completed rows again.
          Editing and importing the full roster is a new import. The importer does not find existing
          people by name or email, merge their records, or update them in place.
        </p>
        <h3>Check the result before retiring the spreadsheet</h3>
        <ul className={styles.checklist}>
          <li>
            Compare the imported count with the number you intended to add. Keep a list of every
            blocked row.
          </li>
          <li>Open a student and verify the program, status, start date, and combined notes.</li>
          <li>
            For a child, choose Edit and check Date of birth in Basic Info. On the profile, check
            the Minor indicator and Primary guardian. Without a birth date, Primary guardian will
            not appear; inspect the linked contact under Edit, then Guardian.
          </li>
          <li>
            Check a matched belt and, if present, a student whose belt could not be matched. A
            default starting belt may differ from the belt in your spreadsheet. Resolve that
            assignment before using it for rank review.
          </li>
          <li>
            Keep the source spreadsheet and historical records. The CSV does not reconstruct
            attendance, promotions, or tuition history.
          </li>
        </ul>
        <Link className={styles.referenceLink} href="/features/student-management">
          See what a student profile contains <span aria-hidden="true">→</span>
        </Link>
      </section>
    </>
  );
}

function RetentionGuide() {
  return (
    <>
      <section className={styles.section} aria-labelledby="gap-heading">
        <h2 id="gap-heading">Four gaps that need different responses</h2>
        <GuideTable
          caption="Fictional review examples, not a live student list"
          columns={["Recorded facts", "Check first", "Staff decision"]}
          rows={[
            [
              "Alex is active. The last recorded visit was 16 days ago, with no known break.",
              "Read the profile notes, confirm recent classes were marked, and check the guardian contact.",
              "Send a personal check-in. Ask about the absence without guessing its cause.",
            ],
            [
              "Sam's family says they are traveling through September 28.",
              "Check whether a hold is already recorded and confirm the return plan with the family.",
              "Ask Admin or Front Desk to record the agreed hold dates if needed. An existing current hold removes Sam from the inactivity watch.",
            ],
            [
              "An instructor remembers Lee in Tuesday's class, but the session has no check-in for Lee.",
              "Open that dated session and confirm Lee attended it.",
              "Correct attendance before contacting the family about an absence. A missing record does not establish a missed class.",
            ],
            [
              "Robin was imported today as active, with a membership start six months ago and no attendance history.",
              "Ask staff when Robin last attended and check the old attendance source.",
              "Establish the attendance history first. Importing the roster did not bring past check-ins with it.",
            ],
          ]}
        />
      </section>
      <section className={styles.section} aria-labelledby="inactivity-heading">
        <h2 id="inactivity-heading">What the 14-day watch actually measures</h2>
        <p>
          The dashboard watch includes active and trialing students who have reached 14 days without
          recorded attendance. It excludes paused students and students on a current hold. It looks
          for the most recent attendance entry that isn&#39;t Absent within the last 90 days. If
          there isn&#39;t one, it uses the membership start date, then the record&#39;s creation
          date if no start date exists.
        </p>
        <p>
          To check the visits, open Schedule, navigate to the relevant dates, and select each class
          session to inspect its roster. Open the student in Students for contact details, hold
          dates, and Notes.
        </p>
        <p>
          The watch does not count how many scheduled classes the student missed. For an imported
          student, an old membership date can trigger the watch immediately even if they trained
          yesterday. Review the actual check-ins and ask the instructor before treating the gap as a
          reason to contact the family.
        </p>
        <Link className={styles.referenceLink} href="/features/attendance">
          See how attendance is saved and corrected <span aria-hidden="true">→</span>
        </Link>
      </section>
      <section className={styles.section} aria-labelledby="outreach-heading">
        <h2 id="outreach-heading">Two messages you can adapt</h2>
        <p>
          Once you&#39;ve checked the records, send the message through your usual email, phone, or
          messaging channel.
        </p>
        <div className={styles.messagePair}>
          <div>
            <h3>When the attendance record is complete</h3>
            <blockquote>
              Hi [guardian], we haven&#39;t recorded a visit for [student] since [date]. Has the
              class schedule changed for you? If you plan to return, which class should we expect
              you at?
            </blockquote>
          </div>
          <div>
            <h3>When recent check-ins may be missing</h3>
            <blockquote>
              Hi [guardian], I&#39;m checking our attendance records for [student]. Do you remember
              their most recent class, and are they planning to come this week?
            </blockquote>
          </div>
        </div>
        <h3>Save the answer in the student&#39;s Notes</h3>
        <p>
          Open the student&#39;s edit form and add the response without removing useful existing
          notes. Record what the family said and the agreed action. For example:
        </p>
        <blockquote>
          September 22: Jordan confirmed Alex has been away visiting family. Plans to return to
          Juniors on September 29. Front Desk to confirm the hold ends September 28.
        </blockquote>
        <p>
          Admin and Front Desk can manage hold dates. If the family is undecided, keep the agreed
          check-in date in Notes and your staff reminder system. A student note does not create a
          dated follow-up task or send a message.
        </p>
      </section>
    </>
  );
}

function TrialGuide() {
  return (
    <>
      <section className={styles.section} aria-labelledby="handoff-heading">
        <h2 id="handoff-heading">One inquiry from Tuesday to Monday</h2>
        <p className={styles.sampleLabel}>Fictional staff plan for September 2026</p>
        <ol className={styles.timeline}>
          <li>
            <span className={styles.date}>Tuesday, September 22</span>
            <h3>Add Alex&#39;s inquiry</h3>
            <p>
              Select Juniors as the program, mark Alex as a minor, enter guardian Jordan&#39;s name
              and contact details, and assign a staff member. Set Follow-up date to September 24.
              Initial Notes can say, &quot;Jordan asked whether Tuesday classes fit Alex&#39;s
              schedule.&quot; Check these details before saving; the lead inspector has no editor
              for them.
            </p>
          </li>
          <li>
            <span className={styles.date}>Thursday, September 24</span>
            <h3>Contact the family, then record the action</h3>
            <p>
              The follow-up is due today; it becomes overdue if left for a later day. Staff call
              Jordan outside Koaryu. Jordan is still deciding, so choose Mark contacted. That clears
              September 24 from the lead&#39;s follow-up date and adds a generic contact entry to
              its activity trail. The saved status reads &quot;No follow-up scheduled&quot;, even if
              the date input still displays the previous date. It does not save a transcript or a
              new note.
            </p>
          </li>
          <li>
            <span className={styles.date}>After Thursday&#39;s call</span>
            <h3>Give the pending inquiry another date</h3>
            <p>
              Explicitly enter September 28 in Follow-up date and choose Reschedule. Confirm that
              the new date appears on the lead. If you change the date before Mark contacted, that
              action clears it again. Keep detailed call notes in your staff&#39;s existing record
              while the lead inspector has no notes editor.
            </p>
          </li>
          <li>
            <span className={styles.date}>Monday, September 28</span>
            <h3>Convert only after the family agrees</h3>
            <p>
              When Jordan confirms enrollment, choose Convert to student. Koaryu opens Alex&#39;s
              new profile. Check the program, student contact, and initial notes. Choose Edit, then
              Guardian, to verify Jordan&#39;s linked contact details. If Jordan declines because
              the schedule won&#39;t work, use Mark lost with Timing instead. Other reasons are
              No-show, Price objection, No response, and Other.
            </p>
          </li>
        </ol>
      </section>
      <section className={styles.section} aria-labelledby="lead-fields-heading">
        <h2 id="lead-fields-heading">What staff can record</h2>
        <GuideTable
          caption="Fields at creation and actions after saving"
          columns={["When", "Available fields or actions", "Boundary"]}
          rows={[
            [
              "Add new lead",
              "First and last name, email, phone, source, program, minor and guardian details, assigned staff, follow-up date, and initial Notes.",
              "The inspector displays the saved identity, contact, source, program, guardian details, and notes, but has no edit controls for those fields.",
            ],
            [
              "After creation",
              "Change Stage or Assigned staff; set a Follow-up date with Reschedule; Mark contacted; Mark lost; Convert to student.",
              "Mark contacted clears the follow-up date. The adjacent Move to stage action also marks contact and clears the date. Reschedule afterward if a follow-up is still needed.",
            ],
          ]}
        />
        <h3>Stages describe progress</h3>
        <p>
          The stages are Inquiry, Trial Scheduled, Trial Completed, Offer Sent, and Enrolled. Trial
          Scheduled does not book a class. There is no separate trial-date field; keep the booking
          in your scheduling process. Offer Sent does not send an offer. Changing to Enrolled
          performs the student conversion. Closed Lost records a declined or ended inquiry with a
          reason.
        </p>
      </section>
      <section className={styles.section} aria-labelledby="conversion-heading">
        <h2 id="conversion-heading">Check what arrived in the student profile</h2>
        <GuideTable
          caption="The result of the example's September 28 conversion"
          columns={["Lead information", "Student result"]}
          rows={[
            [
              "Alex's name, email, and phone",
              "Copied to the new student. Guardian contact details remain separate; they do not replace Alex's contact fields.",
            ],
            [
              "Selected Juniors program",
              "Used for the student's program. In this example Juniors is an active program selected when the lead was created.",
            ],
            [
              "Minor selected and guardian name Jordan Morgan entered",
              "Creates a linked guardian with the supplied guardian email and phone. Both the minor flag and a guardian name are needed. Verify the contact under Edit, then Guardian; the lead does not supply a date of birth for the student's minor status.",
            ],
            [
              "Initial Notes",
              "Copied to student Notes. The lead's activity timeline is not copied into that field.",
            ],
            [
              "Convert to student on September 28",
              "Creates an active student with September 28 as the membership start date in the studio's timezone. The lead becomes Enrolled and its follow-up date clears.",
            ],
          ]}
        />
        <h3>Add the child&#39;s confirmed date of birth</h3>
        <p>
          In Students, open the new student and choose Edit. Guardian shows the linked contact for
          reference, even when it is not visible on the main profile. Those guardian fields cannot
          be changed in this form. Open Basic Info, enter the child&#39;s confirmed Date of birth,
          and choose Save changes. The student profile derives minor status from that date and shows
          Primary guardian for students under 18.
        </p>
        <p>
          Conversion creates the student record. It does not attach tuition, start a subscription,
          or charge the family. Admin and Front Desk can manage and convert leads; Instructors
          cannot perform those actions.
        </p>
        <Link className={styles.referenceLink} href="/features/billing">
          Check tuition setup and billing availability <span aria-hidden="true">→</span>
        </Link>
      </section>
    </>
  );
}

function TuitionGuide() {
  return (
    <>
      <p className={styles.scopeNote}>
        Admin and Front Desk can review billing records, attach external billing enrollments, record
        external payments, and refresh eligible existing Stripe invoices. Instructors cannot access
        billing. Tuition collection requires separate activation for your studio and is not
        generally available. New billing exports are unavailable.
      </p>
      <section className={styles.section} aria-labelledby="billing-cases-heading">
        <h2 id="billing-cases-heading">Match the case to the record</h2>
        <div className={styles.cases}>
          <section>
            <h3>The student has no external billing enrollment</h3>
            <p>
              Open Billing, then Student Billing. Confirm the arrangement, student, existing plan,
              and payer. In Attach external student billing, choose the Student and Plan, select the
              existing Payer when appropriate, and enter the Start, End, and Next bill dates that
              apply. Choose Attach.
            </p>
            <p>
              Check that the enrollment appears with the right student and plan. This creates a
              record only. It does not create a Stripe subscription, collect payment, or change the
              student&#39;s training status.
            </p>
          </section>
          <section>
            <h3>The payer is missing</h3>
            <p>
              Open Billing, then Families, and check for an existing payer under the adult&#39;s
              name and confirm who is responsible for payment. A guardian record alone is not a
              payer. The Attach form can leave Payer blank, but that does not create or recover the
              missing payer.
            </p>
            <p>
              Stop before recording an external payment, which requires a payer. Have the studio
              Admin resolve the payer setup available for the studio. Family setup and collection
              actions depend on activation; this form cannot supply a missing payer account.
            </p>
          </section>
          <section>
            <h3>A Stripe invoice looks stale or overdue</h3>
            <p>
              Open Billing, then Invoices. Confirm that it is the intended invoice and compare its
              status with the linked Stripe record. When Reconcile is available on that existing
              invoice, use it to refresh Koaryu&#39;s status from Stripe. An external invoice has no
              Stripe status to refresh.
            </p>
            <p>
              Read the refreshed result. If it still says open or overdue, the invoice still needs
              attention. Reconcile does not attempt a charge. Resolve payment with the person who
              manages the studio&#39;s Stripe billing before promising that the balance is cleared.
            </p>
          </section>
          <section>
            <h3>The family paid outside Stripe</h3>
            <p>
              Open Billing, then Advanced. Confirm the payment evidence, payer, amount, and method,
              then use Record external payment. Check for an existing record first so the same check
              or transfer isn&#39;t recorded twice. The example below shows exactly what to enter
              and what it changes.
            </p>
          </section>
        </div>
      </section>
      <section className={styles.section} aria-labelledby="check-heading">
        <h2 id="check-heading">A $150 check will not close a Stripe invoice</h2>
        <p>
          In this fictional example, Jordan Morgan paid $150 USD by check on September 21. Staff
          verified check 1042 and are recording it on September 22. Jordan is already a payer in
          Koaryu.
        </p>
        <dl className={styles.paymentFields}>
          <div>
            <dt>Payer</dt>
            <dd>Jordan Morgan</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>150.00, recorded in USD</dd>
          </div>
          <div>
            <dt>Method</dt>
            <dd>Check</dd>
          </div>
          <div>
            <dt>Note</dt>
            <dd>Check 1042 received September 21 for Alex&#39;s September tuition.</dd>
          </div>
        </dl>
        <p>
          Choose Record. The result is a payment attached to Jordan as payer, with the amount,
          method, note, and the time it was recorded. There is no payment-date field. September 21
          in the note is text; it does not backdate the payment record.
        </p>
        <p>
          This entry does not move money or settle, reduce, or update a Stripe invoice. If
          Alex&#39;s September invoice is still open in Stripe, the person managing Stripe must
          resolve that invoice separately. Refresh its status in Koaryu after the provider record
          changes.
        </p>
        <h3>Before you call the payment recorded</h3>
        <ul className={styles.checklist}>
          <li>Verify the payer, $150 USD amount, check method, and reference note.</li>
          <li>Confirm exactly one external payment record appears for this check.</li>
          <li>
            Check any related Stripe invoice separately. A new external payment row is not evidence
            that the invoice is paid.
          </li>
        </ul>
        <Link className={styles.referenceLink} href="/features/billing">
          See billing permissions and collection availability <span aria-hidden="true">→</span>
        </Link>
      </section>
    </>
  );
}

function BeltGuide() {
  return (
    <>
      <section className={styles.section} aria-labelledby="shortlist-heading">
        <h2 id="shortlist-heading">Start with a reason beside each name</h2>
        <p>
          This fictional school&#39;s next rank requires 24 qualifying classes, three months at
          rank, and instructor approval. Koaryu calculates three months as 90 days. The table is a
          worked review sheet you can follow when preparing your own list.
        </p>
        <GuideTable
          caption="Fictional pre-test review"
          columns={["Student", "Evidence", "Write on the shortlist"]}
          rows={[
            [
              "Alex",
              "24 qualifying classes; 96 days since a verified promotion date.",
              "Instructor review. The numeric rules are met. Needs approval means an instructor must decide whether to promote.",
            ],
            [
              "Sam",
              "22 qualifying classes; 100 days since a verified promotion date.",
              "More classes. Two qualifying classes short. If staff remembers additional visits, check those attendance records before deciding the count is wrong.",
            ],
            [
              "Lee",
              "30 recorded qualifying classes; 180 days calculated from membership start. Current belt was imported without old promotion history.",
              "Verify history. Neither the 180 days nor the class total proves how much training happened at this belt. Check the actual rank date and which classes came after it.",
            ],
          ]}
        />
      </section>
      <section className={styles.section} aria-labelledby="review-heading">
        <h2 id="review-heading">Work through the evidence before test day</h2>
        <ol className={styles.procedure}>
          <li>
            <h3>Select the program and check its next rank</h3>
            <p>
              Use the student&#39;s correct program membership and ladder. Read the next rank&#39;s
              class requirement, time requirement, and approval setting. An Admin can check and
              configure those rules in Rank Plan, then return to Eligibility. Students training in
              two programs need a separate review for each.
            </p>
            <p>
              A new program membership with no rank selected starts at the program&#39;s first full
              belt, skipping tips. If the program has no full belt, the student remains unranked.
              That starting assignment does not supply a past promotion date.
            </p>
          </li>
          <li>
            <h3>Explain any surprising class count</h3>
            <p>
              Absent entries, canceled or deleted sessions, and attendance marked not to count
              toward eligibility are excluded. A program-specific ladder counts classes in that
              program. When a promotion is recorded, the count starts at that promotion&#39;s time.
              Without promotion history, older qualifying classes can remain in the count.
            </p>
            <p>
              For Sam, inspect the two visits staff remember. Confirm the dated sessions and correct
              missing check-ins only if Sam attended. If those visits belong to another program or
              were excluded from eligibility, they do not close this two-class gap.
            </p>
          </li>
          <li>
            <h3>Check what the time figure starts from</h3>
            <p>
              Koaryu uses the latest recorded promotion date. If none exists, it uses the program
              membership start, then the student&#39;s membership start. If no date exists, the time
              figure is zero. Importing a current belt does not supply the date it was earned.
            </p>
            <p>
              For Lee, find the previous school&#39;s rank record or ask the instructor to verify
              the date. Keep &quot;verify history&quot; on the shortlist until they can judge the
              real time and classes at rank. A membership start six months ago does not establish
              six months at the current belt.
            </p>
          </li>
          <li>
            <h3>Make the instructor&#39;s decision</h3>
            <p>
              Alex meets the example&#39;s numeric rules and still needs an instructor&#39;s
              judgment. Needs approval reflects the rank&#39;s requirement; there is no separate
              approval form or test booking created by that label. Keep the teaching decision on
              your review list until the instructor is ready to record a promotion.
            </p>
          </li>
        </ol>
      </section>
      <section className={styles.section} aria-labelledby="promotion-heading">
        <h2 id="promotion-heading">Record a promotion when it happens</h2>
        <p>
          Admin and Instructor staff can choose Promote for a student whose numeric requirements are
          met. Check the student, program, and target rank in the confirmation, add optional Notes,
          then choose Confirm promotion. Verify the current rank and new history entry after saving.
          Front Desk can take attendance but cannot configure ranks or promote students.
        </p>
        <p>
          Koaryu records the promotion at the time of confirmation. There is no date picker for
          backdating it. If a test happened earlier, mentioning that date in Notes does not change
          the saved promotion timestamp or the starting point for the next review.
        </p>
        <Link className={styles.referenceLink} href="/features/belt-tracking">
          See rank ladders and requirement settings <span aria-hidden="true">→</span>
        </Link>
      </section>
    </>
  );
}

const guideBodies: Record<WorkflowSlug, () => ReactNode> = {
  "spreadsheets-to-studio-crm": RosterGuide,
  "student-retention": RetentionGuide,
  "trial-to-enrollment": TrialGuide,
  "tuition-cleanup": TuitionGuide,
  "belt-test-readiness": BeltGuide,
};

export function WorkflowDetailPage({
  page,
}: {
  page: MarketingPage;
  relatedPages: MarketingPage[];
}) {
  const slug = page.slug as WorkflowSlug;
  const guide = guides[slug];
  const Body = guideBodies[slug];
  if (!guide || !Body) return null;

  return (
    <PublicPageShell>
      <article className={styles.guide} data-workflow={slug}>
        <header className={styles.guideHeader}>
          <Link href="/use-cases" className={styles.backLink}>
            <span aria-hidden="true">←</span> All studio workflows
          </Link>
          <h1>{guide.title}</h1>
          <p className={styles.intro}>{guide.intro}</p>
        </header>
        <Body />
      </article>
    </PublicPageShell>
  );
}

export function WorkflowIndexPage() {
  return (
    <PublicPageShell>
      <div className={styles.directory}>
        <header className={styles.directoryHeader}>
          <h1>Studio workflows</h1>
          <p>
            Choose the job you need to work through. Each guide includes an example and the checks
            needed to finish it.
          </p>
        </header>
        <ul className={styles.directoryList}>
          {useCasePages.map((page) => {
            const guide = guides[page.slug as WorkflowSlug];
            return (
              <li key={page.slug}>
                <h2>
                  <Link href={page.href}>
                    {guide.link} <span aria-hidden="true">→</span>
                  </Link>
                </h2>
                <div className={styles.directoryDetails}>
                  <p>
                    <span className={styles.fieldLabel}>Have ready</span>
                    {guide.ready}
                  </p>
                  <p>
                    <span className={styles.fieldLabel}>Use this guide for</span>
                    {guide.output}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </PublicPageShell>
  );
}
