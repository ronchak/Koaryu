import type { Metadata } from "next";
import Link from "next/link";
import { PublicGuide } from "@/components/marketing/public-guide";
import { SUPPORT_EMAIL } from "@/lib/constants";

export const metadata: Metadata = {
  title: "Support | Koaryu",
  description: "Contact Koaryu for account, studio and assistant-connection help.",
  alternates: { canonical: "https://koaryu.app/support" },
};

export default function SupportPage() {
  return (
    <PublicGuide
      eyebrow="Koaryu support"
      title="Get help with Koaryu."
      introduction="Tell us what you were trying to do, what happened and which screen you were on."
    >
      <section>
        <h2>Contact us</h2>
        <p>
          Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Include your studio’s name
          and a short description of the issue. You do not need to sign in to contact support.
        </p>
        <p>
          Do not include passwords, sign-in codes, connection tokens or payment-card details. If you
          share a screenshot, remove student and family information that is unrelated to the issue.
        </p>
      </section>
      <section>
        <h2>Assistant connections</h2>
        <p>
          Start with the <Link href="/ai-connections">assistant connection guide</Link>. If an
          assistant is still awaiting sign-in, finish connecting through that assistant. Review an
          expired connection in Settings → AI connections before renewing it.
        </p>
        <p>
          To stop future access, disconnect the assistant in Koaryu. Tell support the assistant’s
          name and the time of the failure. Please do not send its token or the studio records it
          returned.
        </p>
      </section>
      <section>
        <h2>Account and privacy questions</h2>
        <p>
          Use the same inbox for account access, privacy or deletion requests. Our{" "}
          <Link href="/privacy">privacy policy</Link> explains how Koaryu handles information, and
          the <Link href="/terms">terms of service</Link> cover use of Koaryu.
        </p>
      </section>
    </PublicGuide>
  );
}
