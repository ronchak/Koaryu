import Image from "next/image";

import { landingPageContent } from "../../../lib/landing-page-content.ts";
import { closedRidgePath } from "../journey/hills";
import styles from "./landing.module.css";

/** Hills rise back into the light where the dark ground ends. */
const EDGE = [
  { path: closedRidgePath(70, 22, 0.8, 2.2), color: "#7d6638" },
  { path: closedRidgePath(112, 18, 1.1, 4.6), color: "#f3ecdd" },
] as const;

/** The real belt tracker: the desktop screen, with the same screen on a phone in front of it. */
export function Product() {
  const { product } = landingPageContent;
  return (
    <section id={product.id} className={styles.product} aria-labelledby="product-title">
      <div className={styles.productInner}>
        <div className={styles.productCopy}>
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
                sizes="(max-width: 820px) 1px, (max-width: 1280px) 64vw, 820px"
              />
            </div>
            <div className={styles.productPhone}>
              <Image
                src={product.image.mobile.src}
                width={product.image.mobile.width}
                height={product.image.mobile.height}
                alt="The same belt tracker in Koaryu's phone layout."
                sizes="(max-width: 820px) 280px, 220px"
              />
            </div>
          </div>
          <figcaption className={styles.caption}>{product.caption}</figcaption>
        </figure>
      </div>
      <div className={styles.productEdge} aria-hidden="true">
        {EDGE.map((layer) => (
          <svg key={layer.color} viewBox="0 0 1600 160" preserveAspectRatio="xMidYMax slice">
            <path d={layer.path} fill={layer.color} />
          </svg>
        ))}
      </div>
    </section>
  );
}
