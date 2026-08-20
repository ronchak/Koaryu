import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const layoutSource = source("../src/app/(dashboard)/layout.tsx");
const scopeSource = source("../src/components/dashboard-shell.tsx");
const sidebarSource = source("../src/components/sidebar.tsx");
const accountMenuSource = source("../src/components/account-menu.tsx");
const accountMenuStyles = source("../src/components/account-menu.module.css");
const homeSource = source("../src/components/dashboard/dashboard-home.tsx");
const overviewSource = source("../src/components/dashboard/dashboard-overview-sections.tsx");
const viewModelSource = source("../src/lib/dashboard-widget-view-models.ts");
const contentSource = source("../src/components/dashboard/dashboard-page-content.tsx");
const controllerSource = source("../src/lib/dashboard-page-controller.ts");
const shellStyles = source("../src/components/dashboard-shell.module.css");
const homeStyles = source("../src/components/dashboard/dashboard-home.module.css");
const routeTransitionSource = source("../src/components/dashboard-route-transition.tsx");
const sessionSource = source("../src/lib/store-session-cookies.ts");
const storeSource = source("../src/lib/store.tsx");

describe("dashboard shell and Home source contracts", () => {
  it("provides the skip target, icon-and-text navigation, and a non-duplicative scope band", () => {
    assert.match(layoutSource, /href="#main-content"/);
    assert.match(layoutSource, /id="main-content"/);
    assert.match(layoutSource, /data-koaryu-dashboard-shell="true"/);
    assert.match(sidebarSource, /<ul className=\{styles\.(?:mobileNav|spineList)\}>/);
    assert.match(sidebarSource, /aria-current=\{isActive \? "page" : undefined\}/);
    assert.match(sidebarSource, /const Icon = NAV_ICONS\[item\.icon\]/);
    assert.doesNotMatch(sidebarSource, /padStart|navIndex|\$\{String\(index \+ 1\)/);
    assert.doesNotMatch(scopeSource, /resolveDashboardRouteSlug|slugTitle|routeSlug/);
    assert.match(scopeSource, /aria-label="Current workspace scope"/);
    assert.match(homeSource, /<h1 id="dashboard-home-heading">Dashboard<\/h1>/);
  });

  it("hydrates storage only in an effect after identity and exposes complete controls", () => {
    const effectIndex = homeSource.indexOf("useEffect(() =>");
    const readIndex = homeSource.indexOf("readDashboardLayout(");
    assert.ok(effectIndex >= 0 && readIndex > effectIndex);
    assert.doesNotMatch(homeSource.slice(0, effectIndex), /localStorage|readDashboardLayout\(/);
    for (const label of ["Add panels", "Customize", "Cancel", "Done", "Reset", "Resize", "Remove"]) {
      assert.ok(homeSource.includes(label), label);
    }
    assert.doesNotMatch(homeSource, /Earlier|Later|\bArrow(?:Up|Down)\s*,/);
    assert.match(homeSource, /aria-live="polite"/);
    assert.match(homeSource, /event\.key === "Escape"/);
    assert.match(homeSource, /280/);
    assert.doesNotMatch(homeSource, /elementFromPoint/);
    assert.match(homeSource, /resolveDashboardPointerTarget/);
    assert.match(homeSource, /grabOffsetX/);
    assert.match(homeSource, /widgetPlaceholder/);
    assert.match(homeSource, /setLiftedPreview/);
    assert.match(homeSource, /releaseLiftStyles/);
    assert.match(homeSource, /projectDashboardFrameTargetToStoredCell/);
    assert.match(homeSource, /window\.scrollBy/);
    assert.match(homeSource, /requestAnimationFrame\(tick\)/);
    assert.match(homeSource, /onPointerCancel=\{onPointerCancel\}/);
    assert.match(homeSource, /onLostPointerCapture=\{onLostPointerCapture\}/);
    assert.match(homeSource, /moveDashboardLayoutItem\(/);
    assert.match(homeSource, /updateLayoutInMemory\(\{ \.\.\.layoutRef\.current, items: nextItems \}\)/);
    assert.match(homeSource, /saveLayout\(layoutRef\.current\)/);
    assert.match(homeSource, /keyboardMoveRef\.current/);
    assert.match(homeSource, /event\.key\.startsWith\("Arrow"\)/);
    assert.match(homeSource, /aria-pressed=\{isPickedUp\}/);
    assert.match(homeSource, /aria-label=\{isPickedUp[\s\S]*move picked up[\s\S]*Press Space or Enter to pick up/);
    assert.match(homeSource, /aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Space Enter Escape"/);
    assert.match(homeSource, /keyboardMoveRef\.current\?\.widgetId \?\? dragRef\.current\?\.widgetId/);
    assert.match(homeSource, /is already picked up\. Drop or cancel it before starting another move/);
    const pointerMoveSource = homeSource.slice(
      homeSource.indexOf("const onPointerMove"),
      homeSource.indexOf("const onPointerUp")
    );
    assert.match(pointerMoveSource, /movePointerDrag/);
    assert.doesNotMatch(pointerMoveSource, /saveLayout/);
    const movePointerSource = homeSource.slice(
      homeSource.indexOf("const movePointerDrag"),
      homeSource.indexOf("const finishPointerDrag")
    );
    assert.match(movePointerSource, /reflowDragAtPointer/);
    const dragCommitSource = homeSource.slice(
      homeSource.indexOf("const commitDragTarget"),
      homeSource.indexOf("const reflowDragAtPointer")
    );
    assert.match(dragCommitSource, /updateLayoutInMemory/);
    assert.match(dragCommitSource, /session\.beforeLayout\.items\.map/);
    const pointerUpSource = homeSource.slice(
      homeSource.indexOf("const onPointerUp"),
      homeSource.indexOf("const onPointerCancel")
    );
    assert.match(pointerUpSource, /finishPointerDrag/);
    const finishPointerSource = homeSource.slice(
      homeSource.indexOf("const finishPointerDrag"),
      homeSource.indexOf("const onPointerMove")
    );
    assert.equal(finishPointerSource.match(/saveLayout\(layoutRef\.current\)/g)?.length, 1);
    const pointerCancelSource = homeSource.slice(
      homeSource.indexOf("const onPointerCancel"),
      homeSource.indexOf("const addableWidgets")
    );
    assert.match(pointerCancelSource, /if \(session\.active\) cancelActiveMove\(\)/);
    assert.match(pointerCancelSource, /else clearDragSession\(\)/);
    assert.match(homeSource, /updateLayoutInMemory\(cloneLayout\(session\.beforeLayout\)\)/);
    assert.match(homeSource, /clearDragSession\(\);[\s\S]*snapshotRef\.current = null/);
    assert.match(homeSource, /viewModels\[entry\.id\]\?\.state !== "unavailable"/);
    assert.match(homeSource, /This browser could not save your arrangement/);
    assert.match(homeSource, /isCustomizing && !catalog\.fixed/);
    assert.match(homeSource, /activeDragWidgetId === item\.widget_id/);
    assert.match(homeSource, /chooseDashboardResizeSize/);
    assert.match(homeSource, /clampDashboardResizePreview/);
    assert.match(homeSource, /onResizePointerDown/);
    assert.match(homeSource, /role="dialog" aria-modal="true"/);
    assert.match(homeSource, /ref=\{libraryHeadingRef\} tabIndex=\{-1\}/);
    assert.match(homeSource, /libraryHeadingRef\.current\?\.focus\(\)/);
    assert.match(homeSource, /addPanelsTriggerRef\.current\?\.focus\(\)/);
    assert.match(homeSource, /focusTarget/);
    assert.doesNotMatch(homeSource, /Open source/);
    assert.match(homeSource, /isMaterialState\(model\.state\)/);
    assert.match(homeSource, /data-koaryu-dashboard-shell-ready=\{layoutResolved \? "true" : "false"\}/);
    assert.match(homeSource, /data-koaryu-dashboard-data-ready=\{layoutResolved && dataReady \? "true" : "false"\}/);
    assert.match(homeSource, /data-koaryu-dashboard-ready=\{layoutResolved \? "true" : "false"\}/);
    assert.match(homeSource, /aria-busy=\{!layoutResolved\}/);
    assert.match(homeSource, /disabled=\{!layoutResolved\}/);
    assert.match(homeSource, /className=\{styles\.removeButton\}/);
    assert.match(homeSource, /styles\.removeButtonFace/);
    assert.doesNotMatch(homeSource, /<Minus aria-hidden/);
    assert.match(homeStyles, /\.removeButtonFace \{[\s\S]*width: 30px;[\s\S]*height: 30px;/);
    assert.match(homeSource, /identityReady && identity|!identityReady \|\| !identity/);
    assert.match(homeSource, /getBoundingClientRect\(\)/);
    assert.match(homeSource, /node\.animate\(keyframes/);
    assert.match(homeSource, /prefers-reduced-motion: reduce/);
  });

  it("mounts Home on authoritative identity and owns authenticated material and motion semantics", () => {
    assert.match(controllerSource, /const isDashboardIdentityReady = Boolean\(/);
    assert.match(controllerSource, /isDashboardDataReady: datasetReadiness\.status === "ready"/);
    assert.match(controllerSource, /normalizeDashboardWidgetRole\(currentRole\)/);
    assert.match(contentSource, /if \(!isDashboardIdentityReady\)/);
    assert.match(contentSource, /dataReady=\{isDashboardDataReady\}/);
    assert.match(contentSource, /identityReady=\{isDashboardIdentityReady\}/);
    for (const token of [
      "--product-ground",
      "--product-paper",
      "--product-card-stock",
      "--product-lifted",
      "--product-wood",
      "--product-straw",
      "--product-motion-travel-duration",
      "--product-motion-open-duration",
      "--product-motion-gather-duration",
      "--product-motion-settle-duration",
      "--product-motion-change-duration",
    ]) {
      assert.ok(shellStyles.includes(token), token);
    }
    assert.match(routeTransitionSource, /styles\.routeTravel/);
    assert.doesNotMatch(routeTransitionSource, /koaryu-route-enter/);
    const routeTravelRule = shellStyles.match(/\.routeTravel\s*\{[\s\S]*?\}/)?.[0] ?? "";
    assert.match(routeTravelRule, /animation:[^;]*\bbackwards;/);
    assert.doesNotMatch(routeTravelRule, /\b(?:both|forwards)\b/);
    const darkProductRule = shellStyles.match(/:global\(\[data-theme="dark"\]\) \.shellRoot\s*\{[\s\S]*?\}/)?.[0] ?? "";
    for (const token of [
      "--product-ground",
      "--product-paper",
      "--product-card-stock",
      "--product-lifted",
      "--product-ink",
      "--product-soft-ink",
      "--product-rule",
      "--product-rule-soft",
      "--product-cobalt",
      "--product-vermilion",
      "--product-shadow-card",
      "--product-shadow-lifted",
    ]) {
      assert.ok(darkProductRule.includes(token), token);
    }
    assert.doesNotMatch(darkProductRule, /#f2ece0|#fbf8f0|#fffdf8|#fffefb/);
    assert.match(shellStyles, /\.spine,[\s\S]*?background: var\(--product-sunk\);[\s\S]*?color: var\(--product-ink\);/);
    assert.doesNotMatch(shellStyles, /#302719|#fffaf0|linear-gradient/);
  });

  it("owns adaptive shell geometry and semantic customization surfaces", () => {
    for (const token of [
      "--product-control-surface",
      "--product-control-ink",
      "--product-control-rule",
      "--product-alert-surface",
      "--product-alert-ink",
    ]) {
      assert.ok(shellStyles.includes(token), token);
      assert.ok(homeStyles.includes(`var(${token})`), token);
    }
    assert.match(shellStyles, /min-height:\s*100dvh/);
    assert.match(shellStyles, /@media \(max-width: 1023px\)[\s\S]*\.shellRoot\s*\{[\s\S]*display:\s*flex;[\s\S]*flex-direction:\s*column;/);
    assert.match(shellStyles, /@media \(max-width: 1023px\)[\s\S]*\.main,[\s\S]*min-height:\s*0;[\s\S]*flex:\s*1 0 auto;/);
    assert.match(homeStyles, /min-height:\s*calc\(100dvh - 44px\)/);
    assert.match(homeStyles, /@media \(max-width: 1023px\)[\s\S]*\.home\s*\{[\s\S]*min-height:\s*0;[\s\S]*flex:\s*1 0 auto;/);
    assert.match(shellStyles, /\.slugBand\s*\{[\s\S]*height:\s*44px;[\s\S]*max-height:\s*44px;/);
    assert.match(shellStyles, /\.studioName\s*\{[\s\S]*text-overflow:\s*ellipsis;/);
  });

  it("renders Home as one truthful spatial sequence with responsive reflow", () => {
    assert.match(homeSource, /className=\{styles\.sequence\}/);
    assert.equal(homeSource.match(/className=\{styles\.sequence\}/g)?.length, 1);
    assert.match(homeSource, /layout\.items\.map\(renderWidget\)/);
    assert.equal(homeSource.match(/layout\.items\.map\(renderWidget\)/g)?.length, 1);
    assert.doesNotMatch(homeSource, /positionedItems|layout\.items\.(?:filter|sort|toSorted|reduce)|primaryItems|compactItems/);
    assert.match(homeSource, /position \$\{index \+ 1\} of \$\{total\}/);
    assert.match(homeSource, /<footer className=\{styles\.widgetFooting\}>/);
    assert.match(homeSource, /model\.provenanceLabel/);
    assert.match(homeSource, /className=\{styles\.sourceLink\}/);
    assert.doesNotMatch(homeSource, /Daily register|Operating workbench|Arrangement saved per user|catalog\.provenanceCopy|catalog\.windowCopy/);
    assert.doesNotMatch(homeSource, /<p>\{studioDescription\}<\/p>/);
    assert.match(homeStyles, /\.sequence\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(4,/);
    assert.match(homeStyles, /grid-column:\s*var\(--dashboard-column\) \/ span var\(--dashboard-column-span\)/);
    assert.match(homeStyles, /@media \(max-width: 1023px\)[\s\S]*?grid-template-columns:\s*repeat\(2,/);
    assert.match(homeStyles, /@media \(max-width: 640px\)[\s\S]*?\.sequence\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/);
    assert.match(homeStyles, /\.dragHandle\s*\{[\s\S]*?touch-action:\s*none;/);
    assert.match(homeStyles, /\.customizing \.widget:not\(\.attentionWidget\)\s*\{[\s\S]*?touch-action:\s*pan-y;/);
    assert.doesNotMatch(homeStyles, /\.pickedUp \.dragHandle/);
    assert.doesNotMatch(homeStyles, /data-size="4x[12]"/);
    assert.match(homeStyles, /\.widget\s*\{[\s\S]*?border-radius:\s*14px;[\s\S]*?box-shadow:\s*var\(--product-shadow-card\);/);
    assert.match(homeStyles, /\.widget\s*\{[\s\S]*?grid-template-rows:\s*44px minmax\(0, 1fr\) 44px;/);
    assert.match(homeStyles, /data-density="tall"/);
    assert.match(homeStyles, /\.widgetBody\s*\{[\s\S]*?overflow:\s*clip;/);
    assert.match(homeStyles, /data-widget-id="needs_attention"/);
    assert.match(homeStyles, /data-widget-id="classes_today"/);
    assert.match(homeStyles, /@media print/);
    assert.match(shellStyles, /@media print/);
  });

  it("preserves source labels verbatim", () => {
    assert.match(homeSource, /<span>\{action\.label\}<\/span>/);
    assert.doesNotMatch(homeSource, /sentenceCase/);
    assert.match(viewModelSource, /\{ label: "Import CSV", href: "\/students\/import" \}/);
  });

  it("removes rejected ledger costume from the authenticated shell and Home", () => {
    for (const styles of [shellStyles, homeStyles]) {
      assert.doesNotMatch(styles, /text-transform:\s*uppercase/);
      assert.doesNotMatch(styles, /linear-gradient/);
      assert.doesNotMatch(styles, /border-radius:\s*(?:0|[1-4]px)\b/);
      assert.doesNotMatch(styles, /box-shadow:\s*(?:inset\s+)?(?:-?\d+px\s+){2}0(?:px)?\b/);
    }
    assert.match(shellStyles, /--product-focus:\s*#2f5d8f/);
    assert.match(shellStyles, /:global\(\[data-theme="dark"\]\) \.shellRoot[\s\S]*--product-focus:\s*#85aedc/);
    assert.match(homeStyles, /outline:\s*2px solid var\(--product-focus\)/);
  });

  it("puts the 44px target on queue and brand anchors themselves", () => {
    assert.match(homeStyles, /\.queue a\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?flex:\s*1 1 auto;/);
    assert.match(shellStyles, /\.brandLink,[\s\S]*?\.mobileBrand\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/);
    assert.match(accountMenuSource, /flex h-11 w-full cursor-pointer/);
    assert.match(accountMenuSource, /group flex min-h-11 items-center/);
    assert.match(accountMenuSource, /group flex h-11 w-full items-center/);
    assert.doesNotMatch(accountMenuSource, /focus-visible:ring-1|uppercase|hover:-translate/);
  });

  it("keeps reduced motion hidden states, print aliases, and the two-level elevation ladder honest", () => {
    const reducedShell = shellStyles.slice(shellStyles.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    assert.match(reducedShell, /\.skipLink\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?clip-path:\s*inset\(100%\);/);
    assert.match(reducedShell, /\.skipLink:focus-visible\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?clip-path:\s*inset\(0\);/);
    assert.match(accountMenuStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.root\[data-state="closed"\][\s\S]*?display:\s*none;[\s\S]*?visibility:\s*hidden;[\s\S]*?opacity:\s*0;/);
    assert.doesNotMatch(accountMenuSource, /rotate-90|style=\{\{ transform:/);
    assert.doesNotMatch(overviewSource, /group-hover:translate-x/);

    const printShell = shellStyles.slice(shellStyles.indexOf("@media print"));
    for (const token of ["--product-ground: #fff", "--product-ink: #111", "--product-rule-soft: #ccc", "--text-primary: #111", "--accent: #111"]) {
      assert.ok(printShell.includes(token), token);
    }
    assert.match(printShell, /:global\(\[data-theme="dark"\]\) \.shellRoot/);
    const printHome = homeStyles.slice(homeStyles.indexOf("@media print"));
    assert.match(printHome, /\.sequence\s*\{[\s\S]*?display:\s*block;/);
    assert.doesNotMatch(printHome, /\border\s*:|grid-auto-flow\s*:|column-count\s*:/);

    const spineRule = shellStyles.match(/\.spine\s*\{[\s\S]*?\}/)?.[0] ?? "";
    const activeNavRule = shellStyles.match(/\.navLink\[aria-current="page"\]\s*\{[\s\S]*?\}/)?.[0] ?? "";
    assert.doesNotMatch(spineRule, /box-shadow/);
    assert.doesNotMatch(activeNavRule, /box-shadow/);
  });

  it("owns authoritative studio identity in the split store and purges layouts at session cleanup", () => {
    assert.match(storeSource, /const \[currentStudioId, setCurrentStudioId\]/);
    assert.match(storeSource, /authProfile\.membership_status === "active" \? authProfile\.studio_id \?\? null : null/);
    assert.match(storeSource, /setCurrentStudioId\(null\)/);
    assert.match(sessionSource, /purgeDashboardLayoutNamespace\(\)/);
    assert.doesNotMatch(sessionSource, /koaryu-theme/);
  });
});
