import { Archivo } from "next/font/google";

import { BackendWarmup } from "@/components/backend-warmup";
import { Faq, Finale, Pricing } from "@/components/marketing/landing/closing";
import { Day } from "@/components/marketing/landing/day";
import { Hero, HeroArt } from "@/components/marketing/landing/hero";
import styles from "@/components/marketing/landing/landing.module.css";
import { LegacyHashRedirect } from "@/components/marketing/landing/legacy-hash-redirect";
import { Product } from "@/components/marketing/landing/product";
import { TryIt } from "@/components/marketing/landing/try-it";
import { MarketingRoot } from "@/components/marketing/marketing-root";
import { MarketingHeader } from "@/components/marketing/public-pages";

const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

export function LandingPage() {
  return (
    <MarketingRoot layout="document" className={`${styles.root} ${archivo.variable}`}>
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
        <div className={styles.opening}>
          <HeroArt />
          <Hero />
          <TryIt />
        </div>
        <Product />
        <Day />
        <Pricing />
        <Faq />
        <Finale />
      </main>
    </MarketingRoot>
  );
}
