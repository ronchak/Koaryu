import type { NavigationPlacement } from "@/components/theme-provider";
import { KoaryuMark, Logo } from "@/components/logo";
import { APP_NAME } from "@/lib/constants";
import styles from "./dashboard-shell.module.css";

export function DashboardIdentitySkeleton({
  placement,
  error,
  onRetry,
}: {
  placement: NavigationPlacement;
  error: string | null;
  onRetry: () => void;
}) {
  const placeholders = Array.from({ length: 9 }, (_, index) => (
    <span key={index} className={styles.identityPlaceholder} />
  ));
  return (
    <>
      <div className={styles.mobileSpine} aria-hidden="true">
        <div className={styles.mobileTop}>
          <Logo size="sm" />
        </div>
        <div className={styles.mobileNav}>{placeholders}</div>
      </div>
      {placement === "top" ? (
        <div className={styles.commandBar} aria-hidden="true">
          <Logo size="sm" />
          {placeholders}
        </div>
      ) : (
        <div className={styles.spine} aria-hidden="true">
          <div className={styles.brandBand}>
            <span className={styles.brandLink}>
              <span className={styles.railSlot}>
                <KoaryuMark size="lg" />
              </span>
              <span className={styles.brandWord}>{APP_NAME}</span>
            </span>
          </div>
          <div className={styles.spineNav}>{placeholders}</div>
        </div>
      )}
      <main id="main-content" tabIndex={-1} className={styles.main}>
        <div className={styles.slugBand} aria-hidden="true">
          <span className={styles.identityPlaceholder} />
        </div>
        {error ? (
          <div className="p-6 sm:p-10" role="alert">
            <div className="max-w-xl rounded-[16px] border border-border bg-surface p-6 shadow-[var(--product-shadow-card)]">
              <h1 className="text-xl font-extrabold tracking-[-0.02em]">
                Your workspace could not be loaded
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">{error}</p>
              <button
                type="button"
                onClick={onRetry}
                className="mt-5 inline-flex min-h-11 items-center rounded-[10px] bg-[var(--hz-cta)] px-4 py-2 text-sm font-semibold text-[var(--hz-cta-ink)]"
              >
                Retry workspace
              </button>
            </div>
          </div>
        ) : (
          // The page draws its own placeholder once access is confirmed. A second,
          // differently shaped skeleton here would only flash before it.
          <p className="sr-only" role="status" aria-live="polite">
            Loading workspace. Confirming your account and studio access.
          </p>
        )}
      </main>
    </>
  );
}
