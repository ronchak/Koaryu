import Link from "next/link";
import type { ReactNode } from "react";

import { PublicPageShell } from "@/components/marketing/public-pages";
import { formatPublicPlatformPrice, PUBLIC_PAYMENTS_FEE_PERCENT } from "@/lib/constants";
import type { MarketingPage } from "@/lib/marketing-pages";

import styles from "./feature-pages.module.css";

function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} prefetch={href === "/signup" ? false : undefined} className={styles.textLink}>
      <span>{children}</span>
      <span aria-hidden="true">↗</span>
    </Link>
  );
}

function PageHeading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className={styles.heading}>
      <TextLink href="/features">All features</TextLink>
      <h1>{title}</h1>
      <p className={styles.lede}>{children}</p>
    </header>
  );
}

function ReferenceTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly string[];
  rows: readonly (readonly ReactNode[])[];
}) {
  return (
    <table className={styles.referenceTable}>
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) =>
              cellIndex === 0 ? (
                <th key={cellIndex} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={cellIndex}>
                  <span className={styles.mobileLabel} aria-hidden="true">
                    {columns[cellIndex]}
                  </span>
                  {cell}
                </td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FeatureIndexPage() {
  return (
    <PublicPageShell>
      <article className={styles.page}>
        <header className={styles.overviewHeading}>
          <p className={styles.kicker}>Koaryu features</p>
          <h1>Run your roster, classes, and rank progression in one studio.</h1>
          <p className={styles.lede}>
            Koaryu is staff software for independent martial arts schools. Keep student records,
            take attendance, review belt requirements, and track inquiries through enrollment.
            Billing has a narrower scope, explained below.
          </p>
        </header>

        <section className={styles.section} aria-labelledby="coverage-heading">
          <h2 id="coverage-heading">What your staff can do</h2>
          <div className={styles.capabilityList}>
            <section>
              <div>
                <h3>Student records</h3>
                <TextLink href="/features/student-management">
                  Fields, families, and editing
                </TextLink>
              </div>
              <p>
                Store contact and emergency details, notes, tags, status, and program memberships.
                Import a CSV roster with column mapping and a validation preview.
              </p>
              <p className={styles.roleNote}>
                Admin and Front Desk manage the roster. Instructors can edit ordinary profile
                details, including notes, but cannot change student status or programs.
              </p>
            </section>
            <section>
              <div>
                <h3>Classes and attendance</h3>
                <TextLink href="/features/attendance">Running and correcting a session</TextLink>
              </div>
              <p>
                Set weekly class times or one-off sessions. Mark each student Present, Late, or
                Absent, or leave them Unmarked. Each change saves separately.
              </p>
              <p className={styles.roleNote}>
                Admin and Front Desk manage the schedule. All three staff roles can take attendance,
                including other-program drop-ins.
              </p>
            </section>
            <section>
              <div>
                <h3>Belt progression</h3>
                <TextLink href="/features/belt-tracking">
                  Requirements and readiness calculations
                </TextLink>
              </div>
              <p>
                Give each program an ordered ladder of belts and tips. Set minimum classes, time,
                and instructor approval for the next rank. Review progress and record promotions.
              </p>
              <p className={styles.roleNote}>
                Admin configures ranks. Admin and Instructor can promote. Meeting the numerical
                requirements does not promote anyone automatically.
              </p>
            </section>
            <section>
              <div>
                <h3>Inquiries and trials</h3>
                <TextLink href="/use-cases/trial-to-enrollment">
                  Following an inquiry through enrollment
                </TextLink>
              </div>
              <p>
                Track a lead&apos;s stage, contact details, and next follow-up date. Review due
                follow-ups and convert a lead into a student record when they enroll.
              </p>
              <p className={styles.roleNote}>
                Admin and Front Desk manage leads. A stage change does not send an offer or a
                message to the family.
              </p>
            </section>
            <section>
              <div>
                <h3>Billing records</h3>
                <TextLink href="/features/billing">Billing actions and availability</TextLink>
              </div>
              <p>
                Review existing payers, plans, invoices, and payments. Record a payment received
                outside Koaryu or attach an external billing record to a student.
              </p>
              <p className={styles.roleNote}>
                Admin and Front Desk have routine billing access. Tuition collection needs separate
                studio activation and is not generally available. New billing exports are
                unavailable.
              </p>
            </section>
            <section>
              <div>
                <h3>Reports and attendance follow-up</h3>
                <TextLink href="/use-cases/student-retention">
                  Interpreting an attendance gap
                </TextLink>
              </div>
              <p>
                Review recent attendance, class utilization, and lead-stage totals. The dashboard
                flags attendance gaps for staff to investigate; it does not contact students.
              </p>
              <p className={styles.roleNote}>
                CSV export access depends on the report and staff role. Front Desk can export
                attendance, schedules, programs, and ranks. Broader exports require Admin access.
              </p>
            </section>
          </div>
        </section>

        <section
          id="fit"
          className={`${styles.section} ${styles.fit}`}
          aria-labelledby="fit-heading"
        >
          <div>
            <p className={styles.kicker}>School and subscription fit</p>
            <h2 id="fit-heading">For one school&apos;s daily work</h2>
            <p>
              Each account belongs to one studio. Koaryu is organized around that studio&apos;s
              students, programs, and staff. Students can train in more than one program, with rank
              progression tracked for each program. Admin, Front Desk, and Instructor have different
              permissions. Instructors do not have billing access.
            </p>
            <p>
              Families appear through student, guardian, and payer records. There is no parent
              portal or combined household workspace to plan around. If you are moving from another
              system, CSV import brings over student fields and current ranks, not historical
              attendance, promotions, or billing.
            </p>
            <TextLink href="/use-cases/spreadsheets-to-studio-crm">
              CSV fields and an import example
            </TextLink>
          </div>
          <aside className={styles.subscription} aria-label="Platform subscription">
            <p className={styles.price}>
              {formatPublicPlatformPrice()} <span>USD per month per studio</span>
            </p>
            <p>
              This is the Koaryu platform subscription. It is separate from tuition charged to your
              students.
            </p>
            <p>
              Separately activated Koaryu Payments adds {PUBLIC_PAYMENTS_FEE_PERCENT}% on successful
              charges, plus Stripe fees. Recording a payment received outside Koaryu does not incur
              that processing fee.
            </p>
            <p>
              Creating an account does not activate tuition collection. If collecting tuition or
              creating billing exports is essential to your move, those availability limits matter
              before you switch.
            </p>
            <TextLink href="/signup">Create an account</TextLink>
          </aside>
        </section>
      </article>
    </PublicPageShell>
  );
}

function StudentManagementPage() {
  return (
    <>
      <PageHeading title="Student records">
        Find a student by name, filter the roster by status, and open their contact details,
        programs, notes, and recorded promotions. In Students, select a student&apos;s name and
        choose Edit to change their profile fields.
      </PageHeading>

      <section className={styles.section} aria-labelledby="profile-heading">
        <h2 id="profile-heading">What goes in the profile</h2>
        <dl className={styles.fieldMap}>
          <div>
            <dt>Identity and contact</dt>
            <dd>
              Legal and preferred names, date of birth, email, phone, address, and a separate
              emergency contact with a name, phone, and relationship. These fields remain editable
              after enrollment.
            </dd>
          </div>
          <div>
            <dt>Status and programs</dt>
            <dd>
              Admin and Front Desk can choose Active, Trialing, Inactive, Paused, or Canceled;
              change the membership start date; and set a hold window. They can select more than one
              program for the same student.
            </dd>
          </div>
          <div>
            <dt>Notes and tags</dt>
            <dd>
              Staff edit one notes field and comma-separated tags. Use the notes for details such as
              a planned break or an instructor observation. This is not a dated message feed, and
              saving a note does not notify the family.
            </dd>
          </div>
          <div>
            <dt>Current rank and history</dt>
            <dd>
              A current belt can exist without a recorded promotion history, for example after an
              import. The history lists recorded rank changes. Editing contact details or notes does
              not rewrite those entries.
            </dd>
          </div>
        </dl>
        <TextLink href="/features/belt-tracking">How ranks and promotion history work</TextLink>
      </section>

      <section id="families" className={styles.section} aria-labelledby="families-heading">
        <h2 id="families-heading">A student, a guardian, and a payer have different records</h2>
        <p className={styles.sectionLead}>
          A parent may appear in both contact and billing information. That does not turn two
          children into one training record.
        </p>
        <figure className={styles.household}>
          <figcaption>Worked household example with fictional names</figcaption>
          <div className={styles.siblings}>
            <div>
              <h3>Maya Tanaka</h3>
              <p>Juniors karate, yellow belt. Her own attendance and promotion history.</p>
            </div>
            <div>
              <h3>Leo Tanaka</h3>
              <p>
                Juniors karate and youth judo. His own program memberships and rank progression.
              </p>
            </div>
          </div>
          <dl>
            <div>
              <dt>Alex as guardian</dt>
              <dd>
                When staff add each child, they can enter one guardian&apos;s name, relationship,
                email, and phone. A minor&apos;s profile displays the primary guardian. Entering
                Alex on both records is not a shared household editor.
              </dd>
            </div>
            <div>
              <dt>Alex as payer</dt>
              <dd>
                Billing keeps the payer&apos;s contact details and payment records separately. When
                an existing Alex payer is available, Admin or Front Desk can select that payer on
                each child&apos;s external billing enrollment. This does not combine their training
                records or charge Alex.
              </dd>
            </div>
          </dl>
          <p className={styles.note}>
            Staff review each child&apos;s attendance in Schedule or Reports and recorded promotion
            history on the student profile.
          </p>
        </figure>
        <div className={styles.prose}>
          <h3>Changing a phone number</h3>
          <p>
            The student and emergency-contact phone fields can be changed in Edit student. Guardian
            fields in that form are read-only after creation. Changing the student&apos;s phone does
            not update the guardian or billing payer, so the profile editor is not a way to update
            the whole family at once.
          </p>
          <p>
            Koaryu does not provide a parent portal or a shared sibling workspace. Do not treat
            matching guardian names as automatic household linking, consolidated invoices, or a
            family discount.
          </p>
          <TextLink href="/features/billing">What a payer record supports</TextLink>
        </div>
      </section>

      <section className={`${styles.section} ${styles.twoColumns}`} aria-labelledby="staff-heading">
        <div>
          <h2 id="staff-heading">Who can edit what</h2>
          <ul className={styles.plainList}>
            <li>
              <strong>Admin and Front Desk</strong> can add students and manage status, hold dates,
              program assignments, and roster imports.
            </li>
            <li>
              <strong>Instructors</strong> can edit ordinary profile information, including contact
              details, emergency details, notes, and tags. They cannot change status, hold dates,
              membership start date, or programs.
            </li>
            <li>
              <strong>Admin and Instructor</strong> can record promotions. Front Desk cannot.
              Billing is available to Admin and Front Desk only.
            </li>
          </ul>
        </div>
        <div>
          <h2>What comes across in a CSV</h2>
          <p>
            Map names, contact and emergency details, guardian fields, notes, tags, programs, and
            current belt. Preview and validate the rows before importing. This creates student
            records; it does not reconstruct attendance or promotion history, and billing columns
            are excluded.
          </p>
          <TextLink href="/use-cases/spreadsheets-to-studio-crm">
            CSV example and import instructions
          </TextLink>
        </div>
      </section>
    </>
  );
}

function BeltTrackingPage() {
  return (
    <>
      <PageHeading title="Rank requirements and promotion readiness">
        Build an ordered rank ladder for each program. Koaryu compares students with the next
        rank&apos;s requirements, then an Admin or Instructor decides whether to record the
        promotion.
      </PageHeading>

      <section
        className={`${styles.section} ${styles.rankSetup}`}
        aria-labelledby="rank-setup-heading"
      >
        <div>
          <h2 id="rank-setup-heading">
            Set the requirements on the rank a student is working toward
          </h2>
          <p>
            In Belt Tracker, an Admin chooses the program and opens Rank Plan to name and reorder
            belts, add tips within a belt, choose colors, and set minimum classes, minimum months,
            and required instructor approval. Different programs can have different ladders.
          </p>
          <p>
            For a student at yellow belt, the orange rank&apos;s settings determine what comes next.
            A tip can also be the next rank. A student without a rank is compared with the first
            step; a student at the top has no next-rank review.
          </p>
        </div>
        <figure className={styles.rankSettings}>
          <figcaption>Example school rule, not a default</figcaption>
          <h3>Orange belt in juniors karate</h3>
          <dl>
            <div>
              <dt>Minimum classes</dt>
              <dd>24</dd>
            </div>
            <div>
              <dt>Minimum months</dt>
              <dd>3, calculated as 90 days</dd>
            </div>
            <div>
              <dt>Instructor approval</dt>
              <dd>Required</dd>
            </div>
          </dl>
        </figure>
      </section>

      <section className={styles.section} aria-labelledby="calculation-heading">
        <h2 id="calculation-heading">Which classes and days count?</h2>
        <p className={styles.sectionLead}>
          Open Eligibility in Belt Tracker and choose the program. The list reviews students with
          Active status against a matching configured ladder for their program. Trialing and Paused
          students do not appear. Check the student&apos;s status, program, and ladder setup before
          treating a missing row as a readiness result.
        </p>
        <div className={styles.calculation}>
          <div>
            <h3>Classes since the recorded rank change</h3>
            <p>
              Koaryu counts attendance at or after the latest recorded rank-change time for that
              program. The class must belong to that program, must not be canceled or deleted, and
              the attendance must count toward eligibility. Present and Late qualify; Absent does
              not. Other-program drop-ins are excluded by default.
            </p>
          </div>
          <div>
            <h3>Time since the recorded rank change</h3>
            <p>
              Elapsed days start at the latest recorded promotion or demotion time for that program.
              A configured month means 30 days, so three months means 90 days. This is not a count
              of calendar-month anniversaries.
            </p>
          </div>
          <div>
            <h3>If there is no promotion history</h3>
            <p>
              Time starts at the program membership&apos;s start date, or the student&apos;s
              membership start date if there is no program start date. With neither date, elapsed
              time is zero. Class counts include all qualifying recorded attendance for that
              program, even attendance before the membership start date.
            </p>
          </div>
        </div>
        <p className={styles.note}>
          The class cutoff uses the attendance record&apos;s check-in timestamp. Selecting an older
          class date is not the same as backdating that timestamp. Review the original records when
          adding old attendance or bringing in an existing roster.
        </p>
        <TextLink href="/features/attendance">Attendance statuses and drop-in behavior</TextLink>
      </section>

      <section className={styles.section} aria-labelledby="comparison-heading">
        <h2 id="comparison-heading">The same belt can produce different results</h2>
        <p className={styles.sectionLead}>
          Use the orange-belt rule above. Review Maya and Leo at the same time on September 30. Both
          are at yellow belt.
        </p>
        <ReferenceTable
          caption="Illustrative readiness calculation"
          columns={["Student", "Recorded evidence", "Result"]}
          rows={[
            [
              "Maya",
              "Yellow promotion recorded July 1. Exactly 91 elapsed days and 24 qualifying classes since that time.",
              "24 of 24 classes and 91 of 90 days. Numerical requirements met; instructor approval is still required.",
            ],
            [
              "Leo",
              "Yellow promotion recorded July 15. Exactly 77 elapsed days. There are 26 attended classes since then, but two are other-program drop-ins.",
              "24 of 24 qualifying classes and 77 of 90 days. Time requirement is short by 13 days; attendance at another program does not remove that gap.",
            ],
          ]}
        />
        <p className={styles.note}>
          For an imported yellow belt with no promotion history, a July 15 program start date would
          supply the time calculation, but would not exclude earlier qualifying classes. A current
          belt alone does not establish when that belt was earned.
        </p>
      </section>

      <section
        className={`${styles.section} ${styles.promotion}`}
        aria-labelledby="promotion-heading"
      >
        <h2 id="promotion-heading">Recording the decision</h2>
        <p>
          Readiness separates numerical progress from required approval. The approval setting keeps
          a student in the approval group even when both numbers are met. It does not record an
          instructor&apos;s decision on its own.
        </p>
        <p>
          An Admin or Instructor opens the promotion confirmation, reviews the next rank, adds
          optional notes, and confirms. Koaryu updates that program&apos;s current rank and adds a
          history entry with the staff member and recording time. The confirmation has no date
          picker, so it cannot backdate a test held last week.
        </p>
        <TextLink href="/use-cases/belt-test-readiness">
          Belt-test preparation and review worksheet
        </TextLink>
      </section>
    </>
  );
}

function AttendancePage() {
  return (
    <>
      <PageHeading title="Schedule classes and take attendance">
        In Schedule, Admin and Front Desk choose Add class to create a weekly template or a one-off
        session. Admin, Front Desk, and Instructor can select a dated class to mark its roster.
        Attendance saves one student at a time.
      </PageHeading>

      <section
        className={`${styles.section} ${styles.twoColumns}`}
        aria-labelledby="schedule-heading"
      >
        <div>
          <h2 id="schedule-heading">Weekly template</h2>
          <p>
            Set a class name, program, weekday, start and end times, capacity, and a start date. An
            optional end date limits the recurring slot. The calendar gives staff individual dated
            sessions to open.
          </p>
        </div>
        <div>
          <h2>One-off session</h2>
          <p>
            Choose a specific date for a workshop or extra class without creating a weekly slot.
            Attendance belongs to that session. Removing one dated class and stopping a recurring
            series are separate actions.
          </p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="session-heading">
        <div className={styles.sessionTitle}>
          <p className={styles.kicker}>Worked example</p>
          <h2 id="session-heading">
            Tuesday, September 22
            <br />
            Juniors karate at 4:30 pm
          </h2>
        </div>
        <ol className={styles.sessionWalkthrough}>
          <li>
            <h3>Open this date&apos;s class</h3>
            <p>
              The roster puts students assigned to juniors karate first. Other active students
              appear under Other program drop-ins. An unassigned class uses the full active roster.
              Staff must wait for the complete roster and attendance records to load before marking
              anyone.
            </p>
          </li>
          <li>
            <h3>Mark Maya when she arrives</h3>
            <p>
              Selecting an Unmarked row saves Present. The row shows a saving state and cannot be
              changed again until that save finishes. There is no final Save class button.
            </p>
            <p>
              Repeated selections cycle through <strong>Present → Late → Absent → Unmarked</strong>.
              Late still counts as attended. Unmarked means there is no attendance record for that
              student in this session, not a recorded absence.
            </p>
            <p>
              Sam arrives late from another program. Find Sam under Other program drop-ins and cycle
              the row from Unmarked through Present to Late. The saved row is an attended visit,
              with a drop-in label.
            </p>
          </li>
          <li>
            <h3>Correct an accidental check-in</h3>
            <p>
              If Leo was marked Present but did not attend, cycle his row through Late to Absent,
              allowing each save to finish. Choose Unmarked if you want to remove the attendance
              entry instead. Koaryu does not mark the untouched rows absent when class ends.
            </p>
          </li>
          <li>
            <h3>Check the save result</h3>
            <p>
              If a change fails, Koaryu restores the previous row state and shows an error. The
              session tells staff that the last change was not saved. Review the error and retry
              that student&apos;s row; the temporary mark is not a confirmed save.
            </p>
          </li>
        </ol>
      </section>

      <section className={styles.section} aria-labelledby="consequences-heading">
        <h2 id="consequences-heading">What that session contributes</h2>
        <figure className={styles.sessionOutcome}>
          <figcaption>Continuing the fictional class example</figcaption>
          <dl>
            <div>
              <dt>Maya, Present</dt>
              <dd>
                One attended visit. As a juniors-karate student in a juniors-karate class, the
                record normally counts toward that program&apos;s rank requirement.
              </dd>
            </div>
            <div>
              <dt>Leo, Absent</dt>
              <dd>
                No attended visit and no class toward rank eligibility. Clearing the row to Unmarked
                would remove the explicit absence; it would not add a visit.
              </dd>
            </div>
            <div>
              <dt>Sam, Late drop-in</dt>
              <dd>
                One attended visit in the class totals. Sam trains in another program, so this
                drop-in does not count toward rank eligibility by default.
              </dd>
            </div>
          </dl>
          <p>
            The class has two attended visits in this example, but only Maya gains a qualifying
            class for this program&apos;s rank review.
          </p>
        </figure>
        <div className={styles.twoColumns}>
          <div>
            <h3>Reports count recorded attendance</h3>
            <p>
              Present and Late contribute to attendance totals and class utilization. Older records
              labeled Excused also count as attended. Absent and Unmarked do not. Correcting a row
              therefore changes the evidence in later reviews.
            </p>
            <TextLink href="/features/belt-tracking">
              How qualifying classes affect rank readiness
            </TextLink>
          </div>
          <div>
            <h3>An attendance gap needs staff review</h3>
            <p>
              The dashboard uses non-absent check-in records to flag inactivity. It does not know
              why someone missed class. Check for a hold, an unrecorded visit, or another
              explanation before contacting the family through your usual channel.
            </p>
            <TextLink href="/use-cases/student-retention">
              Reviewing and following up on attendance gaps
            </TextLink>
          </div>
        </div>
      </section>
    </>
  );
}

function BillingPage() {
  return (
    <>
      <PageHeading title="Billing records and tuition collection">
        Admin and Front Desk can review existing billing records and record payments received
        outside Koaryu. Tuition collection requires separate activation for your studio and is not
        generally available. Creating an account does not turn it on.
      </PageHeading>

      <section
        className={`${styles.section} ${styles.billingPrice}`}
        aria-label="Platform price and tuition distinction"
      >
        <p className={styles.price}>
          {formatPublicPlatformPrice()} <span>USD per month per studio</span>
        </p>
        <div>
          <p>
            This pays for the Koaryu platform subscription. Student tuition, a family&apos;s billing
            plan, and payments to your school are separate records and charges.
          </p>
          <p>
            Separately activated Koaryu Payments adds {PUBLIC_PAYMENTS_FEE_PERCENT}% on successful
            charges, plus Stripe fees. Recording a cash, check, or other external payment does not
            incur that processing fee.
          </p>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="billing-actions-heading">
        <h2 id="billing-actions-heading">What each billing action does</h2>
        <p className={styles.sectionLead}>
          Instructors do not have billing access. Admin and Front Desk share routine record work;
          actions that collect or change money have narrower permissions and availability.
        </p>
        <ReferenceTable
          caption="Billing access and availability"
          columns={["Action", "Who can use it", "Outcome and limit"]}
          rows={[
            [
              "Review existing records",
              "Admin and Front Desk",
              "In Billing, Families shows payer contacts; Tuition Plans shows plans; Student Billing shows enrollments; Invoices shows invoice status. A missing payer or assignment still needs to be resolved; viewing a record does not create one.",
            ],
            [
              "Attach external student billing",
              "Admin and Front Desk",
              "In Billing > Student Billing, select a student and an existing plan, optionally a payer, and record billing dates. Choose Attach to add the external billing enrollment. It does not create a Stripe subscription, collect money, or change training status.",
            ],
            [
              "Record external payment",
              "Admin and Front Desk",
              "In Billing > Advanced, use Record external payment. Select an existing payer and enter a USD amount, method, and optional note for cash, check, or a payment collected elsewhere. This records receipt at payer level. It does not pay or close an invoice.",
            ],
            [
              "Reconcile an existing Stripe invoice",
              "Admin and Front Desk",
              "In Billing > Invoices, choose Reconcile on the existing invoice to refresh Koaryu's record from its Stripe status. This does not charge the payer or create another invoice.",
            ],
            [
              "Collect or change tuition through Stripe",
              "Separately activated studios, with action-specific permissions",
              "Creating, finalizing, retrying, or voiding invoices and issuing refunds require Admin access and availability for the studio. In Families, Front Desk may prepare a link the payer uses to enter their own payment details when that action is enabled. These are not general signup capabilities.",
            ],
            [
              "Create a billing export",
              "Unavailable",
              "New billing export creation is unavailable. Do not plan an accounting migration around a downloadable billing ledger from Koaryu.",
            ],
          ]}
        />
      </section>

      <section
        className={`${styles.section} ${styles.paymentExample}`}
        aria-labelledby="check-heading"
      >
        <p className={styles.kicker}>Worked payment example</p>
        <h2 id="check-heading">A check payment will not close a Stripe invoice.</h2>
        <p>
          Alex has an open $120 Stripe invoice and hands the front desk a $120 check. Staff choose
          Alex&apos;s payer record, enter $120 with Check as the method, and add a note identifying
          what the check covers.
        </p>
        <div className={styles.paymentComparison}>
          <div>
            <h3>External payment record</h3>
            <p>
              Koaryu now records a $120 check received for Alex. That entry belongs to the payer. It
              is not allocated to the open invoice.
            </p>
          </div>
          <div>
            <h3>Stripe invoice</h3>
            <p>
              The $120 invoice remains open unless its state changes separately in Stripe. Reconcile
              only reads that state back. Repeating the external payment or refreshing the invoice
              will not settle it.
            </p>
          </div>
        </div>
        <p>
          Review the open invoice with the person responsible for your Stripe account before
          attempting collection again. A payment received outside Stripe and an open invoice can
          coexist, so checking only one record can lead to a second collection attempt.
        </p>
        <TextLink href="/use-cases/tuition-cleanup">
          Steps for a missing payer or unresolved invoice
        </TextLink>
      </section>

      <section
        className={`${styles.section} ${styles.twoColumns}`}
        aria-labelledby="accounting-heading"
      >
        <div>
          <h2 id="accounting-heading">What the billing totals mean</h2>
          <p>
            In Billing &gt; Advanced, the totals cover payments processed in the current UTC month.
            The Stripe total subtracts confirmed refunds and money returned through disputes tied to
            those payments. A refund this month for a payment from a previous month is outside that
            total. These figures are not a statement of bank deposits or recognized revenue.
          </p>
          <p>
            Keep the accounting records you use to reconcile deposits and reporting periods. The
            billing screen and its payment totals do not replace that reconciliation.
          </p>
        </div>
        <div>
          <h2>Who trains and who pays</h2>
          <p>
            Each student keeps their own training record. A payer is the billing contact, who may
            also be a guardian. An external billing enrollment can link an existing payer and plan
            to a student without changing their program, status, or rank.
          </p>
          <TextLink href="/features/student-management#families">
            Student, guardian, and payer example
          </TextLink>
        </div>
      </section>
    </>
  );
}

const detailPages: Record<string, () => ReactNode> = {
  "student-management": StudentManagementPage,
  "belt-tracking": BeltTrackingPage,
  attendance: AttendancePage,
  billing: BillingPage,
};

export function FeatureDetailPage({
  page,
}: {
  page: MarketingPage;
  relatedPages: MarketingPage[];
}) {
  const Detail = detailPages[page.slug];
  if (!Detail) return null;
  return (
    <PublicPageShell>
      <article className={styles.page}>
        <Detail />
      </article>
    </PublicPageShell>
  );
}
