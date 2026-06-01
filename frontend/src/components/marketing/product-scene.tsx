import { APP_NAME } from "@/lib/constants";
import styles from "./public-pages.module.css";

const productSceneMetricRows = [
  ["Students training", "128", "Healthy"],
  ["Follow-ups due", "7", "Today"],
  ["Ready to promote", "11", "Review"],
  ["Tuition issues", "3", "Repair"],
];

const productSceneQueueItems = [
  "Call trial families",
  "Check in evening classes",
  "Approve promotion list",
];

export function ProductScene({
  label = "Owner Dashboard",
  focus = "Today",
}: {
  label?: string;
  focus?: string;
}) {
  return (
    <div className="koaryu-product-scene pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div className={`${styles.dotGrid} absolute inset-0 opacity-45`} />
      <div className="absolute inset-y-0 left-0 z-[1] w-full bg-[linear-gradient(90deg,var(--bg)_0%,color-mix(in_srgb,var(--bg)_98%,transparent)_36%,color-mix(in_srgb,var(--bg)_90%,transparent)_58%,color-mix(in_srgb,var(--bg)_52%,transparent)_78%,transparent_100%)]" />
      <div className="absolute inset-x-0 bottom-0 z-[2] h-40 bg-[linear-gradient(180deg,transparent,var(--bg)_82%)]" />
      <div className="absolute right-[-360px] top-20 hidden w-[700px] rotate-[-1deg] border border-border/70 bg-surface/34 p-4 opacity-34 shadow-2xl shadow-black/25 backdrop-blur-[2px] xl:block 2xl:right-[-120px] 2xl:w-[760px]">
        <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-widest text-accent">{label}</p>
            <p className="mt-1 text-[11px] text-text-secondary">{APP_NAME} / Demo Studio</p>
          </div>
          <span className="rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-[11px] text-accent">
            {focus}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          {productSceneMetricRows.map((row, index) => (
            <div key={row[0]} className="border border-border bg-bg/60 p-3" style={{ borderRadius: 6 }}>
              <p className="text-[11px] text-text-secondary">{row[0]}</p>
              <p className="mt-3 font-mono text-2xl font-semibold text-text-primary">{row[1]}</p>
              <p className="mt-1 text-[11px] text-accent">{row[2]}</p>
              <div className="mt-3 h-1 bg-surface-raised">
                <div className="h-full bg-accent" style={{ width: `${54 + index * 11}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-[1.2fr_0.8fr]">
          <div className="border border-border bg-bg/60 p-4" style={{ borderRadius: 6 }}>
            <p className="text-xs font-semibold text-text-primary">Today&apos;s operating queue</p>
            <div className="mt-4 space-y-3">
              {productSceneQueueItems.map((item) => (
                <div key={item} className="flex items-center justify-between border-b border-border pb-2 text-xs text-text-secondary last:border-0">
                  <span>{item}</span>
                  <span className="font-mono text-accent">Open</span>
                </div>
              ))}
            </div>
          </div>
          <div className="border border-border bg-bg/60 p-4" style={{ borderRadius: 6 }}>
            <p className="text-xs font-semibold text-text-primary">Retention watch</p>
            <div className="mt-4 h-24 border-l border-b border-border">
              <div className="h-full w-full bg-[linear-gradient(135deg,transparent_0_20%,color-mix(in_srgb,var(--accent)_22%,transparent)_20%_24%,transparent_24%_46%,color-mix(in_srgb,var(--success)_20%,transparent)_46%_51%,transparent_51%)]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
