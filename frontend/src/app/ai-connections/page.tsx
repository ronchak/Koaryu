import type { Metadata } from "next";
import Link from "next/link";
import { PublicGuide } from "@/components/marketing/public-guide";

export const metadata: Metadata = {
  title: "Connect your assistant | Koaryu",
  description:
    "Ask your own questions about your martial arts studio. Choose what your assistant can read, review its access and disconnect in Koaryu.",
  alternates: { canonical: "https://koaryu.app/ai-connections" },
};

export default function AssistantConnectionsPage() {
  return (
    <PublicGuide
      eyebrow="Koaryu AI connections"
      title="Your studio. Your questions."
      introduction="Let your assistant read the studio information you choose, so you can explore it in your own conversation."
    >
      <section>
        <h2>Ask beyond a fixed report</h2>
        <p>
          Compare attendance, look up a student’s program memberships, review overdue lead
          follow-ups or explore recorded invoice balances. You can combine filters, dates and
          related records, then ask a follow-up question. These examples are starting points.
        </p>
        <ul>
          <li>“Compare attendance by program over the last three months.”</li>
          <li>“Which active students have the competition tag?”</li>
          <li>“Show my next two weeks of classes, including recurring classes.”</li>
          <li>“Total recorded open invoice balances, keeping currencies separate.”</li>
        </ul>
        <p>
          Ask for the date range and records behind an answer. Financial reads use Koaryu’s stored
          records. Large questions may need a smaller date window; the connector refuses incomplete
          totals.
        </p>
      </section>
      <section>
        <h2>Choose what leaves your studio</h2>
        <p>
          Sign in as a studio admin, check the assistant’s name and return address, then select the
          information it may read and when access expires. Contact details, dates of birth, home
          addresses and free-text notes require explicit selection.
        </p>
        <p>
          Selected information goes to the AI service you connect. Notes can contain sensitive
          personal information. Read that service’s policies before sharing. Your assistant cannot
          change studio records, send messages or collect payments through this connection.
        </p>
      </section>
      <section>
        <h2>Connect an enabled studio</h2>
        <ol>
          <li>
            Open <Link href="/settings#ai-connections">Settings → AI connections</Link>. If
            connections are enabled for your server, copy the address shown there.
          </li>
          <li>
            Add the address to an assistant that supports remote MCP with OAuth. In ChatGPT, use its
            custom MCP connection setup. Availability depends on your AI account and workspace
            permissions. Koaryu does not provide an AI subscription.
          </li>
          <li>
            Complete the Koaryu sign-in and permission screen. Then ask: “Which studio am I
            connected to, and what can you read?”
          </li>
        </ol>
        <p>
          <Link href="/help/ai-connections">Signed-in setup and recovery guide</Link>. For the
          current ChatGPT connection steps, see the{" "}
          <a href="https://developers.openai.com/plugins/deploy/connect-chatgpt">
            official OpenAI instructions
          </a>
          . This guide does not indicate that Koaryu has a public ChatGPT listing.
        </p>
      </section>
      <section>
        <h2>Change your mind at any time</h2>
        <p>
          In Settings → AI connections, edit permissions, explicitly renew an expiration or
          disconnect. Changes apply to future reads immediately. Disconnecting cannot remove
          information an assistant has already received.
        </p>
        <p>
          If a connection expires, review its permissions and choose Renew access. If sign-in loops,
          disconnect it in Koaryu and start again in your assistant. An unfinished connection is
          marked Awaiting assistant.
        </p>
        <p>
          <Link href="/support">Get help</Link> or read the{" "}
          <Link href="/privacy">privacy policy</Link> and{" "}
          <Link href="/terms">terms of service</Link>.
        </p>
      </section>
    </PublicGuide>
  );
}
