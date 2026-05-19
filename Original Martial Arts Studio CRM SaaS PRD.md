# Martial Arts Studio CRM SaaS PRD

## Overview

This product is a flat-rate vertical SaaS platform for independent martial arts studios that replaces spreadsheets, overpriced legacy systems, and generic gym software with a purpose-built operating system for student management, lead conversion, belt progression, scheduling, attendance, billing, and retention. The central product thesis is that martial arts schools have operational needs that differ from standard gyms, especially around belt tracking, youth programs, parent communication, and promotion workflows, yet existing software often bundles too much complexity at too high a price. RainMaker, now Zivvy, is commonly listed at $197 per month and is repeatedly described as expensive relative to the needs of smaller studios, creating a clear opening for a lower-cost, simpler alternative.[^1][^2][^3][^4][^5][^6][^7]

The product should be designed for a founder-led SaaS business with low marginal cost. Core features should be implemented as deterministic workflows, database-backed state transitions, and rules-based automations rather than LLM-dependent runtime behavior. This matches the user's preference for traditional SaaS economics and their existing experience building production software with Next.js and FastAPI. The resulting product should be easy to host, cheap to scale, and simple enough that an instructor-owner can adopt it without onboarding consultants or a long implementation process.[^8][^2][^9]

## Product Vision

The product should become the daily operating system for small martial arts schools, especially owner-operated dojos and studios with roughly 30 to 200 active students. It should help studio owners spend less time on manual admin and more time teaching by centralizing all recurring workflows into one clean interface: lead intake, trial conversion, active membership management, attendance logging, belt progression, billing, and proactive retention communication.[^2][^3][^10][^9]

The product should not try to be a generalized all-in-one gym platform in version one. The strategic advantage comes from being narrower and more opinionated than broad fitness tools, with martial-arts-specific objects and workflows built directly into the data model and UI. The positioning should be: affordable martial arts studio software built around how dojos actually operate, not a generic gym CRM with martial arts tacked on.[^11][^12][^9][^7][^1]

## Target Market

### Primary customer

The primary customer is an owner-operator, head instructor, or school manager running a martial arts studio who is not deeply technical and has limited administrative support. This customer usually teaches classes, handles parent communication, manages memberships, tracks who is eligible for testing, and often still relies on spreadsheets or fragmented tools because purpose-built options feel too expensive or too bloated. This profile aligns strongly with smaller studios that are highly sensitive to software cost and have rejected tools like RainMaker or similar platforms because pricing rises faster than operational value.[^3][^4][^9][^6][^2]

### Secondary customer

The secondary customer is a front-desk operator or assistant instructor at a growing studio who needs fast access to student records, attendance, upcoming renewals, and lead follow-up tasks without seeing full financial settings or sensitive admin controls. Role-based access should support this user from the beginning because even small studios often split teaching and front-desk responsibilities informally.[^9][^7]

### Ideal early segment

The best initial segment is independent martial arts schools with one location, 30 to 200 students, recurring memberships, and a curriculum with explicit rank progression, such as karate, taekwondo, Brazilian jiu-jitsu for kids programs, and hybrid family martial arts schools. These studios feel the pain of belt tracking, attendance-based promotion decisions, and parent communication more sharply than generic fitness businesses, which increases the value of a vertical product.[^13][^14][^15][^1][^2]

## Core Problems

Current software in this category suffers from three recurring issues: price, complexity, and poor fit. High-cost incumbents impose a serious burden on smaller schools, and some alternatives charge based on student count, which means software becomes more expensive as the school grows. That pricing model is especially frustrating for owner-operators who already run on tight margins.[^4][^6][^2][^11][^9]

At the same time, generic gym and studio tools often miss martial-arts-specific needs such as belt rank tracking, promotion criteria, and student progress visibility. Schools then compensate with side systems like spreadsheets, manual notes, and memory, which increases operational risk and makes retention worse because no one can clearly see who is inactive, overdue, or due for promotion. The opportunity is therefore not to invent an entirely new category, but to deliver a simpler, cheaper, more domain-native execution of one that already has proven demand.[^16][^17][^5][^7][^15][^1][^3][^9]

## Product Principles

The product should follow six foundational principles.

First, it should be martial-arts-native. Belt progression, testing readiness, attendance streaks, youth guardian records, and promotion history should be first-class entities rather than custom fields added on later.[^18][^14][^13]

Second, it should be flat-rate and predictable. Pricing should not punish growth through per-member fees, because that was explicitly identified as a major frustration with current software.[^6][^2][^4]

Third, it should be operationally minimal. The UI should feel fast, dense, and low-friction so a busy instructor can use it between classes without getting lost in settings or visual noise. This aligns with the user's own preference for minimal, tool-like software experiences and their technical taste shaped by modern developer products.

Fourth, it should avoid AI dependence in the critical path. Core workflows should rely on forms, state transitions, schedulers, and deterministic automations rather than paid LLM inference. This protects margins as user count grows and keeps the product closer to traditional SaaS economics.[^19][^20]

Fifth, it should be self-serve. Setup should not require implementation help. A studio should be able to create an account, define belt ranks, import students, connect billing, and start taking attendance the same day.[^8][^2]

Sixth, it should be multi-tenant and secure by default, since studio data includes minors, contact details, and financial state. Database-level isolation and role-based permissions are non-negotiable.[^21][^22]

## Product Scope

Version one should include six tightly integrated modules: student CRM, belt progression, leads, scheduling and attendance, billing, and communications. These modules cover the overwhelming majority of day-to-day studio operations and directly address the jobs that current users are patching together with spreadsheets, email, and expensive legacy tools.[^1][^2][^3][^4][^9]

Version one should exclude point-of-sale hardware, advanced e-commerce, franchise support, complex accounting, a native mobile app, and AI chat. Those features add implementation and support burden without strengthening the initial value proposition for a one-location studio. The first product must win on clarity and workflow fit, not feature count.[^7][^11]

## Detailed User Roles

### Owner-admin

This role can manage studio settings, staff roles, belt systems, pricing plans, Stripe connection, automations, reports, and all student records. In smaller schools this will be the main account. The owner-admin needs one dashboard that answers: who is overdue, who is close to quitting, who is ready to test, what revenue is expected this month, and what needs attention before the next class block.[^3][^9]

### Instructor

This role needs access to attendance, class rosters, student notes, belt progress, and promotion recommendations. Instructors should not be able to modify billing settings or export sensitive financial reports unless explicitly granted permissions. The workflow must be optimized for speed, especially on a tablet or phone during class transitions.[^9][^7]

### Front desk / operations assistant

This role needs lead pipeline access, trial scheduling, active membership lookup, payment status visibility, and communication tools. The front desk user is the person most likely to be following up on leads, checking in students, or answering parent questions. Their interface should surface actionable status clearly without overwhelming them with configuration controls.[^10][^9]

## Key User Journeys

### Journey one: opening the studio for the day

An owner logs in before classes start and immediately sees today’s schedule, missing payments needing attention, students who have not attended recently, and students approaching testing eligibility. From this dashboard they can send a payment reminder, review the class roster, and prepare for a belt test without opening multiple modules. The system must reduce morning operational anxiety by surfacing only the most relevant exceptions.[^3][^9]

### Journey two: converting a new lead

A parent or adult prospect submits a form or calls the studio. Staff creates a lead with source, contact details, program interest, and trial date. The lead moves from Inquiry to Trial Scheduled to Trial Completed to Enrolled, with optional email reminders between each stage. Once enrolled, the lead converts into a student record without re-entering data. This reduces administrative duplication and makes conversion rates visible over time.[^23][^10]

### Journey three: running attendance

Before class, an instructor opens a mobile-friendly roster page with all expected students. Each student can be marked present with one tap, and the system records attendance against both the class and the student profile. Attendance immediately updates future promotion calculations and inactivity monitoring. The ideal interaction is sub-10 seconds for a typical class roll call.[^14][^3]

### Journey four: deciding who is ready to test

The owner opens the belt tracker and sees a filtered list of students who meet configured eligibility thresholds such as minimum classes, time since last promotion, and test requirement flags. The system does not decide for the instructor, but it should present evidence clearly enough that running a belt test no longer requires manual spreadsheet reconciliation.[^13][^18][^14]

### Journey five: handling failed payments

Stripe attempts a recurring tuition charge and returns failure. A webhook records the failed attempt, updates the payment status on the student profile, schedules the retry sequence, and sends the appropriate notification email. If the charge eventually succeeds, the alert disappears automatically. If not, the account is flagged for manual review. The product should eliminate most awkward manual payment chasing.[^24]

## Functional Requirements

### Student CRM

The system must support a canonical student profile as the central record for every enrolled student. Required fields should include legal name, preferred name, date of birth, email, phone, guardian contact fields for minors, address, emergency contact, membership start date, membership status, current program, current belt rank, notes, and tags. The profile must show attendance history, payment status, promotion history, and upcoming automations in a single place.[^25][^26][^1][^9]

The system must support search, filtering, and sorting across students by status, belt, program, instructor, overdue payment, inactivity, and test eligibility. Bulk actions should include sending email, changing tags, moving students across programs, and exporting selected rows to CSV. Deleting students should be soft-delete only for auditability.

### Belt progression engine

The system must let each studio configure one or more belt ladders. A ladder should support ordered ranks, color metadata, required minimum classes, optional minimum months at current rank, optional age bracket, and a manual instructor approval flag. Studios using multiple disciplines should be able to configure multiple ladders later, but version one can support one ladder per program if that keeps the UX simpler.[^18][^14][^13]

Promotion readiness should be computed from actual attendance and rule thresholds. A student profile should display classes completed since last promotion, days at current rank, and whether manual approval is still required. Promotion actions should create an immutable promotion log with date, from-rank, to-rank, and staff member performing the action.[^14][^18]

### Lead pipeline

The system must include a visual lead pipeline with default stages of Inquiry, Trial Scheduled, Trial Completed, Offer Sent, and Enrolled. Each lead needs source attribution, status, notes, assigned staff member, and follow-up date. Dragging a card between stages should update pipeline status instantly. Lead forms should support minors by allowing parent contact as the primary communication record.[^10][^23]

The system should track basic conversion metrics by source and stage, since understanding whether leads come from referrals, social, search, or walk-ins directly affects local studio growth strategy. Lost leads should be marked closed-lost with reason codes like no-show, price objection, timing, or no response.[^10][^9]

### Scheduling and attendance

The system must support weekly recurring classes, one-off special events, instructor assignment, capacity limits, and program labels. Staff should be able to view schedule by day, week, or list. Attendance should be operable from desktop and mobile browser with minimal taps. A check-in state should optionally distinguish between present, late, excused, and absent if the studio wants that level of fidelity.[^27][^3]

Attendance should feed at least four downstream workflows: promotion readiness, inactivity alerts, class utilization reporting, and student profile history. This is one of the most important product linkages and should be architected carefully rather than treated as an isolated module.[^14][^3]

### Billing and subscriptions

The system must integrate with Stripe Billing for recurring memberships, one-time charges, discounts, family plans in a future phase, and payment retry logic. In version one, at minimum the system should support monthly tuition, annual tuition, enrollment fees, and manual adjustment notes. Each student should be linked to a Stripe customer and, when relevant, a Stripe subscription id.[^24]

Payment statuses should include active, trialing, overdue, canceled, and paused. Staff should be able to view invoice history and upcoming billing dates without leaving the app. Webhook-driven state sync is required so the app remains the operational dashboard while Stripe remains the payment processor of record.

### Communications and automations

The system must support rules-based email automations using prewritten templates and merge fields, not AI-generated text. Initial triggers should include lead trial reminder, missed-class nudge, payment failed, payment recovered, membership ending soon, belt test announcement, and promotion congratulations. Each automation should be toggleable and editable by studio admins.[^23][^9]

Studios should be able to define inactivity thresholds such as no attendance in 14 days or 30 days, because retention risk often appears first in attendance data rather than cancellation requests. Email delivery should be handled through a transactional provider such as Resend in version one. SMS can remain future scope.[^9]

### Reports and analytics

The product should provide essential operational reporting, not exhaustive BI. Version one reports should include active student count, monthly recurring revenue, failed payments, churned members, attendance by class, attendance by student, promotion history, leads by source, and conversion rate by funnel stage. Each report should export to CSV. The best experience is not a complex analytics suite but fast answers to the questions a school owner asks every week.[^10][^9]

### Settings and permissions

Studio settings must include business name, logo, timezone, tuition plans, tax settings if needed, automation defaults, staff invitations, and belt ladder configuration. Role-based access should support at least Admin, Instructor, and Front Desk roles. Multi-tenant isolation should be enforced in the database, not only at the application layer.[^22][^21]

## Non-Functional Requirements

The application must feel fast on ordinary consumer hardware and mobile browsers. Key screens such as dashboard, student list, and class roster should load quickly enough that staff can use them in real-time studio operations. The UI should privilege dense information display over decorative spacing because the product is a daily work tool, not a marketing microsite.

Reliability matters more than novelty. The product must use deterministic logic, idempotent webhooks, audit logs for sensitive actions, and strong tenant isolation. Any feature touching minors, payments, or attendance history should be fully traceable. Data export and backup capability should be built in early to make migration from spreadsheets and incumbent software easier.[^4][^21]

## UX and UI Direction

The UI should be dark-mode-first, minimal, utilitarian, and highly structured. It should feel closer to Linear, Vercel dashboards, and modern developer tools than to legacy small-business admin software. This aligns with the user's design taste and reduces the likelihood that an AI coding assistant invents bloated, glossy, generic SaaS UI.

### Visual system

Use a restrained neutral palette with one warm accent. Suggested tokens:

| Token | Value | Use |
|---|---|---|
| Background | #0B0D10 | Page background |
| Surface | #12161B | Cards and panels |
| Surface Raised | #171C22 | Inputs, hover states |
| Border | #232A33 | Dividers and strokes |
| Text Primary | #F3F5F7 | Main text |
| Text Secondary | #98A2B3 | Labels and metadata |
| Muted | #667085 | Placeholder and low-priority text |
| Accent | #D6B25E | Primary actions, active states |
| Success | #4CAF7D | Paid, active, ready |
| Warning | #E8A23A | Retry, attention |
| Danger | #E05A5A | Overdue, destructive |

Typography should use Inter for all UI text, with JetBrains Mono reserved for ids, payment values, and status metadata. Corners should be small, around 6px. There should be no shadows, only borders and subtle background shifts. This makes the product feel serious and fast.

### Layout

The layout should use a left sidebar with fixed navigation and a top content header for page-level actions. Cards should be compact, tables should be the default representation for records, and modals should be used sparingly. The product should avoid marketing-style whitespace. Important information should be visible above the fold. On mobile, the priority should be quick roster check-in and student lookup rather than full admin configuration.

### Navigation

Primary navigation should include Dashboard, Students, Belt Tracker, Leads, Schedule, Billing, Automations, Reports, and Settings. The most common daily actions should never be more than two clicks away. Student lookup and class check-in should be accessible from global search or a keyboard shortcut in later versions.

### Component rules

Buttons should be compact and clearly hierarchical. Tables should support sticky headers, simple filters, and row click-through. Status should always be expressed with both color and text labels. Empty states should use one short explanatory line and one CTA, not illustrations. Forms should be narrow and segmented logically so staff can complete them quickly between classes.

## Recommended Tech Stack

The user's current production experience is with Next.js and FastAPI, making that the strongest stack choice for delivery speed and maintainability. The recommended architecture is Next.js App Router for the frontend, FastAPI for the backend API, PostgreSQL as the database, Stripe for billing, Resend for transactional email, and Vercel plus Render for deployment.[^24]

For the database, the strongest default recommendation is Supabase-backed Postgres, especially because it provides auth, row-level security, and a generous free tier that is sufficient for MVP validation. Supabase projects on the free tier pause after inactivity, so the production plan should anticipate moving to the Pro tier once a few paying studios exist. Neon is also viable, especially for a composable Vercel-native setup, but Supabase is the more complete starting platform for this multi-tenant use case.[^28][^29][^30][^31][^21][^22]

Azure is technically usable but is not the recommended path for this project. It adds platform complexity relative to Vercel, Render, and managed Postgres options, and the student credit is better treated as optional experimentation budget rather than the production foundation.[^32][^33]

### Proposed architecture

- Frontend: Next.js 14+ with App Router, server components where helpful, Tailwind CSS, and lucide-react icons.
- Backend: FastAPI with Pydantic models and modular routers for auth, students, leads, schedule, billing, and reports.
- Database: PostgreSQL via Supabase.
- Auth: Supabase Auth for email/password and magic link login.
- Payments: Stripe Billing and webhooks.
- Email: Resend.
- Background jobs: lightweight scheduler or queue for automation triggers and retry-safe async work.
- File storage: Supabase Storage for logos or future documents.
- Deployment: Vercel for frontend, Render for backend.

## Suggested Data Model

The core schema should include at minimum these entities:

- Studio
- User
- StaffRole
- Student
- Guardian
- Program
- BeltLadder
- BeltRank
- Promotion
- Lead
- LeadActivity
- ClassTemplate
- ClassSession
- Attendance
- MembershipPlan
- StudentMembership
- Payment
- AutomationRule
- EmailTemplate
- AuditLog

Each row containing customer data must include a studio_id for tenant isolation. Attendance should reference both student and class session. Promotions should reference both prior and new rank. Payments should sync external Stripe identifiers for reconciliation. Audit logs should capture actor, action, entity, and timestamp.

## API Surface

The application should expose a clean versioned REST API. Core routes should include:

- `/auth/*`
- `/studios/*`
- `/students/*`
- `/guardians/*`
- `/programs/*`
- `/belt-ladders/*`
- `/promotions/*`
- `/leads/*`
- `/classes/*`
- `/attendance/*`
- `/memberships/*`
- `/payments/*`
- `/automations/*`
- `/reports/*`

The API should favor predictable CRUD plus a few workflow-specific endpoints such as `POST /leads/{id}/convert`, `POST /students/{id}/promote`, `POST /attendance/check-in`, and `POST /stripe/webhook`.

## Import and Migration Requirements

Spreadsheet migration is essential because many target studios already rely on Google Sheets or CSV-based systems, including the user's own firsthand experience building a spreadsheet-based CRM workaround. Version one should therefore include CSV import for students, leads, and belt ranks. Import mapping should let the user align their spreadsheet columns to system fields before committing. Errors should be shown row by row with downloadable feedback.[^4]

A polished import flow is strategically important because it lowers switching cost from incumbents and from manual systems. A studio should not need perfect data to get started. The product should tolerate partial records and prompt for missing critical fields later.

## Pricing Recommendation

Pricing should explicitly differentiate against high-cost incumbents and per-member pricing frustration. A strong launch structure is:[^2][^6][^4]

| Plan | Monthly price | Limits |
|---|---:|---|
| Starter | $49 | 1 location, up to 75 active students |
| Growth | $79 | 1 location, up to 200 active students |
| Pro | $129 | 1 location, unlimited active students, advanced reports |

This keeps the product clearly below RainMaker pricing while preserving enough margin to absorb modest infrastructure, email, and support costs. Pricing should remain flat-rate rather than usage-priced on student count within narrow bands. The psychological pitch is that software should not punish a school for gaining members.[^6][^4]

## Go-To-Market Implications

The strongest go-to-market motion is direct outreach to small martial arts schools, especially those currently on spreadsheets, legacy software, or low-satisfaction alternatives. Messaging should emphasize three outcomes: lower monthly software cost, simpler daily operations, and built-in belt progression workflows. Because the user has lived experience in martial arts studios and firsthand exposure to RainMaker plus spreadsheet replacements, that founder-market fit is real and should show up directly in positioning.[^4][^9]

An especially strong wedge is the promise of replacing spreadsheet-based admin without forcing a giant operational change. If setup is fast and import is easy, this product can be sold not as “new software” but as a calmer, cleaner version of the workflows studios already run.

## Security and Compliance

The product will hold personal information, including records for minors and parent contacts, so access control, encrypted transport, and secure credential handling are mandatory. Sensitive actions should be logged. Password resets and magic links should be rate-limited. PII should never be exposed across tenants. Stripe should remain the system of record for card data so the product itself does not handle raw card numbers.[^21][^24]

Data export should be available at the studio level to build trust and reduce lock-in anxiety. A clear privacy policy and deletion workflow should be planned before launch, especially because parent trust is central in youth-oriented martial arts programs.

## Build Order

A realistic build sequence is:

1. Studio auth, onboarding, and tenant model.
2. Student CRM and CSV import.
3. Schedule plus attendance.
4. Belt ladder configuration and promotion engine.
5. Lead pipeline and conversion flow.
6. Stripe billing and webhook sync.
7. Email automations.
8. Dashboard and reports.
9. Staff roles and audit logs.
10. Polish, onboarding, and migration UX.

This sequence gets the system-of-record pieces live first, then layers monetization and automation on top. It also minimizes wasted work because most downstream modules depend on core student, class, and tenant entities.

## Definition of Success

The product is successful in version one if a small studio can do all of the following without spreadsheets: add students, run class attendance, track belt progression, manage leads, collect recurring tuition, and send key reminders. The product is commercially validated if at least a few studios are willing to switch primarily because it is cheaper and simpler than RainMaker-like alternatives while still covering belt tracking and daily operations.[^6][^3][^9][^4]

From a product standpoint, the win condition is not maximal feature breadth. The win condition is becoming the software a studio leaves open all day because it actually matches how the school runs.

## Final Product Statement

This product should be built as a focused vertical SaaS for independent martial arts schools, not as a generic gym platform and not as an AI-first product. The strongest wedge is the combination of lower pricing, cleaner UX, and martial-arts-native workflows such as belt progression, attendance-linked readiness, guardian-aware student records, and lightweight lead conversion. With the recommended stack and scope discipline, it is technically realistic, economically sound, and closely aligned to the user's domain knowledge and existing engineering workflow.[^28][^1][^2][^21][^13]

---

## References

1. [Best Martial Arts Management Software 2026 | 8 Platforms Compared](https://1club.ai/blog/best-martial-arts-management-software-2026) - 1club is an AI-native gym management software built to help martial arts school owners run smoother ...

2. [10 Martial Arts Membership Software for Dojos, Schools, and Clubs](https://joinit.com/blog/best-martial-arts-membership-software) - Compare 10 martial arts membership software tools in 2026 for dojos, schools, and clubs. See pricing...

3. [Martial Arts Software Mistakes Dojo Owners Must Avoid in 2026](https://zenplanner.com/blogs/martial-arts-software-mistakes-dojo-owners-must-avoid/) - Avoid common mistakes when choosing martial arts software. Learn how to select the best martial arts...

4. [RainMaker Reviews 2026. Verified Reviews, Pros & Cons | Capterra](https://www.capterra.com/p/130861/RainMaker/reviews/) - Provider data verified by our Software & Services Research team, and reviews moderated by our Review...

5. [RainMaker Software Reviews, Demo & Pricing - 2026](https://www.softwareadvice.com/martial-arts/rainmaker-profile/) - # RainMaker 2026: Benefits, Features & Pricing

Wondering if RainMaker is right for your organizatio...

6. [Rainmaker Customer Reviews - Angel Rated](https://angelrated.com/reviews/340/rainmaker) - Martial arts, fitness and dance coaches/trainers. Pricing Plan: $197/mo or $2,197/yr for unlimited c...

7. [Martial Arts Software vs. Standard Management: Which is Better?](https://www.wellnessliving.com/blog/martial-arts-software-vs-standard-management-which-is-better/) - Discover how martial arts software outperforms standard tools by saving time, streamlining operation...

8. [Best Order Management Software for Small Businesses in 2026](https://www.mrpeasy.com/blog/best-order-management-software/) - Choosing a Software 25 min read

9. [Best Practice Management Software for Martial Arts Schools](https://www.martialytics.com/blog/best-practice-management-software-for-martial-arts-schools) - Discover the best practice management software to streamline your martial arts school. Compare featu...

10. [What Makes the Best Martial Arts Management Software?](https://sparkmembership.com/what-makes-the-best-martial-arts-management-software/) - Good martial arts software solves real problems. Prioritize features like easy class scheduling, has...

11. [The 5 Best Martial Arts Management Software Ranked - Fitune](https://www.fitune.io/post/the-5-best-martial-arts-management-software-ranked) - Find the best software to help you manage your martial arts school.

We went over hundreds of user r...

12. [Best Martial Arts Software for Schools in 2026 — Master K](https://www.masterk.ai/blog/best-martial-arts-software-for-schools-in-2026) - School owners need software that helps them follow up with leads, retain students, manage billing, t...

13. [Belt promotions made simple with the ideal martial arts CRM software](https://zenplanner.com/blogs/belt-promotions-made-simple-with-the-ideal-martial-arts-crm-software/) - Learn how Zen Planner's ideal martial arts CRM software automates belt promotions with progress trac...

14. [Martial Arts Belt Tracking Simplified | Zen Planner](https://zenplanner.com/blogs/digital-belt-tracking-capabilities/) - Zen Planner offers belt tracking and automation tools to ensure your students are always tested on t...

15. [Martial arts belt tracking system - Mindbody Support](https://support.mindbodyonline.com/s/article/203259753-Martial-arts-belt-tracking-system) - This feature lets you assign belts (eg, white belt, yellow belt) to clients, set up requirements for...

16. [Best Martial Arts Software - 2026 Reviews & Pricing](https://www.softwareadvice.com/martial-arts/) - Find the best Martial Arts Software for your organization. Compare top Martial Arts Software systems...

17. [Best Martial Arts Software 2026 - Capterra](https://www.capterra.com/martial-arts-software/) - Find the top Martial Arts software of 2026 on Capterra. Based on millions of verified user reviews -...

18. [Belt Ranking & Promotions System | Martial Arts Software](https://blackbeltcrm.com/belt-ranking-and-promotions-system/) - Track every rank and run every exam inside one system. Black Belt Membership Software handles belt p...

19. [15 Best Bootstrapped SaaS Niches for Solo Founders 2026](https://entrepreneurloop.com/bootstrapped-saas-niches-solo-founders/) - Discover 15 profitable bootstrapped SaaS niches perfect for solo founders. Validated low-investment ...

20. [How AI is Reshaping Vertical SaaS - Grant Thornton | Stax](https://www.stax.com/insights/how-ai-is-reshaping-vertical-saas) - AI is driving a bifurcation between surface-layer productivity tools and core operational platforms ...

21. [Pricing & Fees | Supabase](https://supabase.com/pricing) - Free · Unlimited API requests · 50,000 monthly active users · 500 MB database size. Shared CPU 500 M...

22. [Best Database Software for Startups and SaaS (2026) - MakerKit](https://makerkit.dev/blog/tutorials/best-database-software-startups) - The best database for a startup building web-based SaaS in 2026 is Supabase. It combines PostgreSQL ...

23. [CRM for Martial Arts Schools | SchedulingKit](https://schedulingkit.com/crm-for-service-businesses/martial-arts) - A martial arts CRM tracks student belt rank, testing history, attendance, membership tiers, and fami...

24. [Best Purchase Order (PO) System for Small Businesses in 2025](https://www.procuredesk.com/po-system-for-small-business/) - The Procurement Cloud includes features to set approved vendors, budgets, and purchasing guidelines;...

25. [Martial Arts School CRM & Student Management Software](https://efconline.com/features/crm-student-management) - Track every student from first inquiry to black belt. Manage leads, schedule classes, track attendan...

26. [What Is Martial Arts Membership Software and How It Helps Dojos](https://blackbeltcrm.com/what-is-martial-arts-membership-software/) - Belt Promotion Tracking: Manage multiple styles, ranks, and testing ... Its three main features are ...

27. [How to Pick the Best Martial Studio Software](https://www.thestudiodirector.com/blog/how-to-pick-the-best-martial-arts-studio-software/) - In this guide, we'll discuss everything you need to know when picking the best martial arts studio s...

28. [Supabase Pricing in 2026: Plans, Free Tier Limits & Full Breakdown](https://uibakery.io/blog/supabase-pricing) - Free projects pause after one week of inactivity, and you're limited to two active projects. What ar...

29. [Newbie Free-tier Question : r/Supabase - Reddit](https://www.reddit.com/r/Supabase/comments/1pc261e/newbie_freetier_question/) - The Supabase free tier is limited to 2 active projects total, regardless of how many organisations y...

30. [neondatabase/neon: Neon: Serverless Postgres. We ... - GitHub](https://github.com/neondatabase/neon) - Neon is an open-source serverless Postgres database platform. It separates storage and compute and s...

31. [Supabase vs Neon: Serverless Postgres Compared (2026)](https://www.getautonoma.com/blog/supabase-vs-neon) - Supabase vs Neon compared honestly. BaaS with auth, storage & realtime vs pure serverless Postgres w...

32. [How to use 100$ credits efficiently to deploy application?](https://learn.microsoft.com/en-us/answers/questions/5830487/how-to-use-100-credits-efficiently-to-deploy-appli) - I want to deploy a web application both backend and database and I have github student education pac...

33. [Deploy a Python FastAPI Web App with PostgreSQL - Azure.cn](https://docs.azure.cn/en-us/app-service/tutorial-python-postgresql-app-fastapi) - In this tutorial, you deploy a data-driven Python web app (FastAPI) to Azure App Service with the Az...

