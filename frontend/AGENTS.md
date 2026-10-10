# Frontend Agent Guide

This package is the Koaryu Next.js App Router frontend.

Use this file for work under `frontend/`. Fall back to the repo root `AGENTS.md` for shared rules.

## Path Guide

- `src/app/`: App Router pages, layouts, route handlers, metadata, and page-level loading/error states
- `src/components/`: shared UI, shells, navigation, marketing, dashboard components
- `src/lib/`: stores, constants, Supabase helpers, proxy helpers, CSV/performance utilities
- `src/types/`: shared frontend types
- `tests/`: Node-based frontend tests

## Stack

- Next.js `16`
- React `19`
- TypeScript
- Node.js `22.13+` for local frontend scripts and Node test runner type stripping
- Tailwind CSS `4`
- ESLint `9`

## Core Commands

- Install deps: `cd frontend && npm install`
- Start dev server: `cd frontend && npm run dev`
- Lint: `cd frontend && npm run lint`
- Lint specific files: `cd frontend && npm run lint -- src/path/to/file.tsx`
- Format authored files: `cd frontend && npm run format`
- Check authored file formatting: `cd frontend && npm run format:check`
- Test: `cd frontend && npm run test`
- First test setup on a fresh machine: `cd frontend && npx playwright install chromium` for mounted lifecycle tests. Linux CI uses `--with-deps`.
- Workflow preview catalog: from the repo root run `npm run generate:workflow-preview-catalog` after changing the pure backend catalog, then `npm run check:workflow-preview-catalog`. Preview uses this generated snapshot with sample references and disabled live actions.
- Live-mode workflow regressions (synthetic auth/I/O, no external data): `cd frontend && node --experimental-strip-types --test tests/workflow-stabilization-mounted.test.mjs`
- Preview smoke e2e: `cd frontend && npm run test:e2e:preview-smoke` against a running preview-mode frontend
- Landing page checks: `cd frontend && npx playwright test e2e/marketing-landing.spec.ts --workers=1` against a loopback frontend; release CI runs it on a preview build. Covers paging by wheel, keys and swipes, the day timeline's panel, the hand-off to the native page, still frames under reduced motion, the masthead on phones and desktop, the phone menu and in-page link history. Stops and still frames come from `landingPageContent.story`; flicks wait out `MOMENTUM_STALL_MS` so the gesture reducer reads each one as a new gesture.
- Linked marketing-page checks: `cd frontend && npx playwright test e2e/marketing-pages.spec.ts --workers=1` against a loopback frontend. Covers the 11 marketing guides, permanent redirects from Explore/About/the family guide, unknown-slug 404s, useful link and download outcomes, mobile/desktop overflow, touch targets, navigation without JavaScript, local anchors, and landing/document history. Repeat with `--browser=webkit` for WebKit.
- Build: `cd frontend && npm run build`
- Analyze bundle: `cd frontend && npm run analyze`

The local frontend runs on `http://localhost:4000`.

## Environment

- Copy local env file from the example when needed: `cd frontend && cp .env.example .env.local`
- Required build-time values include `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`, and `NEXT_PUBLIC_SITE_URL`.
- Server-only cron secrets such as `CRON_SECRET` and `ACCOUNT_DELETION_WORKER_SECRET` must never be exposed via `NEXT_PUBLIC_` variables.

If `npm run build` fails with missing Supabase URL or anon key errors, check the current shell environment or `.env.local` first.

## Editing Guidance

- Preserve the App Router structure and existing component organization.
- Keep `next` and `eslint-config-next` aligned when changing framework versions.
- Avoid editing `frontend/.next/`.
- Prefer focused fixes over broad UI rewrites unless requested.
- Keep the public landing page behavior intact unless the task is specifically about auth or warmup routing.
- The landing page has two acts on one real document. Act one is a paged story over an illustrated SVG scene: five one-screen chapters (`landingPageContent.story`: the hero in the hills, the belt tracker in the dojo, the day timeline through the door, "Your studio is not a spreadsheet." on the gathering clouds, its words at the bottom left under a clear sun as on v13's sky stop, the seated class) separated by open interludes. The hill's brown and the sky are passages, not stops: one dive runs from the hills through the brown into the dojo, one flight runs from the door across the sky into the clouds, (`via` keyframes in `STORY_BEATS`), and the clouds dissolve straight into the risen room on the way to the class: a `cut` beat snaps the camera across under a still of the clouds, which then dissolves into the room as the class files in (`storyCuts`/`cutCover`, `CUT_DISSOLVE`), so the weave between is never played. The still is a second `JourneyScene` in `.sceneCover`, built once the page is idle (never in the server HTML) and `display: none` except from the moment the reader leaves the clouds until it has dissolved. Owner feedback (2026-10-07): too much happened between the clouds and the class with nothing added, so keep that turn short; a dip to the paper ground in between read as a flash; never add a stop that only holds a slogan over empty art. One wheel, swipe or key gesture moves one chapter: `journey-controller.tsx` intercepts input in the story only and animates the document scroll between stops along curves planned in `journey/paging-model.ts` (production's gesture reducer: threshold, momentum coalescing, deliberate-swipe detection; beats sized per chapter in `STORY_BEATS`); the scene follows the scroll position through `storyKeyframes`, so scrollbar drags scrub and settle on the nearest stop. A chapter taller than the screen (the timeline) scrolls natively inside its own `[data-panel]`; at its edge the next gesture pages. The weave is currently skipped by that cut; its code is kept. The weave (`weave-loom.tsx`, geometry and timing in `weave-model.ts`) sits inside the scene layer, under its paper grain, and covers the scene's cloud-to-plank morph in the same cut-paper language as the rest of the art (flat strips, hand-cut edges, offset shadows, no gradients or rounded ends): the clouds flatten into streaks that are pulled in as seven plain cream strips (no names: it is a passage, and the one-record line lives on the clouds), kraft strips are threaded up through them over and under, then the mat lies down, the wall stands up behind it and the room's floor is laid over it far to near (wipes built from opposed transforms, never a dissolve) before the class slides in from the wings. During the hand-off the controller hides copy wherever the picture's edge or frame passes (`copyClearance`). After the class sits, the last page turn hands the scene off into a timber-framed picture (`handoffGeometry`) and act two (`landing/page-sections.tsx`: pricing, the /try miniature, FAQ, the close with the hills) scrolls natively; scrolling back up (wheel, keys, a fling's momentum) comes to rest on the frame (`landOnFrame`) and the next gesture re-enters the story. The scene and its frame stand on one sticky `.stage` inside `.stageDock`, which the controller ends one screen below the hand-off stop, so the browser holds the picture through the story and lets it go exactly where the copy's pin does: after the hand-off the picture leaves with the page on the native scroll. Never move the picture from script to follow the scroll (a rAF-driven offset trails the compositor and shakes). On phones the masthead stays through the hand-off and steps aside only once the page is read downward. The day timeline's panel starts below the masthead (`--journey-bar`, the bar as drawn) so its cards never run under it. Only the masthead's own menu (`details`) suspends wheel paging, never an open FAQ answer. Reduced motion jumps between stops and shows still frames. When capturing mid-turn frames in Chromium, use a raw CDP `Page.captureScreenshot` (no clip) and Playwright's paused clock: `page.screenshot` computes its clip before capturing, so a page scrolling under rAF shows a false blank band at the top. Chapter copy is held at its resting place and faded by the controller's frame loop (`copyReveal`), in the same frame as the scroll it compensates, so it never slides across the art on any engine (compensating transforms in scroll-driven CSS lag on iOS); it fades in once the scene has settled and out before the next scene moves. The timeline's ink and moments, and the belt line, stay CSS scroll-driven animations gated on `@supports (animation-timeline: view())` and `prefers-reduced-motion: no-preference`, with complete static fallbacks; the features panel has end room so its last moment activates before the next gesture pages on. The scene and the loom render once and write per-frame attributes; never drive them through React state. The loom skips attributes that have not changed since the last frame it actually drew, so a page opened on the class still draws every strip when paged back. Check every stop and turn at a short laptop window (1000x614) as well as 1440x900: the scene frames shorter windows higher, which is where the sun met the masthead. Day and night: `scene-time-script.tsx` sets `html[data-scene]` before first paint from Pacific time (`journey/scene-time.ts`, night 19:00-05:59 America/Los_Angeles); `?scene=night` or `?scene=day` forces either for review. Style night with `:global(html[data-scene="night"]) .localClass` and the `--scene-*` tokens in `journey/scene-tokens.css`. Each moment of the day timeline shows a crop of the real screen that handles it (`public/marketing/product/day-*.webp`, regenerated with `scripts/capture-landing-day-shots.mjs` against a `NEXT_PUBLIC_PREVIEW_MODE=true` server); phones keep each crop in its moment's column, under its words and clear of the timeline's line, as large as the column allows and at most 0.74 of its size (owner feedback 2026-10-07: crops pulled left over the line and fading off the right edge looked misaligned). Each shot's `corner` is the radius of the rounded corners its crop keeps; the frame rounds just outside it as a share of the print, so the app's backdrop never shows at any scale. The offer is the product's own: one 30-day Koaryu Core trial per new studio, with payment details collected at Stripe Checkout (`PUBLIC_PLATFORM_TRIAL_DAYS`); never promise "no card required", and say no more about cancellation than that it is self-serve. Every sign-up action reads "Start free trial", the demo is "Try the demo" (nav: "Demo"), and the shared marketing header carries the trial button. Don't reference customers, testimonials or usage numbers until the owner supplies real ones. Selling chapters say what Koaryu does; current limits (tuition activation, exports, staff access, multi-location, reminders) live once in the FAQ "Current limits" and "Pricing & payments" groups. Keep retired hashes mapped in `scroll-model.ts`. Scene materials are baked textures; after changing a filter in `scripts/generate-journey-textures.mjs`, rerun it from `frontend/`; the dojo's paper lays `washi-shade.webp` (the shade the grey washi casts under multiply) with normal blending. Keep `will-change`, CSS transforms and multiply blends out of the scene SVG: they split the camera-scaled dojo into dozens of compositor layers that Chrome keeps rastered at the dive's zoom, so after a trip through the door and back the tab held 544 MB of tiles, over Chrome's 512 MB budget, and the day sheet lost its background (owner screenshot, 2026-10-07; 90 MB since). Check tile memory with a memory-infra dump in headed Chrome, and a tight budget with `--force-gpu-mem-available-mb`; headless screenshots never show missing tiles; regenerate stills (day and `--scene night`) with `scripts/generate-landing-art.mjs`. Recapture `public/marketing/product/*.webp` from preview mode when the product UI changes materially.
- `/try` (`src/app/try`, `components/marketing/try/`) is the hands-on miniature of Koaryu as its own page, linked from the landing hero, the nav and the landing's "Try it" section; it mounts `SceneTimeScript` so it follows the same day/night switch, and makes no network calls.
- Linked marketing guides use normal document scrolling and server-rendered page-specific layouts in `feature-pages` and `workflow-pages`. Keep their shared document header/footer and baked paper texture scoped to `public-pages`; do not change the landing journey through shared styles. Label illustrative product records and preserve current tuition-activation, export, and staff-access limits.
- `/terms` and `/privacy` live in the `src/app/(legal)` route group, whose layout keeps the site chrome and the document switch mounted so the switch's thumb slides between them; both render through `components/marketing/legal-document.tsx`. Print styles lay tables, grids and lists out as plain blocks, because Chromium printed the next paragraph over a table row at a page break and WebKit breaks grids badly; check print changes with a real PDF from both engines. their dates, revision history and contact inbox live in `src/lib/legal-documents.ts`. Every statement must match what the product does today: the provider table matches `docs/services.md`, the cookie table matches the cookies and storage keys the app sets, and price, trial and Koaryu Payments fee come from `src/lib/constants.ts`. A substantive change gets a new `effective` date and a revision entry. Sign-up and login show `LegalConsentNotice`; keep it beside the account-creating actions.
- When touching `src/app/api/` or proxy code, verify secrets stay server-side and response headers still match current safety expectations.
- When touching dashboard pages, preserve partial-loading and preview/live-mode behavior unless the task explicitly changes it.
- Dashboard pages own their cold-load placeholders. Use `useRetainedState` only for successful presentation data scoped by resource/filter/date; preserve request ownership and authoritative access checks. Cached data must not enable mutations before fresh verification. See the dashboard loading section in `README.md`.

## Common Tasks

- New page or route segment: add the route under `src/app/`, keep metadata and navigation consistency in mind, and update related shared components only if needed.
- Shared UI change: prefer editing the underlying component in `src/components/` instead of duplicating page-local markup.
- Utility or data-shaping change: add or update a focused test in `frontend/tests/` when the code is not purely presentational.
- Proxy or auth-adjacent change: review nearby middleware/proxy behavior and run a full `npm run build` before sign-off.

## Verification

- For targeted UI changes, run lint on the touched files first.
- For utility changes with existing test coverage patterns, run `cd frontend && npm run test`.
- Run `cd frontend && npm run build` before signing off on changes that affect routing, middleware, auth bootstrapping, or environment-dependent pages.
- When changing login, dashboard, settings, billing, or proxy behavior, also review the expectations documented in `frontend/README.md`.

## Done Checklist

- Lint the touched frontend files at minimum.
- Run tests for touched utilities/helpers when applicable.
- Run a full build for routing, auth, proxy, or environment-sensitive changes.
- Keep `frontend/README.md` or related runbooks in sync if the workflow materially changed.

## Important References

- Package overview: `frontend/README.md`
- Performance rollout notes: `docs/performance-rollout.md`
- Deployment expectations: `docs/render-backend-deployment.md`

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
