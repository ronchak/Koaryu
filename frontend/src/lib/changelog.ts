import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ChangelogSection {
  title: string;
  items: string[];
}

export interface ChangelogRelease {
  version: string;
  date: string;
  sections: ChangelogSection[];
}

async function readChangelog() {
  const changelogPath = path.resolve(process.cwd(), "CHANGELOG.md");
  try {
    return await readFile(changelogPath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") {
      throw new Error(`Release notes require ${changelogPath}.`);
    }
    throw error;
  }
}

function parseHeading(line: string) {
  const match = /^##\s+(.+?)\s+-\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  return { version: match[1].trim(), date: match[2].trim() };
}

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let currentRelease: ChangelogRelease | null = null;
  let currentSection: ChangelogSection | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const releaseHeading = parseHeading(line);

    if (releaseHeading) {
      if (currentRelease && currentRelease.date.toLowerCase() !== "unreleased") {
        releases.push(currentRelease);
      }
      currentRelease = {
        version: releaseHeading.version,
        date: releaseHeading.date,
        sections: [],
      };
      currentSection = null;
      continue;
    }

    if (!currentRelease) continue;

    if (line.startsWith("### ")) {
      currentSection = { title: line.replace(/^###\s+/, "").trim(), items: [] };
      currentRelease.sections.push(currentSection);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!currentSection) {
        currentSection = { title: "Changed", items: [] };
        currentRelease.sections.push(currentSection);
      }
      currentSection.items.push(line.slice(2).trim());
    }
  }

  if (currentRelease && currentRelease.date.toLowerCase() !== "unreleased") {
    releases.push(currentRelease);
  }

  return releases.filter((release) => release.sections.some((section) => section.items.length > 0));
}

export async function getReleasedChangelog(): Promise<ChangelogRelease[]> {
  return parseChangelog(await readChangelog());
}
