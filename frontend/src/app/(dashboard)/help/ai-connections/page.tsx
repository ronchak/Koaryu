import Link from "next/link";
import { AccountPageShell, AccountSection } from "@/components/account-page-shell";

export default function AiConnectionsHelp() {
  return (
    <AccountPageShell
      family="help"
      title="Connect your AI assistant"
      description="Ask your own questions about the studio information you choose to share."
    >
      <AccountSection title="Before you connect">
        <div className="space-y-3 text-sm leading-6 text-text-secondary">
          <p>
            Sign in as a studio admin and open{" "}
            <Link href="/settings#ai-connections" className="underline">
              Settings → AI connections
            </Link>
            . If connections are enabled, copy the server address shown there.
          </p>
          <p>
            Your assistant needs support for remote MCP servers with OAuth. Availability depends on
            your AI account and workspace settings. Koaryu does not supply an AI subscription.
          </p>
        </div>
      </AccountSection>
      <AccountSection title="ChatGPT">
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-6 text-text-secondary">
          <li>
            In ChatGPT, open Plugins and choose Add custom MCP server. Enter the Koaryu server
            address and select OAuth authentication.
          </li>
          <li>
            Install the connection. Sign in to Koaryu when prompted, check the assistant name and
            return address, and choose the information it can read and an expiration.
          </li>
          <li>
            Select the Koaryu connection in a conversation and ask: “Which studio am I connected to,
            and what data can you read?”
          </li>
        </ol>
        <p className="mt-4 text-sm">
          <a
            className="underline"
            href="https://developers.openai.com/plugins/deploy/connect-chatgpt"
            target="_blank"
            rel="noreferrer"
          >
            Current ChatGPT setup instructions
          </a>
        </p>
      </AccountSection>
      <AccountSection title="Claude Code">
        <div className="space-y-3 text-sm leading-6 text-text-secondary">
          <p>Add the server using your own server address from Settings:</p>
          <pre className="overflow-x-auto rounded-lg bg-surface-raised p-4">
            <code>claude mcp add --transport http koaryu YOUR_SERVER_ADDRESS</code>
          </pre>
          <p>
            Open <code>/mcp</code>, choose Koaryu and authenticate. Complete the Koaryu permission
            screen, then ask what information is available.
          </p>
        </div>
      </AccountSection>
      <AccountSection title="Manage or renew access">
        <div className="space-y-3 text-sm leading-6 text-text-secondary">
          <p>
            In Settings → AI connections, choose Edit access to change the information an assistant
            may read. Keeping the current expiration changes permissions immediately without
            extending access. Choose a new duration only when you want to renew it.
          </p>
          <p>
            For an expired connection, choose Renew access and review the selected information
            before saving. A connection marked Awaiting assistant still needs its sign-in completed
            in that assistant. Disconnect resets an unfinished or unwanted connection.
          </p>
          <p>
            If sign-in still loops after renewal, disconnect in Koaryu and start a fresh connection
            in your assistant. A disconnected connection needs a new sign-in; editing it cannot
            restore access. Your assistant can retain information it already received.
          </p>
        </div>
      </AccountSection>
      <AccountSection title="Ask your own questions">
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-text-secondary">
          <li>Compare attendance by program and month.</li>
          <li>List active students with a particular tag.</li>
          <li>Show leads whose follow-up dates have passed.</li>
          <li>Show the next two weeks of classes, including recurring classes.</li>
          <li>With financial access enabled, total recorded open invoice balances by currency.</li>
        </ul>
        <p className="mt-4 text-sm text-text-secondary">
          These are examples. The connector supports flexible filters, related records, sorting and
          grouping. Ask the assistant to show the records and dates behind its answer. Financial
          information reflects Koaryu&apos;s stored state. Large questions may need a narrower date
          range; Koaryu refuses incomplete totals.
        </p>
      </AccountSection>
      <AccountSection title="Control access">
        <div className="space-y-3 text-sm leading-6 text-text-secondary">
          <p>
            Connections can only read. Contact details, birth dates and addresses, financial
            records, and notes require the permissions you select. Notes and other entered text may
            include sensitive information.
          </p>
          <p>
            Disconnect in Settings to stop future access. To change permissions or reconnect after
            expiry, disconnect first, then start a new connection from your assistant. Reconnecting
            replaces the previous session for that assistant.
          </p>
          <p>
            Your AI service can retain information already received according to its own settings
            and policies. Disconnecting does not remove those copies. Koaryu keeps the
            connection&apos;s selected permissions and latest access time, tool, dataset and row
            count, without saving the returned records in a connector log.
          </p>
          <p>
            If sign-in fails, check that you are an active admin with access to your studio. If your
            assistant says information is unavailable, verify the selected permissions in Settings.
            An unavailable dataset does not mean the studio has no matching records.
          </p>
        </div>
      </AccountSection>
    </AccountPageShell>
  );
}
