import { AccountNotice, AccountPageShell, AccountSection } from "@/components/account-page-shell";

export default function TermsPage() {
  return (
    <AccountPageShell
      title="Terms of Service"
      description="Operating terms for Koaryu studio management and billing tools."
      badge="Updated May 19, 2026"
    >
      <AccountSection title="Agreement to these terms">
        <p className="text-sm leading-relaxed text-text-secondary">
          By creating an account, accessing Koaryu, or using Koaryu to manage studio operations, you agree to use the
          service responsibly and only for lawful studio administration, communication, reporting, scheduling, and
          billing workflows.
        </p>
      </AccountSection>

      <AccountSection title="Accounts and studio access">
        <p className="text-sm leading-relaxed text-text-secondary">
          You are responsible for keeping account credentials secure, inviting only authorized staff, assigning
          appropriate staff roles, and promptly removing access for people who should no longer use the studio workspace.
          Actions taken inside a studio workspace may be recorded for operational, audit, billing, or support purposes.
        </p>
      </AccountSection>

      <AccountSection title="Koaryu Core and Koaryu Payments">
        <div className="space-y-3 text-sm leading-relaxed text-text-secondary">
          <p>
            Koaryu Core is the studio subscription that provides access to the Koaryu software. Koaryu Payments lets an
            eligible connected studio charge students or payers through Stripe Connect.
          </p>
          <p>
            Studios are responsible for obtaining authorization before charging a payer or enabling autopay, keeping
            billing plans accurate, issuing refunds when appropriate, responding to disputes, and maintaining required
            Stripe Connect account information.
          </p>
          <p>
            Stripe may charge processing fees, enforce its own platform rules, request additional verification, delay
            payouts, or reject transactions. Koaryu stores payment metadata and Stripe object references, but Koaryu does
            not store raw card numbers.
          </p>
        </div>
      </AccountSection>

      <AccountSection title="Studio data">
        <p className="text-sm leading-relaxed text-text-secondary">
          Studios are responsible for the accuracy, permissions, and lawful use of student, guardian, staff, schedule,
          attendance, rank, lead, report, and billing records entered into Koaryu. Admin-only demo reset and data-clearing
          tools are destructive and should be used only when replacement or deletion of working studio records is
          intended.
        </p>
      </AccountSection>

      <AccountSection title="Availability and changes">
        <p className="text-sm leading-relaxed text-text-secondary">
          Koaryu may change, improve, limit, suspend, or discontinue features as the product evolves. Service
          availability can be affected by maintenance, hosting providers, network conditions, browser behavior, Supabase,
          Stripe, or other third-party dependencies.
        </p>
      </AccountSection>

      <AccountSection title="Support">
        <p className="text-sm leading-relaxed text-text-secondary">
          For account, billing, or support questions, contact Koaryu at support@koaryu.app with the relevant studio name,
          user email, workflow, and any invoice or payment identifiers that appear in the product.
        </p>
      </AccountSection>

      <AccountNotice>
        Koaryu may update these terms as the product, pricing, support process, business details, and payment
        configuration evolve. Continued use of Koaryu after an update means the updated terms apply.
      </AccountNotice>
    </AccountPageShell>
  );
}
