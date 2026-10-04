import { BackendWarmup } from "@/components/backend-warmup";
import { Breather, Faq, Finale, MatBand, Pricing } from "@/components/marketing/landing/closing";
import { Day } from "@/components/marketing/landing/day";
import { Hero } from "@/components/marketing/landing/hero";
import styles from "@/components/marketing/landing/landing.module.css";
import { LegacyHashRedirect } from "@/components/marketing/landing/legacy-hash-redirect";
import { Problem } from "@/components/marketing/landing/problem";
import { Product } from "@/components/marketing/landing/product";
import { Studio } from "@/components/marketing/landing/studio";
import { MarketingRoot } from "@/components/marketing/marketing-root";
import { MarketingHeader } from "@/components/marketing/public-pages";

export function LandingPage() {
  return (
    <MarketingRoot layout="document" className={styles.root}>
      <BackendWarmup />
      <LegacyHashRedirect />
      <div className={styles.beltProgress} aria-hidden="true" />
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <div className={styles.masthead}>
        <MarketingHeader />
      </div>
      <main id="main-content" tabIndex={-1} className={styles.main}>
        <Hero />
        {/* Inside the hill: the deep brown that the masthead darkens over. */}
        <div className={styles.inside}>
          <Problem />
          <Studio />
        </div>
        <Product />
        <Day />
        <Breather />
        <Pricing />
        <MatBand />
        <Faq />
        <Finale />
      </main>
    </MarketingRoot>
  );
}
