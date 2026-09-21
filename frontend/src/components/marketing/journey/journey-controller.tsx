"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { publicNavLinks } from "../../../lib/public-navigation.ts";
import { MarketingBrandLink, MarketingMenuButton, MarketingNavLink } from "../marketing-primitives";
import {
  FAQ_HASHES,
  INITIAL_WHEEL_GESTURE_STATE,
  canScrollablePanelMove,
  decideJourneyHashChange,
  decideJourneyKey,
  decideTouchChapter,
  nextFaqTopicIndex,
  normalizeWheelDelta,
  reduceWheelGesture,
  resolveJourneyHash,
  shouldHandleJourneyKeyboardFocus,
  type ResolvedJourneyHash,
  type ScrollMetrics,
} from "./interaction-model";
import { AnimatedJourneyScene, type SceneTarget } from "./animated-journey-scene";
import { SCENE_HEIGHT, SCENE_WIDTH, clamp, frameForDimensions } from "./scene-model";
import styles from "./journey.module.css";

const chapters = landingPageContent.chapters;
const firstChapter = chapters[0];
const lastChapterIndex = chapters.length - 1;
const faqChapterIndex = chapters.findIndex(({ id }) => id === "faq");

if (!firstChapter || faqChapterIndex < 0) {
  throw new Error("The Koaryu Journey requires at least one chapter.");
}

interface JourneyControllerProps {
  readonly children: ReactNode;
}

type HistoryMode = "replace" | "push";

interface NavigateOptions {
  readonly canonicalHash?: string;
  readonly faqGroup?: number | null;
  readonly historyMode?: HistoryMode;
  readonly writeHash?: boolean;
}

function writeJourneyUrl(relativeUrl: string, historyMode: HistoryMode) {
  if (typeof window === "undefined") {
    return;
  }

  const destination = new URL(relativeUrl, window.location.href);
  const requestedRelativeUrl = `${destination.pathname}${destination.search}${destination.hash}`;
  const currentRelativeUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (requestedRelativeUrl === currentRelativeUrl) {
    return;
  }

  if (historyMode === "push") {
    window.history.pushState(null, "", requestedRelativeUrl);
  } else {
    window.history.replaceState(null, "", requestedRelativeUrl);
  }
}

function metricsFor(element: HTMLElement): ScrollMetrics {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

function closestScrollPanel(target: EventTarget | null, compact: boolean): HTMLElement | null {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return null;
  }
  const panel = target.closest<HTMLElement>(
    compact ? "[data-journey-chapter]" : "[data-faq-scroll]",
  );
  return panel instanceof HTMLElement ? panel : null;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest("a, button, input, textarea, select, summary, [contenteditable='true']"),
  );
}

export function JourneyController({ children }: JourneyControllerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef(0);
  const reducedMotionRef = useRef(false);
  const [enhanced, setEnhanced] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [sceneTarget, setSceneTarget] = useState<SceneTarget>({
    progress: firstChapter.scene,
    animate: false,
  });
  const [compact, setCompact] = useState(false);
  const [frame, setFrame] = useState(() => frameForDimensions(SCENE_WIDTH, SCENE_HEIGHT));
  const [menuOpen, setMenuOpen] = useState(false);
  const [faqGroup, setFaqGroup] = useState(0);
  const [openFaq, setOpenFaq] = useState(0);

  const navigateTo = useCallback((requestedIndex: number, options: NavigateOptions = {}) => {
    const nextIndex = Math.round(clamp(requestedIndex, 0, lastChapterIndex));
    const nextChapter = chapters[nextIndex];
    if (!nextChapter) {
      return;
    }

    pageRef.current = nextIndex;
    setPageIndex(nextIndex);
    setMenuOpen(false);
    setOpenFaq(0);
    if (nextChapter.id !== "faq") {
      setFaqGroup(0);
    } else if (options.faqGroup != null) {
      setFaqGroup(Math.round(clamp(options.faqGroup, 0, FAQ_HASHES.length - 1)));
    }
    setSceneTarget({ progress: nextChapter.scene, animate: !reducedMotionRef.current });

    if (options.writeHash !== false && typeof window !== "undefined") {
      const nextHash = options.canonicalHash ?? nextChapter.id;
      writeJourneyUrl(`#${nextHash}`, options.historyMode ?? "replace");
    }
  }, []);

  const applyResolvedHash = useCallback(
    (resolved: ResolvedJourneyHash, animate: boolean, historyMode: HistoryMode = "replace") => {
      const chapter = chapters[resolved.chapterIndex];
      if (!chapter) {
        return;
      }

      if (animate) {
        navigateTo(resolved.chapterIndex, {
          canonicalHash: resolved.canonicalHash,
          faqGroup: resolved.faqGroup,
          historyMode: resolved.wasAlias ? "replace" : historyMode,
        });
      } else {
        pageRef.current = resolved.chapterIndex;
        setPageIndex(resolved.chapterIndex);
        setSceneTarget({ progress: chapter.scene, animate: false });
        setFaqGroup(resolved.faqGroup ?? 0);
        setOpenFaq(0);
      }

      if (resolved.wasAlias) {
        writeJourneyUrl(`#${resolved.canonicalHash}`, "replace");
      }
    },
    [navigateTo],
  );

  const selectFaqGroup = useCallback((requestedGroup: number) => {
    const nextGroup = Math.round(clamp(requestedGroup, 0, FAQ_HASHES.length - 1));
    setFaqGroup(nextGroup);
    setOpenFaq(0);
    if (typeof window !== "undefined" && pageRef.current === faqChapterIndex) {
      writeJourneyUrl(`#${FAQ_HASHES[nextGroup]}`, "replace");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = motionQuery.matches;
    const compactQuery = window.matchMedia(
      "(max-width: 820px), (max-width: 1024px) and (max-height: 500px)",
    );
    const activationFrame = window.requestAnimationFrame(() => {
      const initialHash = resolveJourneyHash(window.location.hash);
      if (initialHash) {
        applyResolvedHash(initialHash, false);
      }
      setFrame(frameForDimensions(window.innerWidth, window.innerHeight));
      setCompact(compactQuery.matches);
      setEnhanced(true);
    });

    const onResize = () => {
      setCompact(compactQuery.matches);
      setFrame(frameForDimensions(window.innerWidth, window.innerHeight));
    };
    const onMotionChange = (event: MediaQueryListEvent) => {
      reducedMotionRef.current = event.matches;
      if (event.matches) {
        const current = chapters[pageRef.current];
        if (current) {
          setSceneTarget({ progress: current.scene, animate: false });
        }
      }
    };
    const onHashChange = () => {
      const decision = decideJourneyHashChange(window.location.hash);
      if (decision.action === "reset") {
        navigateTo(decision.chapterIndex, { writeHash: decision.writeHash });
      } else if (decision.action === "navigate") {
        applyResolvedHash(decision.resolved, true);
      }
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("hashchange", onHashChange);
    motionQuery.addEventListener("change", onMotionChange);
    return () => {
      window.cancelAnimationFrame(activationFrame);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("hashchange", onHashChange);
      motionQuery.removeEventListener("change", onMotionChange);
    };
  }, [applyResolvedHash, navigateTo]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!enhanced || !root) {
      return;
    }

    for (const chapter of root.querySelectorAll<HTMLElement>("[data-journey-chapter]")) {
      const active = Number(chapter.dataset.chapterIndex) === pageIndex;
      chapter.inert = !active;
      chapter.tabIndex = active && compact ? 0 : -1;
      chapter.setAttribute("aria-hidden", active ? "false" : "true");
    }

    for (const topic of root.querySelectorAll<HTMLElement>("[data-faq-topic]")) {
      const active = Number(topic.dataset.faqTopic) === faqGroup;
      topic.tabIndex = active ? 0 : -1;
      if (active) {
        topic.setAttribute("aria-current", "true");
      } else {
        topic.removeAttribute("aria-current");
      }
    }

    for (const group of root.querySelectorAll<HTMLElement>("[data-faq-group]")) {
      const active = Number(group.dataset.faqGroup) === faqGroup;
      group.inert = !active;
      group.setAttribute("aria-hidden", active ? "false" : "true");
    }

    for (const item of root.querySelectorAll<HTMLElement>("[data-faq-item]")) {
      const [groupValue, itemValue] = (item.dataset.faqItem ?? "").split("-");
      const active = Number(groupValue) === faqGroup && Number(itemValue) === openFaq;
      item.dataset.open = active ? "true" : "false";
      const question = item.querySelector<HTMLElement>("[data-faq-question]");
      const answer = item.querySelector<HTMLElement>("[data-faq-answer]");
      question?.setAttribute("aria-expanded", active ? "true" : "false");
      answer?.setAttribute("aria-hidden", active ? "false" : "true");
    }
  }, [compact, enhanced, faqGroup, openFaq, pageIndex]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const root = rootRef.current;
    if (!enhanced || !root) {
      return;
    }

    let wheelState = INITIAL_WHEEL_GESTURE_STATE;
    let touchStartY: number | null = null;
    let touchStartX = 0;
    let touchMetrics: ScrollMetrics | null = null;
    let touchPanel: HTMLElement | null = null;
    let touchPanelStart = 0;

    const eventBelongsToJourney = (target: EventTarget | null) => {
      if (typeof Node === "undefined" || !(target instanceof Node)) {
        return false;
      }
      return root.contains(target);
    };

    const onWheel = (event: WheelEvent) => {
      if (
        !eventBelongsToJourney(event.target) ||
        menuOpen ||
        event.ctrlKey ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ) {
        return;
      }

      const delta = normalizeWheelDelta(event.deltaY, event.deltaMode, window.innerHeight);
      const direction = delta > 0 ? 1 : -1;
      const panel = closestScrollPanel(event.target, compact);
      const faqCanScroll = panel ? canScrollablePanelMove(metricsFor(panel), direction) : false;
      const result = reduceWheelGesture(wheelState, {
        delta,
        now: event.timeStamp,
        faqCanScroll,
      });
      wheelState = result.state;
      if (result.preventDefault) {
        event.preventDefault();
      }
      if (result.action === "advance") {
        navigateTo(pageRef.current + result.direction);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuOpen) {
        event.preventDefault();
        setMenuOpen(false);
        return;
      }

      if (typeof document === "undefined") {
        return;
      }
      const activeElement = document.activeElement;
      if (
        !shouldHandleJourneyKeyboardFocus({
          hasActiveElement: Boolean(activeElement),
          activeIsBody: activeElement === document.body,
          activeIsDocumentElement: activeElement === document.documentElement,
          rootContainsActive: Boolean(activeElement && root.contains(activeElement)),
        })
      ) {
        return;
      }

      const activeTopic =
        typeof Element !== "undefined" && activeElement instanceof Element
          ? activeElement.closest<HTMLElement>("[data-faq-topic]")
          : null;
      if (activeTopic) {
        const currentTopic = Number(activeTopic.dataset.faqTopic);
        const nextTopic = nextFaqTopicIndex(currentTopic, event.key, FAQ_HASHES.length);
        if (nextTopic != null) {
          event.preventDefault();
          selectFaqGroup(nextTopic);
          window.requestAnimationFrame(() => {
            root.querySelector<HTMLElement>(`[data-faq-topic="${nextTopic}"]`)?.focus();
          });
          return;
        }
      }

      const panel =
        closestScrollPanel(activeElement, compact) ??
        (compact
          ? root.querySelector<HTMLElement>('[data-journey-chapter][aria-hidden="false"]')
          : null);
      const decision = decideJourneyKey({
        key: event.key,
        shiftKey: event.shiftKey,
        interactiveTarget: isInteractiveTarget(activeElement),
        panel: panel ? metricsFor(panel) : null,
      });

      if (decision.action === "none") {
        return;
      }
      event.preventDefault();
      if (decision.action === "chapter") {
        navigateTo(pageRef.current + decision.direction);
        return;
      }
      if (decision.action === "chapter-edge") {
        navigateTo(decision.edge === "first" ? 0 : lastChapterIndex);
        return;
      }
      if (!panel) {
        return;
      }

      const behavior = reducedMotionRef.current ? "auto" : "smooth";
      if (decision.amount === "edge") {
        panel.scrollTo({
          top: decision.edge === "first" ? 0 : panel.scrollHeight,
          behavior,
        });
      } else {
        const amount = decision.amount === "line" ? 52 : panel.clientHeight * 0.78;
        panel.scrollBy({ top: decision.direction * amount, behavior });
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      if (!eventBelongsToJourney(event.target) || event.touches.length !== 1) {
        touchStartY = null;
        return;
      }
      if (menuOpen || isInteractiveTarget(event.target)) {
        touchStartY = null;
        return;
      }
      touchStartY = event.touches[0]?.clientY ?? null;
      touchStartX = event.touches[0]?.clientX ?? 0;
      touchPanel = closestScrollPanel(event.target, compact);
      touchMetrics = touchPanel ? metricsFor(touchPanel) : null;
      touchPanelStart = touchPanel?.scrollTop ?? 0;
    };

    const onTouchEnd = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (
        touchStartY === null ||
        event.touches.length > 0 ||
        !touch ||
        !eventBelongsToJourney(event.target)
      ) {
        return;
      }

      const direction = touchStartY - touch.clientY > 0 ? 1 : -1;
      const panelMoved = touchPanel ? Math.abs(touchPanel.scrollTop - touchPanelStart) > 4 : false;
      const panelCanScroll =
        Boolean(touchMetrics && canScrollablePanelMove(touchMetrics, direction)) ||
        Boolean(touchPanel && canScrollablePanelMove(metricsFor(touchPanel), direction));
      const chapterDirection = decideTouchChapter({
        startY: touchStartY,
        endY: touch.clientY,
        deltaX: touch.clientX - touchStartX,
        panelMoved,
        panelCanScroll,
      });
      if (chapterDirection) {
        event.preventDefault();
        navigateTo(pageRef.current + chapterDirection);
      }
      touchStartY = null;
      touchPanel = null;
    };

    const onTouchCancel = () => {
      touchStartY = null;
      touchPanel = null;
      touchMetrics = null;
    };

    window.addEventListener("touchcancel", onTouchCancel, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: false });
    return () => {
      window.removeEventListener("touchcancel", onTouchCancel);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchend", onTouchEnd);
    };
  }, [compact, enhanced, menuOpen, navigateTo, selectFaqGroup]);

  const onContentClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (
      typeof window === "undefined" ||
      typeof Element === "undefined" ||
      !(event.target instanceof Element)
    ) {
      return;
    }

    const faqQuestion = event.target.closest<HTMLElement>("[data-faq-question]");
    if (faqQuestion) {
      event.preventDefault();
      const [groupValue, itemValue] = (faqQuestion.dataset.faqQuestion ?? "").split("-");
      const nextGroup = Number(groupValue);
      const nextItem = Number(itemValue);
      if (Number.isInteger(nextGroup) && Number.isInteger(nextItem)) {
        setFaqGroup(nextGroup);
        setOpenFaq((current) => (current === nextItem && faqGroup === nextGroup ? -1 : nextItem));
      }
      return;
    }

    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    const anchor = event.target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) {
      return;
    }
    const destination = new URL(anchor.href, window.location.href);
    if (
      destination.origin !== window.location.origin ||
      destination.pathname !== window.location.pathname
    ) {
      return;
    }

    const decision = decideJourneyHashChange(destination.hash);
    if (decision.action === "ignore") {
      return;
    }
    event.preventDefault();
    if (decision.action === "reset") {
      writeJourneyUrl(`${destination.pathname}${destination.search}`, "push");
      navigateTo(decision.chapterIndex, { writeHash: decision.writeHash });
      return;
    }
    applyResolvedHash(decision.resolved, true, "push");
  };

  const activeChapter = chapters[pageIndex] ?? firstChapter;
  const activeInk = activeChapter.ink;

  return (
    <div
      ref={rootRef}
      className={styles.journey}
      data-enhanced={enhanced ? "true" : "false"}
      data-active-chapter={activeChapter.id}
      data-active-faq={FAQ_HASHES[faqGroup]}
      data-menu-open={menuOpen ? "true" : "false"}
      data-active-ink={activeInk}
      data-compact={compact ? "true" : "false"}
      onClickCapture={onContentClickCapture}
    >
      <div className={styles.sceneLayer} aria-hidden="true">
        <AnimatedJourneyScene
          target={sceneTarget}
          frame={frame}
          compact={compact}
          rootRef={rootRef}
        />
      </div>

      <header className={styles.topbar}>
        <MarketingBrandLink href="/" prefetch={false} />
        <nav className={styles.primaryNav} aria-label="Primary">
          {publicNavLinks.map((link) => (
            <MarketingNavLink key={link.href} href={link.href}>
              {link.label}
            </MarketingNavLink>
          ))}
        </nav>
        <MarketingMenuButton
          className={styles.menuButton}
          aria-expanded={menuOpen}
          aria-controls="journey-mobile-navigation"
          onClick={() => setMenuOpen((open) => !open)}
        />
        <MarketingNavLink href="/login" prefetch={false} className={styles.signIn}>
          Sign In
        </MarketingNavLink>
        <nav
          id="journey-mobile-navigation"
          className={styles.mobileNav}
          aria-label="Mobile"
          aria-hidden={enhanced && !menuOpen ? "true" : undefined}
        >
          {publicNavLinks.map((link) => (
            <MarketingNavLink key={link.href} href={link.href}>
              {link.label}
            </MarketingNavLink>
          ))}
          <MarketingNavLink href="/login" prefetch={false}>
            Sign In
          </MarketingNavLink>
        </nav>
      </header>

      {children}

      <div className={styles.pager} aria-label="Journey controls">
        <button
          type="button"
          onClick={() => navigateTo(pageIndex - 1)}
          disabled={pageIndex === 0}
          aria-label="Previous chapter"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => navigateTo(pageIndex + 1)}
          disabled={pageIndex === lastChapterIndex}
          aria-label="Next chapter"
        >
          ↓
        </button>
      </div>

      <nav className={styles.rail} aria-label="Journey chapters">
        {chapters.map((chapter, index) => (
          <button
            key={chapter.id}
            type="button"
            aria-label={`Go to chapter ${index + 1}: ${chapter.title}`}
            aria-current={index === pageIndex ? "step" : undefined}
            onClick={() => navigateTo(index)}
          >
            <span aria-hidden="true" />
          </button>
        ))}
      </nav>

      <p className={styles.liveStatus} aria-live="polite" aria-atomic="true">
        Chapter {pageIndex + 1} of {chapters.length}: {activeChapter.title}
      </p>
    </div>
  );
}
