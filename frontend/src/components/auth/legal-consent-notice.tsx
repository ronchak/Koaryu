import Link from "next/link";

const linkClassName = "text-text-secondary underline underline-offset-2 hover:text-text-primary";

/** Sign-up, including through Google or Microsoft, is where the Terms are accepted. */
export function LegalConsentNotice({ action }: { action: string }) {
  return (
    <p className="mt-4 text-center text-xs leading-relaxed text-muted">
      By {action}, you agree to Koaryu&rsquo;s{" "}
      <Link href="/terms" prefetch={false} className={linkClassName}>
        Terms of Service
      </Link>{" "}
      and acknowledge the{" "}
      <Link href="/privacy" prefetch={false} className={linkClassName}>
        Privacy Policy
      </Link>
      .
    </p>
  );
}
