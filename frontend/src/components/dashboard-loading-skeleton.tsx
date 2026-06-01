import { Header } from "@/components/header";

function SkeletonBlock({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-[4px] bg-surface-raised motion-reduce:animate-none ${className}`}
      aria-hidden
    />
  );
}

export function DashboardLoadingSkeleton({
  title = "Loading",
  description = "Preparing the latest studio workspace.",
  variant = "dashboard",
}: {
  title?: string;
  description?: string;
  variant?: "dashboard" | "table" | "calendar" | "billing" | "settings";
}) {
  const metricCount = variant === "settings" ? 2 : 4;

  return (
    <>
      <Header title={title} description={description} />
      <div className="flex-1 p-6 sm:p-8" aria-busy="true" aria-live="polite">
        <div className="max-w-6xl space-y-6">
          <section className="overflow-hidden rounded-[6px] border border-border bg-surface">
            <div className="border-b border-border px-4 py-5 sm:px-5">
              <SkeletonBlock className="h-3 w-36" />
              <SkeletonBlock className="mt-4 h-7 w-full max-w-lg" />
              <SkeletonBlock className="mt-3 h-4 w-full max-w-2xl" />
            </div>
            <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: metricCount }).map((_, index) => (
                <div key={index} className="bg-surface px-4 py-5">
                  <SkeletonBlock className="h-3 w-24" />
                  <SkeletonBlock className="mt-4 h-8 w-16" />
                  <SkeletonBlock className="mt-3 h-3 w-32" />
                </div>
              ))}
            </div>
          </section>

          <section className="overflow-hidden rounded-[6px] border border-border bg-surface">
            <div className="border-b border-border px-4 py-4 sm:px-5">
              <SkeletonBlock className="h-4 w-40" />
              <SkeletonBlock className="mt-2 h-3 w-full max-w-md" />
            </div>
            <div className={variant === "calendar" ? "grid gap-px bg-border sm:grid-cols-7" : "divide-y divide-border"}>
              {Array.from({ length: variant === "calendar" ? 14 : 6 }).map((_, index) => (
                <div key={index} className="bg-surface px-4 py-4">
                  <SkeletonBlock className="h-4 w-2/3" />
                  <SkeletonBlock className="mt-3 h-3 w-1/2" />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
