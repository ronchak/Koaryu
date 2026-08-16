# Koaryu Design Language

Status: authoritative marketing and public-site design specification
Last reconciled with the approved Koaryu Journey prototype: 2026-08-16
Applies to: the public marketing site, marketing route templates, public navigation, pricing, FAQ, legal pages, and brand-facing product presentations

## 1. Purpose

Koaryu should feel calm, tactile, specific to martial arts studios, and confident enough to stay out of its own way.

The approved Koaryu Journey prototype establishes the visual direction. This document turns that prototype into a portable system so production pages do not depend on copying one standalone HTML file or improvising from screenshots.

The design language is broader than the landing page's choreography:

- The landing page may use a fixed cinematic scene, chapter stops, and one-scroll navigation.
- Feature, use-case, Explore, About, pricing, legal, and other public pages should use ordinary document scrolling.
- All public pages should share the same palette, typography, materials, composition, component grammar, motion restraint, and writing voice.
- The authenticated product may inherit brand tokens and typographic restraint, but it should remain optimized for operational density. Do not turn the dashboard into a cinematic marketing page.

## 2. Brand character

Koaryu is:

- Calm, not sleepy.
- Confident, not grandiose.
- Martial-arts-native, not decorated with martial arts clichés.
- Tactile, not photorealistic.
- Minimal, not empty by accident.
- Wry, not flippant about an owner's work.
- Operational, not dashboard theater.

The emotional target is a well-kept dojo before the first class: quiet, prepared, warm, and purposeful.

## 3. Old site to new site

| Layer | Previous marketing language | Koaryu language |
| --- | --- | --- |
| Surface | Dark SaaS panels, dot grids, accent glows | Warm paper, ink, wood, woven material, restrained physical texture |
| Composition | Centered containers and repeated card grids | Editorial asymmetry, one focal idea, deliberate negative space |
| Information density | Several modules compete in one viewport | One dominant thought with clearly subordinate proof |
| Cards | Generic bordered software cards and hover lift | Opaque paper planes, ledger rows, bands, rules, and lists |
| Typography | Conventional SaaS hierarchy | Large, tight statements paired with quiet human-scale copy |
| Imagery | Dashboard previews and generic interface symbols | A cut-paper dojo world and product information treated as artifacts |
| Motion | Generic reveal effects | Motion that represents travel, opening, gathering, settling, or a state change |
| Voice | Professionally descriptive | Direct, specific, lightly sassy, and grounded in studio life |
| Navigation | Application-like glass header | Minimal, legible, paper-native public navigation |
| Interaction | Repeated hover decoration | Small responses that confirm meaning or location |

## 4. Core principles

### 4.1 One idea owns the frame

Every viewport or major section needs one obvious entry point. Supporting copy, proof, and actions must be visibly subordinate.

Two statements at the same scale create two headlines and should be treated as a composition failure.

### 4.2 Negative space is structural

Empty space should establish hierarchy, timing, or a reading path. It must not look like content failed to load or a card was removed.

Use a shared axis, datum rule, material edge, or scene relationship to make the space intentional.

### 4.3 Materials replace decoration

Paper fibre, crumple, shoji paper, wood, tatami, woven bamboo, and soft pigment variation provide visual richness. Do not compensate with gradients, glass, floating pills, icon clusters, or unnecessary ornaments.

### 4.4 Product information should feel handled

Features, use cases, pricing, routes, and FAQs should appear as ledgers, bands, maps, statements, or sheets. They should not default to interchangeable SaaS cards.

### 4.5 Motion must explain something

The camera falls through layered mountains, a ridge becomes a ceiling, doors open, clouds gather, and a weave settles into a floor. These are connected transformations.

Do not add motion solely because an element entered the viewport.

### 4.6 Personality belongs in the sentence

The visual system stays calm enough for a dry line such as “One student record. Imagine that.” to land. Do not add decorative comedy around already-personal copy.

## 5. Canonical color system

The canonical palette is intentionally narrow. These are the colors that should become production design tokens.

| Token | Value | Use |
| --- | --- | --- |
| `paper` | `#F7F3E9` | Primary public-site background and lightest environmental field |
| `ink` | `#3B2F1C` | Primary type, rules, control outlines, and dark marks |
| `ink-light` | `#F4EEE1` | Type and controls over deep brown |
| `sheet` | `#F2E9D8` | Primary paper plane and mobile navigation surface |
| `card` | `#FBF7EE` | Light raised paper surface, used sparingly |
| `card-alt` | `#E9DDC8` | Secondary paper plane and warmer statement surface |
| `deep-brown` | `#493718` | Dark transition panel and framed light-copy surface |
| `beam` | `#56431F` | Dojo beam, nearest ridge, and environmental dark mass |
| `beam-light` | `#6B5230` | Secondary dark wood and post highlight |
| `wood` | `#9B7E4F` | Medium structural wood |
| `wood-pale` | `#C6B183` | Light wood and small structural detail |
| `line` | `rgba(59, 47, 28, 0.18)` | General quiet division |
| `rule` | `rgba(59, 47, 28, 0.28)` | Strong paper-plane boundary |
| `rule-soft` | `rgba(59, 47, 28, 0.14)` | Internal rows and secondary separation |

Recommended production variables:

```css
--koaryu-paper: #f7f3e9;
--koaryu-ink: #3b2f1c;
--koaryu-ink-light: #f4eee1;
--koaryu-sheet: #f2e9d8;
--koaryu-sheet-raised: #fbf7ee;
--koaryu-sheet-warm: #e9ddc8;
--koaryu-deep-brown: #493718;
--koaryu-beam: #56431f;
--koaryu-beam-light: #6b5230;
--koaryu-wood: #9b7e4f;
--koaryu-wood-pale: #c6b183;
--koaryu-line: rgb(59 47 28 / 18%);
--koaryu-rule: rgb(59 47 28 / 28%);
--koaryu-rule-soft: rgb(59 47 28 / 14%);
```

### 5.1 Color behavior

- Use `ink` on `paper`, `sheet`, `card`, and `card-alt`.
- Use `ink-light` on `deep-brown`, `beam`, and other sufficiently dark environmental fields.
- Prefer brown-tinted shadows. Pure black is reserved for filter math or extremely low-opacity vignette work.
- Pure white may appear only as low-opacity environmental light or paper highlights. It is not a general UI surface.
- Avoid blue, purple, neon green, and multicolor product accents on the public site unless a future brand decision explicitly adds them.
- Do not make every scene color a UI token. The extended palette below belongs to illustration and material work.

### 5.2 Token boundary

The production application already has shared `--bg`, `--surface`, `--border`, `--text-*`, and `--accent` tokens in `frontend/src/app/globals.css`. Those tokens are product-owned and must remain unchanged during the marketing migration.

Define the `--koaryu-*` palette on a route-scoped marketing shell such as `[data-koaryu-marketing]`, not on `:root`, `html`, or the global application `body`.

Rules:

- Public marketing components stop consuming the product aliases `bg-bg`, `bg-surface`, `text-text-primary`, `text-text-secondary`, `border-border`, and `text-accent` for brand presentation.
- Marketing components use scoped `--koaryu-*` variables or marketing-specific Tailwind aliases backed by those variables.
- Authenticated dashboard, authentication, onboarding, and operational UI continue using the existing product tokens.
- The fibre veil described in §7.2 is attached to the same marketing shell scope.
- A marketing page rendered outside the scoped shell is an implementation error, not a reason to redefine global tokens.

## 6. Extended scene palette

### 6.1 Mountains and landscape depth

| Role | Value |
| --- | --- |
| Pale mountain sky | `#F3F1EA` |
| Furthest ridge | `#EFE2C0` |
| Far ridge | `#E7CC97` |
| Middle ridge | `#C9A75E` |
| Near-middle ridge | `#A28341` |
| Near ridge | `#7A612E` |
| Nearest ridge / dojo ceiling | `#56431F` |
| Distant post-door ridges | `#D9C7A6`, `#C9B492`, `#B49C78` |

### 6.2 Shoji and paper architecture

| Role | Value |
| --- | --- |
| Shoji paper | `#E6E2DA` |
| Shoji shadow | `#D3CFC7` |
| Shoji gradient top | `#F3EFE5` |
| Shoji gradient middle | `#E8E2D6` |
| Fixed panel paper | `#EFECE5` |
| Hanging scroll paper | `#EDE7D8` |
| Washi noise pigment | `#8B7B60` |

### 6.3 Tatami and floor

| Role | Value |
| --- | --- |
| Tatami base | `#C1AA76` |
| Tatami light | `#CFBA8E` |
| Tatami dark | `#A98F5C` |
| Tatami edge | `#E3D6B4` |
| Floor transition tones | `#E2CAA2`, `#D9BD95`, `#CFB086`, `#C4A47A`, `#B7956C` |

### 6.4 Open sky and sun

| Role | Value |
| --- | --- |
| Sky high | `#F6E9CD` |
| Sky middle | `#EDD9B2` |
| Sky low | `#DEC79F` |
| Sky highlight stop | `#FCF4E2` |
| Sun | `#CDB389` |
| Sun light | `#DBC49E` |
| Glow center | `#FFF6E0` |
| Glow middle | `#FBEBCB` |
| Glow edge | `#F6E3BD` |

### 6.5 Clouds, bamboo, and woven transition

| Family | Values from light to dark |
| --- | --- |
| Cloud paper | `#F4E7CC`, `#EBD9B9`, `#E1CBA5`, `#D4B992`, `#C4A47C` |
| Bamboo | `#E1C99E`, `#D7BC90`, `#CBAE82`, `#BEA075`, `#B09068` |

### 6.6 Interior room

| Role | Value |
| --- | --- |
| Wall high | `#DED7CF` |
| Wall transition | `#D3C9C0` |
| Wall low | `#C4BAB0` |
| Baseboard | `#B7ACA1` |
| Switch face | `#EDEAE4` |
| Switch inset | `#DAD4CB` |

### 6.7 Human figures

| Role | Values |
| --- | --- |
| Gi | `#F3F0E9` |
| Gi shadow | `#DCD5C8` |
| Belt | `#241F1B` |
| Skin tones | `#EBCDB1`, `#5E4231`, `#C5945A`, `#B08E2A`, `#9E6642` |
| Figure ground shadow | `#7C6748` at low opacity |

### 6.8 Shadow and vignette helpers

These values are scene-only and should remain subordinate:

- `#3A2C14`: warm vignette.
- `#4A3A1C`: small lifted-paper shadow.
- `#EFEADD` and `#FBF8F0`: mountain-sky gradient support.
- `#FFFFFF`: low-opacity cloud light only.
- `#000000`: filter and gradient math only.

The `stillness` chapter adds the one sanctioned full-frame closing wash:

- Center light: `rgba(248, 225, 179, 0.42)` (`#F8E1B3`).
- Middle warmth: `rgba(123, 86, 35, 0.08)` (`#7B5623`) at `44%`.
- Outer shade: `rgba(48, 34, 18, 0.18)` (`#302212`).
- Center position: `52% 58%`.

This is environmental light, not a UI gradient or reusable card treatment.

## 7. Material system

### 7.1 Paper is a field, not a background image

The prototype combines several quiet layers:

1. A flat base color.
2. Broad pulp variation.
3. Fine fibre.
4. A subtle vignette.
5. Scene-specific material such as crumple or washi.

No single layer should look like a stock texture. The material should be felt before it is consciously inspected.

### 7.2 Global fibre veil

The journey uses a fixed multiply veil at `0.095` opacity with anisotropic fractal noise:

- Pattern coordinate space: `180 × 180`.
- Base frequency: `0.035 0.72`
- Octaves: `3`
- Seed: `41`
- Source opacity: `0.42`
- Desaturation: `<feColorMatrix type="saturate" values="0"/>` between turbulence and output.

The veil scales to the marketing shell's box while its frequency remains defined in the `180 × 180` coordinate space. Changing that viewBox changes the apparent fibre scale.

In production, scope this layer to the public marketing shell. Do not attach it to the global application `body`, where it would cover the dashboard, authentication, or operational UI.

### 7.3 SVG pulp and fine grain

The scene adds two static multiply layers:

| Layer | Frequency | Octaves | Seed | Desaturate | Alpha slope | Consumer opacity |
| --- | --- | --- | --- | --- | --- | --- |
| Broad pulp | `0.018 0.035` | `2` | `17` | `saturate: 0` | `0.72` | `0.070` |
| Fine grain | `0.68` | `2` | `7` | `saturate: 0` | `0.58` | `0.050` |

For both layers, desaturation occurs after turbulence and before alpha transfer.

These layers never rerender independently and should remain pointer-inert.

### 7.4 Crumpled paper

The brown mountain-to-dojo curtain uses an isotropic crumple rather than directional wood grain:

- Base frequency: `0.0111`
- Octaves: `4`
- Seed: `9`
- Diffuse surface scale: `1.9`
- Diffuse constant: `1.05`
- Distant-light azimuth: `235`
- Distant-light elevation: `58`
- Pattern tile: `360 × 360`
- Final crumple opacity: `0.45`

The pattern is centered back onto the curtain's brown so folds alter light and shade without replacing the base color.

Reproduction-critical filter attributes:

```xml
<filter
  id="crumpleTile"
  filterUnits="userSpaceOnUse"
  x="0"
  y="0"
  width="360"
  height="360"
  color-interpolation-filters="sRGB"
>
```

The diffuse-light result is re-centered with this exact matrix:

```text
0.2067 0.2067 0.2067 0  0.0273
0.1667 0.1667 0.1667 0  0.0127
0.1133 0.1133 0.1133 0 -0.0484
0      0      0      0  1
```

The crumple is part of the transforming brown mass. It begins on the nearest mountain ridge, covers the full problem chapter, then separates with the curtain as the dojo appears. Never mount it as an unrelated page overlay that pops in after the brown transition.

### 7.5 Washi and shoji paper

Shoji surfaces use a directional washi texture:

- Base frequency: `0.026 0.44`
- Octaves: `2`
- Seed: `29`
- Desaturation: `<feColorMatrix type="saturate" values="0"/>` between turbulence and alpha transfer
- Alpha slope: `0.76`
- Pattern tile: `220 × 220`
- Pattern pigment: `#8B7B60` at `0.24` opacity
- Typical multiply opacity: `0.66–0.82`

The `0.24` value belongs to the pigment inside the reusable pattern. The `0.66–0.82` range belongs to each surface consuming that already-dimmed pattern. Do not apply the consumer opacity directly to an undimmed `#8B7B60` fill.

Washi belongs to paper architecture such as doors, transoms, and scrolls. Do not apply it indiscriminately to every content panel.

### 7.6 Material anti-patterns

Do not use:

- Photographic paper scans.
- Tea stains, burned edges, ink splatters, or costume-Japanese ornament.
- Wood grain where the intended material is paper.
- Lens flares or glowing fibre knots.
- Texture strong enough to reduce text contrast.
- Continuously animated grain.
- A different paper texture on every component.

## 8. Typography

### 8.1 Font family

Primary stack:

```css
-apple-system,
BlinkMacSystemFont,
"SF Pro Display",
"Helvetica Neue",
Inter,
"Segoe UI",
Roboto,
sans-serif
```

The production site already uses Inter. Keep it as the reliable web fallback while preserving the system-first feel on Apple platforms.

The marketing language does not require a decorative Japanese typeface, brush font, or serif display face.

### 8.2 Type roles

| Role | Prototype specification | Use |
| --- | --- | --- |
| Default story H1 | `clamp(58px, 10.5vw, 150px)`, weight `720`, tracking `-0.045em`, line height `0.88` | Fallback full-frame primary statement |
| Default story H2 | `clamp(30px, 4.4vw, 62px)`, weight `660`, tracking `-0.032em`, line height `1.02`, maximum `17ch` | Fallback chapter heading |
| Hero | `clamp(60px, 7.5vw, 114px)`, weight `720`, tracking about `-0.045em`, line height `0.88` | Landing's singular opening statement |
| Large editorial statement | Up to `96px`, weight `660`, tracking `-0.04em`, line height `0.9` | Problem and major transition statements |
| General chapter heading | `clamp(42px, 6.8vw, 92px)`, line height `0.94` | Cinematic chapter titles |
| Paper-plane heading | `clamp(34px, 3.5vw, 50px)`, weight `675`, tracking `-0.044em`, line height `0.94` | Features, pricing, route maps, statements |
| Price figure | `clamp(74px, 9vw, 124px)`, weight `720`, tracking `-0.07em`, line height `0.78` | `$27` pricing anchor |
| Supporting lede | `clamp(14px, 1.45vw, 19px)`, weight `470`, line height `1.55`, opacity about `0.76` | One short supporting thought |
| Eyebrow / kicker | `10–12px`, weight `720–730`, uppercase, tracking `0.14–0.26em`, opacity at least `0.72` on light paper | Category and context |
| Row heading | `13px`, weight `710`, tracking `-0.01em` | Ledger, statement, and use-case rows |
| Row body | `12–13px`, weight `450–500`, line height `1.42–1.5`, opacity about `0.72` | Compact proof and detail |
| Navigation | `12px`, weight `620`, tracking `0.04em` | Header and footer links |

### 8.3 Hierarchy rules

- One display-scale statement per composition.
- Supporting text should not imitate the headline's size, weight, or measure.
- Tight display leading is intentional. Body leading remains generous.
- Use opacity to quiet secondary copy only after checking the composited color against its actual surface.
- On light paper surfaces, normal text below large-text thresholds should use at least `0.72` of `ink` or another color that reaches `4.5:1`.
- On `deep-brown`, normal `ink-light` text should use at least `0.62`, which clears `4.5:1` against the canonical brown.
- Large text may use a quieter value only when it still clears `3:1`.
- Known prototype deviations to correct during the production port include `.kicker`, `.route-row em`, inactive `.faq-index-button`, `.copyright`, `.final-links`, light-surface `.price-period`, `.price-fact strong`, and `.hint`. This list is not a substitute for checking every composited color against §20. Decorative rail dots are non-text and need a distinct active and focus state.
- Keep display measures short, generally `9–17ch`.
- Keep body measures around `35–62ch`. An upper-placement transition lede may extend to `72ch` when the line remains subordinate and readable.
- Do not center every heading. Left alignment is the default for product communication.
- Center alignment is reserved for a deliberate final CTA or a genuinely singular statement.

## 9. Composition and layout

### 9.1 Core measurements

- Scene design frame: `1600 × 1000`.
- Scene overscan: `2640 × 2480`, positioned at `-520, -740`.
- Marketing grid maximum: `1180px`.
- General story width: `1080px`.
- Cinematic text width: up to `1180px`.
- Story-region horizontal padding: `clamp(20px, 7vw, 112px)`.
- Paper-plane padding: `clamp(22px, 2.5vw, 32px)`.

### 9.2 Editorial placement

- Favor one anchored plane or text block rather than a symmetric two-column dashboard.
- A right-aligned plane may balance environmental detail, but the text inside remains left aligned.
- Use top and bottom rules to establish a paper plane. A full box border is not the default.
- Let the environment remain visible. Content should not cover more of the scene than it needs.
- If two blocks form a call and response, they need a clear reading path and unequal authority.
- A deliberate void may separate a statement from its response, but both should share a datum, axis, or material relationship.

### 9.3 Paper planes

Approved desktop proportions from the journey:

| Plane | Above `1000px` | `821–1000px` | Placement |
| --- | --- | --- | --- |
| Feature ledger | `min(450px, 42%)` | `min(450px, 52%)` | Left |
| Explore map | `min(500px, 46%)` | `min(500px, 56%)` | Right |
| Pricing sheet | `min(370px, 35%)` | `min(370px, 45%)` | Left |
| About statement | `min(540px, 49%)` | `min(540px, 60%)` | Left |
| Use-case band | Full grid width | Full grid width | Lower horizontal band |
| FAQ shell | `min(560px, 48%)` | `min(560px, 58%)` | Left |

The `821–1000px` tier also reduces story-region horizontal padding to `50px`. On screens at or below `820px`, these planes become full width. Do not preserve a narrow desktop percentage at the cost of legibility.

### 9.4 Radius and shadow

- Standard controls: `7px` radius.
- Framed editorial panels: `8–10px` radius.
- Circular shapes belong to navigation dots, menu buttons, and arrow controls, not generic content cards.
- Typical framed-panel shadow combines a small offset brown shadow with a larger soft ambient shadow.
- Flat paper planes usually use rules without shadow.

Approved shadow pairs:

| Surface | Shadow |
| --- | --- |
| Brown transition panel | `8px 8px 0 rgba(39,28,13,.13), 0 24px 60px rgba(36,24,10,.20)` |
| Framed light-copy panel | `12px 12px 0 rgba(39,28,13,.13), 0 30px 76px rgba(36,24,10,.24)` |
| Final light sheet | `10px 10px 0 rgba(59,47,28,.09), 0 28px 70px rgba(49,36,17,.15)` |
| Mobile navigation | `8px 8px 0 rgba(45,34,18,.08), 0 18px 50px rgba(45,34,18,.15)` |
| Primary button | `0 12px 32px rgba(45,34,18,.14)` |

### 9.5 Cards

Cards are not the default organizational unit.

When a card is truly necessary:

- Use an opaque paper surface.
- Keep texture subtle and continuous with the page.
- Use rules and spacing before shadow.
- Keep corners modest.
- Do not use backdrop blur, glass highlights, glowing borders, or floating translucent layers.

## 10. Component grammar

### 10.1 Header

- Three-part desktop grid: brand, primary navigation, sign-in.
- Brand is small, uppercase, heavily tracked, and confident.
- Links begin around `72%` opacity and become fully opaque on hover.
- Header color follows the environmental field underneath it.
- Mobile uses a small circular menu control and an opaque paper menu.
- The production header should not become a large glass bar.

### 10.2 Buttons

- Minimum interactive height: `44px`.
- Standard padding: approximately `11px 18px`.
- Primary action uses current ink as a solid fill with the opposite paper color for its label.
- Secondary action is transparent with a one-pixel current-color outline.
- Hover movement is limited to `-2px`.
- One clear primary action per composition.
- The primary's approved shadow is `0 12px 32px rgba(45,34,18,.14)`.

### 10.3 Ledger

A ledger is the preferred feature-summary pattern:

- Narrow label column.
- Flexible description column.
- Soft horizontal rules.
- No icon required.
- No independent card around each row.

### 10.4 Horizontal band

Use a band when multiple related workflows need equal, quick comparison:

- One shared paper plane.
- One heading and route action above.
- Internal cells separated by soft rules.
- Five cells may appear across desktop when copy remains compact.
- Collapse to a vertical ruled list on mobile.

### 10.5 Route map

Explore-style navigation uses a vertical route list:

- Human question or intent as the row title.
- One-sentence description.
- Small uppercase destination metadata.
- A simple arrow that shifts no more than `3px` on hover.

### 10.6 Pricing

- Price is the visual anchor.
- `$27` uses display scale, tight tracking, and no pricing-card theater.
- “per studio per month” follows immediately.
- Include only facts that affect a purchase decision.
- Do not brag that table-stakes billing infrastructure is live or tested.
- Do not add artificial tiers, “most popular” labels, strike-through anchors, or countdown urgency.

### 10.7 FAQ

- Topic index stays visually fixed while its active underline slides.
- Topic changes use a small position and opacity transition, not a jump cut.
- The answer plane owns its downward growth. The index must not move when answer lengths differ.
- Answers animate opacity and maximum height without changing horizontal padding or causing line rewrap.
- The prototype caps an open answer at `min(40dvh, 320px)`. Current answers must fit that cap at the narrowest supported width. If copy grows, raise or replace the cap with an intrinsic-height animation rather than clipping text.
- Up and down keys move between topic tabs when focus is in the topic index.
- The FAQ's internal scroll takes priority over chapter navigation while more answer content remains.

### 10.8 Chapter navigation

- One quiet dot per chapter on the right rail.
- Inactive dot: about `4px` at `28%` opacity.
- Active dot: about `6px` at `92%` opacity.
- The prototype uses a `30 × 14px` fine-pointer target and `30 × 16px` on coarse pointers. These are known compact-target deviations. The production port should preserve the tiny visible mark while raising its invisible target to at least `24 × 24px`; prefer `44px` in the horizontal axis and on coarse pointers when the rail still fits.
- Provide previous and next controls plus keyboard and touch parity.
- Dots indicate location; they should not become labeled pills.

## 11. Illustration language

### 11.1 Visual construction

The approved world uses flat vector primitives with restrained gradients and material overlays. It should resemble layered cut paper and architectural illustration, not a photograph or a generic cartoon.

Characteristics:

- One-point dojo perspective.
- Large flat shapes.
- Warm, compressed palette.
- Crisp structural lines.
- Soft paper grain.
- Minimal facial or anatomical detail.
- Objects are included when they establish the dojo: shoji, tatami, beams, posts, a weapon rack, and a hanging scroll.

### 11.2 Scene transformations

The journey relies on continuity rather than unrelated cuts:

1. Layered mountains move downward as the camera falls.
2. The nearest brown ridge covers the frame and becomes the dojo ceiling mass.
3. The brown field splits open to reveal the dojo.
4. The camera approaches the shoji doors before they open.
5. The camera passes through into sky.
6. Clouds fill the frame.
7. Clouds straighten into woven bamboo.
8. The weave settles into a floor.
9. The room and seated students arrive only after the floor is legible.

The same object should transform when possible. Avoid hiding a cut with a flash, full-screen blur, or unrelated overlay.

### 11.3 Illustration anti-patterns

Avoid:

- Generic spheres or abstract SaaS blobs.
- Fake dashboard screenshots.
- Stock martial arts silhouettes.
- Synthetic instructors or people added merely to fill empty space.
- Martial arts symbols used without a specific product meaning.
- Random Japanese characters, seals, calligraphy, or decorative quotation marks.
- Photorealistic textures that break the cut-paper world.
- New decorative inline SVGs that are not part of the approved scene system.

## 12. Motion language

### 12.1 Easing

The journey uses four core curves:

- `easeOut(t) = 1 - (1 - t)^3` for arrivals and early camera travel.
- `easeIn(t) = t^3` for the accelerating mountain fall, curtain climb, and doorway push.
- Quadratic `easeInOut(t) = t < 0.5 ? 2t² : 1 - (-2t + 2)² / 2` for the portal, door, sky, morph, floor, and horizon transformations.
- CSS `cubic-bezier(.16, 1, .3, 1)` for decisive editorial entrances.

Small UI movement often uses `cubic-bezier(.22, .75, .2, 1)`.

The existing production token `--ease-emphasized` already equals `cubic-bezier(.16, 1, .3, 1)` and should be reused. Existing `--motion-medium: 200ms` and `--motion-slow: 280ms` cover common hover and underline timing. Add marketing-scoped tokens only for timings that do not already have a product token, especially scene-scale durations.

### 12.2 Duration hierarchy

| Motion | Duration |
| --- | --- |
| Standard pre-door scene transition | `940ms` |
| Door portal transition | `1260ms` |
| Post-door scene transition | `1100ms` |
| General story-page entrance | `340ms` after `260ms` delay |
| Morning chapter entrance | `200ms`, no delay |
| Problem copy entrance | Delayed to `660ms` so the curtain closes first |
| Chrome color transition | `550ms` |
| Rule draw | `620ms` |
| Closing wash | `900ms` with `cubic-bezier(.16, 1, .3, 1)` |
| FAQ topic group | `220ms` |
| FAQ active underline | `280ms` |
| FAQ answer | `300–420ms` |
| Hover confirmation | `180–200ms` |

### 12.3 Global scene timeline

| Phase | Progress window | Meaning |
| --- | --- | --- |
| Mountains | `0.000–0.100` | Camera falls through layered ridges |
| Drop | `0.100–0.212` | Brown curtain separates to reveal dojo |
| Settle | `0.212–0.288` | Dojo stabilizes |
| Portal dolly | `0.288–0.520` | One uninterrupted camera move toward the doors |
| Door opening | `0.404–0.520` | Doors join the existing dolly after the approach begins |
| Through doorway | `0.516–0.640` | Camera passes through the aperture |
| Open sky | `0.600–0.700` | Exterior settles |
| Clouds gather | `0.660–0.802` | Clouds pour into the frame |
| Cloud-to-weave morph | `0.802–0.892` | Paper clouds straighten into bamboo |
| Weave-to-floor | `0.892–0.952` | Woven field lies down into perspective |
| Students | `0.952–1.000` | Figures arrive after the floor settles |

### 12.4 Chapter stops

Scene phases are not navigation stops. The controller moves between these exact anchors:

| Chapter | Kind | Scene | Ink | Modifiers |
| --- | --- | ---: | --- | --- |
| `welcome` | Hero | `0.025` | Dark | Starts after the mountain scene has already begun |
| `the-problem` | Problem | `0.100` | Light | Copy waits `660ms` for the brown curtain to seal |
| `studio-view` | Morning | `0.235` | Dark | Fast `200ms` entrance, no delay |
| `product` | Product introduction | `0.288` | Light | Framed copy |
| `features` | Feature ledger | `0.520` | Dark | Door portal endpoint |
| `use-cases` | Use-case band | `0.640` | Dark | Doorway traversal endpoint |
| `signals-gather` | Transition | `0.802` | Dark | Kicker and lede |
| `explore` | Route map | `0.892` | Dark | Cloud-to-weave endpoint |
| `class-ready` | Transition | `0.952` | Dark | Upper placement, kicker and lede |
| `pricing` | Pricing sheet | `1.000` | Dark | Scene frozen |
| `about` | Statement sheet | `1.000` | Dark | Scene frozen |
| `faq` | FAQ | `1.000` | Dark | Scene frozen |
| `stillness` | Transition | `1.000` | Dark | Upper placement, closing wash |
| `begin` | Final | `1.000` | Dark | Framed copy |

The last five chapters deliberately share `scene: 1.000`. Type and paper planes advance while the room remains still. Do not distribute those chapters evenly across unused scene progress. The opening anchor is deliberately `0.025`, not zero.

### 12.5 Motion rules

- One scroll gesture advances exactly one chapter.
- A user should not land at a meaningless midpoint.
- Animation may pass through internal visual states, but navigation stops belong to complete compositions.
- Door motion begins after the camera has already started its approach, without a pause or second easing segment.
- Later environmental transitions are slower than early editorial changes.
- Text should arrive after its background is readable.
- Do not loop decorative text or texture animation.
- The opening scroll hint is the only approved ambient bobbing motion, and it disappears after the first chapter.
- The problem-slide ellipsis fades each of its three existing periods once, then stops. It never changes layout.
- The `stillness` closing wash is the single sanctioned full-frame gradient overlay. It reads as changing environmental light and is never reused as a card effect.

## 13. Interaction model

### 13.1 Landing journey

- Wheel and trackpad input accumulate until a small intentional threshold, then advance one chapter.
- Inertial tail events are locked out so one gesture does not skip chapters.
- Arrow Up, Arrow Down, Page Up, Page Down, Space, Shift-Space, Home, and End have explicit behavior.
- A touch swipe needs roughly `40px` of vertical travel.
- Clicking a rail dot navigates directly to that chapter.
- The URL hash identifies the chapter and FAQ topic.

Reference wheel and trackpad tuning:

| Constant | Value | Purpose |
| --- | ---: | --- |
| Gesture accumulation threshold | `14` normalized pixels | Reject tiny trackpad noise |
| Main gesture lock | `260ms` | Consume inertial tail after a chapter advance |
| FAQ-consumed lock | `220ms` | Prevent the same gesture from escaping the FAQ panel |
| New-gesture gap | `115ms` | Treat a sufficiently separated event as a new gesture |
| New-gesture magnitude floor | `max(24, previous × 1.75)` after lock | Distinguish a deliberate second gesture from inertia |
| Line-mode normalization | `delta × 18` | Keep Firefox-style line units usable |
| Page-mode normalization | `delta × viewport height` | Normalize page units |

These values are the current reference implementation, not arbitrary examples. Retune only with real mouse and trackpad evidence.

### 13.2 Secondary marketing pages

Do not reuse the landing page's wheel interception on Features, Use Cases, Explore, About, legal pages, or detail routes.

These pages use normal scrolling with restrained section entrances, clear anchor targets, and conventional browser behavior.

### 13.3 Focus and keyboard

- Default controls receive a visible two-pixel current-color outline with a four-pixel outset.
- Scrollable panels use a two-pixel outline with a three-pixel offset so the ring remains clear of the stable scrollbar gutter.
- Tiny visible marks inside a larger hit area, such as chapter dots, use a one-pixel outline inset by four pixels to avoid colliding with adjacent marks.
- Navigation dots have a visible focus treatment within their enlarged hit area.
- Focusable controls must remain reachable without advancing the chapter.
- Interactive content inside a scrollable panel gets priority over global chapter keys and wheel handling.

## 14. Responsive behavior

Canonical breakpoints from the prototype:

- `1000px`: intermediate tablet widths and plane adjustments.
- `820px`: mobile navigation, full-width planes, simplified bands.
- `560px`: compact display typography and single-column rows.
- `800px` viewport height on desktop: compact vertical density. In the cinematic journey only, the feature ledger, use-case band, Explore map, and About statement hide their supporting ledes so the core content remains inside the fixed story region.
- `700px` viewport height on mobile: the cinematic feature ledger and use-case band hide row descriptions; Explore and About hide supporting ledes. The full information remains available on their linked conventional-scroll routes.
- Coarse pointer: enlarge navigation-dot hit targets.

Responsive priority:

1. Preserve the reading order.
2. Preserve usable type size.
3. Collapse multi-column rows.
4. Remove secondary descriptions only on genuinely short cinematic viewports, never on the corresponding conventional-scroll route.
5. Reduce decorative scene density if needed.
6. Never preserve a desktop composition by making everything tiny.

The SVG frame grows vertically on tall screens rather than cropping away critical horizontal composition. Student spread narrows in portrait layouts.

## 15. Accessibility and resilience

- Decorative SVG scene content is `aria-hidden` and not focusable.
- Marketing meaning remains real HTML text, links, buttons, headings, and lists.
- Interactive targets should be `44 × 44px` where the composition permits. Compact journey marks may use a larger invisible target around the visible mark, but the production floor is `24 × 24px` with adequate separation.
- Active chapter and FAQ state is announced with native attributes such as `aria-current` and `aria-expanded`.
- An `aria-live` region may announce chapter changes without moving focus.
- Reduced motion collapses CSS animations and transitions to near-zero duration.
- The scene controller must also read reduced-motion preference in JavaScript and snap progress directly to its destination without a `requestAnimationFrame` tween.
- Programmatic FAQ and panel scrolling uses `behavior: "auto"` under reduced motion instead of `"smooth"`.
- Delayed invisible elements must be made immediately visible under reduced motion. Reducing duration alone is insufficient when a delay remains.
- The production page must server-render the complete marketing narrative or provide an equivalent semantic document. Do not ship only the active client-side slide to search engines or no-JavaScript users.
- Hash navigation remains meaningful. Chapter and FAQ navigation use `history.replaceState`, not `pushState`, so browser Back leaves the journey instead of replaying every chapter.

## 16. Writing voice

### 16.1 Voice characteristics

- Direct and concrete.
- Relaxed enough to sound like a person.
- Confident in the product and price.
- Specific to instructors, owners, families, classes, ranks, trials, and tuition.
- Occasionally dry or mischievous.
- Respectful of the owner. The joke targets bad tools and awkward workflows.

### 16.2 Approved patterns

Strong examples from the journey:

- “Run the school. Teach the art.”
- “Your studio is not a spreadsheet.”
- “Very convenient! Right up until class starts...”
- “One student record. Imagine that.”
- “Where Koaryu earns its keep.”
- “Start with the headache you already have.”
- “Fill the mats. The price stays put.”
- “If the org chart is three people and a group chat, enterprise gym software is a very weird fit.”
- “Enough admin. Go teach.”

These work because each line is attached to a real operating situation.

### 16.3 Writing constraints

- Keep one thought per headline.
- Supporting copy usually gets one or two short sentences.
- Prefer scenes and mechanisms over claims.
- Preserve conditional language for roadmap items.
- Do not advertise table-stakes expectations such as “Stripe works” or “billing was tested live.”
- Do not invent testimonials.
- Do not call the product “AI-powered.” Koaryu emphasizes predictable records, rules, permissions, and reports.
- Avoid generic SaaS words such as seamless, powerful, robust, revolutionary, all-in-one, or unlock.
- Avoid decorative rhetorical triads written only for cadence. Three concrete operational facts or three genuine product categories are allowed; the morning proof about inactive students, lead replies, and classes is the reference example.
- Avoid stacked rhetorical questions, decorative quotations, and repeated punchlines.
- Avoid em dashes in public copy.
- Do not mistake terseness for personality. A specific useful sentence beats an empty quip.

## 17. Applying the language across public routes

### 17.1 Landing page

Use the complete cinematic journey, chapter navigation, environmental morphs, and scroll stopping.

### 17.2 Feature and use-case indexes

- Use a calm editorial hero, not a miniature journey.
- Replace generic icon cards with a shared ledger, route map, or ruled paper index.
- Use one environmental crop or static scene relationship as an anchor.
- Keep conventional document scrolling.

### 17.3 Feature and use-case detail pages

- Use a short display statement and concrete summary.
- Present proof as a ledger or narrow ruled band.
- Use a strong sticky editorial heading only when it improves scanning.
- Keep body sections readable and semantic.
- Related pages use a route list or shared band, not a grid of floating cards.

### 17.4 Explore

- Organize around visitor intent: “what it does,” “the mess I have,” and “the school I run.”
- Use route-map rows and quiet metadata.
- Let the page function as a directory rather than another sales deck.

### 17.5 Pricing chapter and `#pricing` anchor

- Let `$27 per studio per month` dominate.
- Keep the price flat and visually unambiguous.
- Separate Stripe processing fees in plain language.
- Use a single setup action.
- Pricing is not currently a standalone route. These rules apply to the landing chapter, the `/#pricing` destination, and any pricing block embedded in another public page. Do not create `/pricing` solely to satisfy this guide.

### 17.6 About

- Use an editorial statement surface and a small number of operating principles.
- Keep the focus on independent, one-location schools and daily action.
- Avoid startup biography, founder mythology, or generic mission prose.

### 17.7 Legal pages

- Inherit paper, ink, typography, header, footer, and spacing.
- Use normal document scrolling and excellent text measures.
- Do not add cinematic illustration or playful copy where legal clarity matters.

### 17.8 Studio-type detail pages

- Treat `/studio-types/[slug]` as a detail-page variant framed around the shape of a school rather than one feature or pressure point.
- Use the same paper, ledger, related-route, and conventional-scroll grammar as feature and use-case details.
- Connect family, guardian, trial, rank, and tuition realities without implying that every school of that type runs identically.
- There is no `/studio-types` index route today. Studio-type details are reached through Explore; do not invent an index without a separate navigation decision.

## 18. Production implementation rules

- Keep the Next.js route and metadata boundary server-owned.
- Port the cinematic controller into a focused client component.
- Convert HTM and CDN React to local React 19 TSX.
- Scope fixed positioning, overflow locking, grain, and paper textures to the marketing journey root.
- Reuse shared public navigation and footer data.
- Keep one authoritative content source for pricing, FAQ, features, use cases, and product claims, following §18.1.
- Preserve real route links to Features, Use Cases, Explore, About, signup, login, Terms, and Privacy.
- Server-render all important marketing copy even when only one chapter is visually active.
- Make inactive chapters inert without deleting them from the semantic document.
- Avoid hydration-time dependence on unguarded `window` access.
- Keep generated geometry deterministic.
- Measure animation frame cost on mobile. Reduce scene density before compromising interaction or text.
- Do not add a new production dependency merely to recreate an effect already expressed with CSS or SVG primitives.
- Treat this document as the behavioral contract and the approved prototype as the reference implementation for geometry and controller details. If they diverge, reconcile the document and implementation in the same change.

### 18.1 Content ownership

The production content boundary is:

| Fact class | Authoritative module |
| --- | --- |
| Application identity | `frontend/src/lib/constants.ts` |
| Landing narrative, landing summaries, pricing explanation, and FAQ | `frontend/src/lib/landing-page-content.ts` |
| Feature, use-case, studio-type, and Explore route content | `frontend/src/lib/marketing-pages.ts` |
| Shared public CTA and next-step defaults | `frontend/src/lib/marketing-public-content.ts` |
| Detail-route composition and parent routing | `frontend/src/lib/marketing-detail-route-configs.ts` |

During the journey port:

- Rewrite `landing-page-content.ts` from the approved journey copy and have the journey component import it. Do not place `FEATURE_ROWS`, `FAQ_GROUPS`, pricing facts, or About principles directly inside the component.
- The prototype arrays are migration seed values. They stop being authoritative once the production module is updated.
- Add one exported public platform-price constant in `frontend/src/lib/constants.ts` and derive marketing display strings, structured data, and product fallback copy from it. Live billing responses remain the operational authority whenever they are present.
- Do not add new `$27`, `27`, or `2700` marketing literals outside that constant. Product fixtures may keep explicit fixture values when the number is part of the fixture contract.
- `marketing-pages.ts` remains authoritative for detail-page claims even when the landing page summarizes the same feature. The landing summary should reference or derive from that content rather than silently contradict it.

### 18.2 Hash compatibility

Preserve current chapter IDs and the following legacy aliases during the production port:

| Legacy hash | Current chapter |
| --- | --- |
| `student-path` | `use-cases` |
| `daily-flow` | `use-cases` |
| `studio-signal` | `use-cases` |
| `why-koaryu` | `pricing` |
| `operations` | `about` |
| `privacy` | `about` |
| `data-control` | `about` |
| `doors-open` | `features` |
| `workflow` | `use-cases` |
| `patterns-form` | `explore` |
| `floor-forms` | `class-ready` |
| `operations-trust` | `about` |

Preserve FAQ topic hashes:

| Hash | Topic index |
| --- | ---: |
| `faq-fit` | `0` |
| `faq-switching` | `1` |
| `faq-daily` | `2` |
| `faq-pricing` | `3` |
| `faq-data` | `4` |
| `faq-roadmap` | `5` |

Chapter and FAQ navigation continue to use `replaceState`. Do not turn every chapter into a Back-button entry.

## 19. Prohibited shortcuts

Do not:

- Paste the standalone document, CDN scripts, or global `html, body` rules into the Next.js application.
- Apply the full-page scroll interceptor to the entire public website.
- Reintroduce the old dark SaaS theme inside new paper components.
- Use translucent glass cards as a general solution.
- Build another dashboard mockup to prove the product.
- Add generic spherical graphics, synthetic instructors, stock silhouettes, or filler illustrations.
- Number sections with decorative labels such as “02” or “08” unless the number conveys real order.
- Create separate page-level copies of shared marketing facts.
- Animate texture continuously.
- Hide essential copy on mobile solely to preserve an ornamental composition.

### 19.1 Existing legacy artifacts to retire during migration

The prohibitions above apply to existing code, not only to future additions:

- Retire `frontend/src/components/marketing/product-scene.tsx`, whose dashboard-style scene, blur, and dark surfaces belong to the previous language.
- Remove `.dotGrid` and `.accentStripe` from `frontend/src/components/marketing/public-pages.module.css` after their last public-page consumer is migrated.
- Replace `iconMap` card decoration in `frontend/src/components/marketing/public-pages.tsx` with ledgers, route rows, or another approved information pattern.
- Remove `accent-glow` from marketing headings in `frontend/src/components/marketing/landing-page.tsx`. Do not remove a global utility until non-marketing consumers are checked.
- Replace the `bg-bg/80 backdrop-blur-md` treatment in `MarketingHeader` with the scoped paper-native header.
- Retire the old hero dashboard preview and multicolor preview accents in `landing-page.tsx` when the journey becomes the root experience.

Delete or simplify these artifacts only as their replacements land. Do not leave old and new public shells active in parallel without an explicit route boundary.

## 20. Design QA checklist

Before approving a public page, verify:

### Brand

- Does the page feel warm, tactile, calm, and martial-arts-native?
- Is the wit specific to the workflow rather than pasted onto generic copy?
- Does the page avoid visual clichés and generic SaaS furniture?

### Hierarchy

- Is there one obvious focal statement?
- Is supporting text visibly subordinate?
- Does negative space have a structural reason?

### Material

- Are surfaces opaque and paper-like?
- Is texture subtle enough to preserve contrast?
- Are rules doing work that would otherwise require boxes and shadows?
- Does normal text clear `4.5:1` and large text clear `3:1` after opacity is composited onto the actual paper or brown surface?

### Content

- Is every product claim current and defensible?
- Are price and processor fees unambiguous?
- Have table-stakes claims and unnecessary implementation details been removed?

### Motion

- Does each animation communicate travel, state, hierarchy, or feedback?
- Can a user complete the page with reduced motion?
- Does reduced motion bypass the JavaScript scene tween as well as CSS animation?
- Does one landing-page gesture advance only one chapter?

### Interaction

- Are keyboard, touch, pointer, and browser-history paths coherent?
- Are internal scroll regions allowed to finish before global navigation takes over?
- Are focus states visible against both paper and brown fields?

### Responsive behavior

- Is the reading order preserved at `820px` and `560px`?
- Do short viewports simplify before shrinking important type?
- Are all controls comfortably reachable on coarse pointers?

### Production integrity

- Is important copy present in server-rendered HTML?
- Are design tokens and content shared instead of duplicated?
- Are journey-only global behaviors scoped to the journey route?
- Has mobile frame pacing been measured rather than assumed?

## 21. Authority and change control

This document owns the public marketing design language. The Journey prototype remains visual evidence, but production should implement the rules here rather than import the standalone file wholesale.

When the design evolves:

1. Change the narrowest relevant token, component rule, or motion rule.
2. Validate the change on the landing page, one index route, and one detail route.
3. Update this document in the same change.
4. Do not add a second brand guide with overlapping authority.
