import { MarketingBrandLink } from "@/components/marketing/marketing-primitives";
import { MarketingRoot } from "@/components/marketing/marketing-root";
import {
  PublicDocumentLink,
  PublicMobileNavigation,
} from "@/components/marketing/public-navigation";
import { publicFooterLinks, publicNavLinks } from "@/lib/public-navigation";

import styles from "./public-pages.module.css";

export function MarketingHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <MarketingBrandLink href="/" className={styles.brand} />
        <nav className={styles.primaryNavigation} aria-label="Primary navigation">
          {publicNavLinks.map((link) => (
            <PublicDocumentLink key={link.href} href={link.href}>
              {link.label}
            </PublicDocumentLink>
          ))}
        </nav>
        <PublicDocumentLink href="/login" prefetch={false} className={styles.desktopSignIn}>
          Sign in
        </PublicDocumentLink>
        <PublicMobileNavigation>
          {publicNavLinks.map((link) => (
            <PublicDocumentLink key={link.href} href={link.href}>
              {link.label}
            </PublicDocumentLink>
          ))}
          <PublicDocumentLink href="/login" prefetch={false}>
            Sign in
          </PublicDocumentLink>
        </PublicMobileNavigation>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerStatement}>
          <MarketingBrandLink href="/" className={styles.brand} />
          <p>Studio software for independent martial arts schools.</p>
        </div>
        <nav className={styles.footerNavigation} aria-label="Footer navigation">
          {publicFooterLinks.map((link) => (
            <PublicDocumentLink key={link.href} href={link.href}>
              {link.label}
            </PublicDocumentLink>
          ))}
        </nav>
      </div>
    </footer>
  );
}

export function PublicPageShell({ children }: { children: React.ReactNode }) {
  return (
    <MarketingRoot layout="document" className={styles.shell}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to content
      </a>
      <MarketingHeader />
      <main id="main-content" tabIndex={-1} className={styles.main}>
        {children}
      </main>
      <MarketingFooter />
    </MarketingRoot>
  );
}

export function PageStructuredData({ data }: { data: Record<string, unknown> }) {
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }} />
  );
}

export function BreadcrumbJsonLd({ items }: { items: Array<{ name: string; url: string }> }) {
  return (
    <PageStructuredData
      data={{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.name,
          item: item.url,
        })),
      }}
    />
  );
}
