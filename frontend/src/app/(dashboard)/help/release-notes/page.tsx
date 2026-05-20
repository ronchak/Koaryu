import { CheckCircle2 } from "lucide-react";
import { AccountPageShell, AccountSection } from "@/components/account-page-shell";
import { getReleasedChangelog } from "@/lib/changelog";

export default async function ReleaseNotesPage() {
  const releases = await getReleasedChangelog();

  return (
    <AccountPageShell
      title="Release notes"
      description="Released Koaryu changes pulled directly from the changelog."
    >
      <div className="space-y-4">
        {releases.map((release) => (
          <AccountSection key={release.version} title={`Version ${release.version}`} description={release.date}>
            <div className="space-y-5">
              {release.sections.map((section) => (
                <section key={`${release.version}-${section.title}`} className="space-y-3">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted">{section.title}</h3>
                  <ul className="space-y-3">
                    {section.items.map((item) => (
                      <li key={item} className="flex gap-3 text-sm text-text-secondary">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-success" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </AccountSection>
        ))}
        {releases.length === 0 && (
          <AccountSection title="No release notes yet">
            <p className="text-sm text-text-secondary">
              Released changes will appear here once they are recorded in the changelog.
            </p>
          </AccountSection>
        )}
      </div>
    </AccountPageShell>
  );
}
