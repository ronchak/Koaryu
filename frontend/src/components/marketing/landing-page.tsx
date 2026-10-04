import { BackendWarmup } from "@/components/backend-warmup";
import { FilmTitles } from "@/components/marketing/landing/film-titles";
import { LandingController } from "@/components/marketing/landing/landing-controller";
import { Day, Faq, Finale, Pricing, Product } from "@/components/marketing/landing/page-sections";
import filmStyles from "@/components/marketing/landing/film.module.css";
import { MarketingRoot } from "@/components/marketing/marketing-root";

/**
 * Act one is a film: the illustrated story, pinned and scrubbed by scroll.
 * Act two is the page: the product, a day at the studio, the price,
 * questions, and the hills again at the close.
 */
export function LandingPage() {
  return (
    <MarketingRoot layout="document" className={filmStyles.root}>
      <BackendWarmup />
      <LandingController titles={<FilmTitles />}>
        <Product />
        <Day />
        <Pricing />
        <Faq />
        <Finale />
      </LandingController>
    </MarketingRoot>
  );
}
