import Image from "next/image";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import styles from "./landing.module.css";

/** The real belt tracker, glowing in the dark: the desktop screen with the phone in front. */
export function Product() {
  const { product } = landingPageContent;
  return (
    <section id={product.id} className={styles.product} aria-labelledby="product-title">
      <div className={styles.productCopy}>
        <p className={styles.label}>{product.label}</p>
        <h2 id="product-title" className={styles.sectionTitle}>
          {product.title}
        </h2>
        <p className={styles.sectionLede}>{product.lede}</p>
      </div>
      <figure className={styles.productFigure}>
        <div className={styles.productScreens}>
          <div className={styles.productDesktop}>
            <Image
              src={product.image.src}
              width={product.image.width}
              height={product.image.height}
              alt={product.image.alt}
              sizes="(max-width: 900px) 92vw, 62vw"
            />
          </div>
          <div className={styles.productPhone}>
            <Image
              src={product.image.mobile.src}
              width={product.image.mobile.width}
              height={product.image.mobile.height}
              alt="The same belt tracker in Koaryu's phone layout."
              sizes="(max-width: 900px) 40vw, 240px"
            />
          </div>
        </div>
        <figcaption className={styles.caption}>{product.caption}</figcaption>
      </figure>
    </section>
  );
}
