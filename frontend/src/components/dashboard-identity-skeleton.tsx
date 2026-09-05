import type { NavigationPlacement } from "@/components/theme-provider";
import { DashboardLoadingSkeleton } from "@/components/dashboard-loading-skeleton";
import { Logo } from "@/components/logo";
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
        <div className={styles.mobileTop}><Logo size="sm" /></div>
        <div className={styles.mobileNav}>{placeholders}</div>
      </div>
      {placement === "top" ? (
        <div className={styles.commandBar} aria-hidden="true"><Logo size="sm" />{placeholders}</div>
      ) : (
        <div className={styles.spine} aria-hidden="true">
          <div className={styles.brandBand}><Logo size="md" /></div>
          <div className={styles.spineNav}>{placeholders}</div>
        </div>
      )}
      <main id="main-content" tabIndex={-1} className={styles.main}>
        <div className={styles.slugBand} aria-hidden="true"><span className={styles.identityPlaceholder} /></div>
        {error ? (
          <div className="p-6" role="alert">
            <h1 className="text-lg font-semibold">Your workspace could not be loaded</h1>
            <p className="mt-2 text-sm text-text-secondary">{error}</p>
            <button type="button" onClick={onRetry} className="mt-4 rounded border border-border px-4 py-2">Retry workspace</button>
          </div>
        ) : (
          <DashboardLoadingSkeleton title="Loading workspace" description="Confirming your account and studio access." />
        )}
      </main>
    </>
  );
}
