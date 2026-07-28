import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const immutableGitHubReference = /^[^@\s]+\/[^@\s]+@[0-9a-f]{40}$/i;
const readableVersion = /^v?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/;

export function validateWorkflowActionPins(source, workflowPath = "workflow") {
  const errors = [];

  for (const [index, line] of source.split("\n").entries()) {
    if (!/^\s*(?:-\s*)?(?:"uses"|'uses'|uses)\s*:/.test(line)) {
      continue;
    }

    const match = line.match(
      /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?\s*$/,
    );
    const location = `${workflowPath}:${index + 1}`;

    if (!match) {
      errors.push(`${location} must use a single-line, reviewable action reference.`);
      continue;
    }

    const [, reference, versionComment] = match;
    if (reference.startsWith("./")) {
      continue;
    }

    if (reference.startsWith("docker://")) {
      errors.push(
        `${location} uses a Docker action that the configured GitHub Actions updater cannot maintain.`,
      );
      continue;
    }

    if (!immutableGitHubReference.test(reference)) {
      errors.push(
        `${location} must pin ${reference} to a full 40-character commit SHA.`,
      );
      continue;
    }

    if (!versionComment || !readableVersion.test(versionComment)) {
      errors.push(
        `${location} must keep a readable version comment beside ${reference}.`,
      );
    }
  }

  return errors;
}

export function findWorkflowFiles(workflowDirectory) {
  const files = [];

  for (const entry of fs.readdirSync(workflowDirectory, { withFileTypes: true })) {
    const entryPath = path.join(workflowDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...findWorkflowFiles(entryPath));
    } else if (/\.ya?ml$/i.test(entry.name)) {
      files.push(entryPath);
    }
  }

  return files.sort();
}

export function validateWorkflowDirectory(workflowDirectory) {
  const errors = [];
  const workflowFiles = findWorkflowFiles(workflowDirectory);

  if (workflowFiles.length === 0) {
    return [`${workflowDirectory} contains no workflow files.`];
  }

  for (const workflowFile of workflowFiles) {
    errors.push(
      ...validateWorkflowActionPins(
        fs.readFileSync(workflowFile, "utf8"),
        path.relative(process.cwd(), workflowFile),
      ),
    );
  }

  return errors;
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const workflowDirectory = path.join(scriptDirectory, "..", ".github", "workflows");
  const errors = validateWorkflowDirectory(workflowDirectory);

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log("Workflow action references are immutable and maintainable.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
