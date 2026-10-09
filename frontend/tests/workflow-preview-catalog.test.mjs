import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { compileCommonJsModule } from "./helpers/store-browser-harness.mjs";
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../..");
function previewPythonPath() {
  const override = process.env.PYTHON?.trim();
  if (override) return override;
  if (process.platform === "win32") return "python";
  const local = resolve(root, "backend/venv/bin/python");
  try {
    execFileSync("test", ["-x", local], { cwd: root });
    return local;
  } catch {
    return "python3";
  }
}
const python = previewPythonPath();
const generator = resolve(root, "scripts/generate-workflow-preview-catalog.py");

test("preview snapshot matches the actual pure catalog, is deterministic and detects deliberate drift", () => {
  execFileSync(python, [generator, "--check"], { cwd: root });
  const result = spawnSync(
    python,
    [
      "-c",
      `
import pathlib, runpy, sys, tempfile
module = runpy.run_path(${JSON.stringify(generator)})
main = module['main']
with tempfile.TemporaryDirectory() as directory:
    main.__globals__['ROOT'] = pathlib.Path(directory)
    target = pathlib.Path(directory) / 'frontend/src/lib/generated/workflow-preview-catalog.json'
    sys.argv = ['generator']
    assert main() == 0
    first = target.read_bytes()
    assert main() == 0 and first == target.read_bytes()
    sys.argv = ['generator', '--check']
    assert main() == 0
    target.write_text('{}\\n')
    assert main() == 1
`,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /differs/);
  const snapshot = JSON.parse(
    readFileSync(resolve(root, "frontend/src/lib/generated/workflow-preview-catalog.json"), "utf8"),
  );
  assert.ok(snapshot.presets.length >= 2);
  assert.ok(snapshot.triggers["student.promoted"]);
  assert.equal(Object.hasOwn(snapshot, "capabilities"), false);
});

function route(relative) {
  const filename = resolve(root, "frontend/src/app/(dashboard)/automations", relative, "page.tsx");
  const code = compileCommonJsModule(readFileSync(filename, "utf8"), filename);
  const exports = {};
  const notFound = () => {
    throw Error("NOT_FOUND");
  };
  new Function("require", "exports", "module", code)(
    (specifier) =>
      specifier === "next/navigation"
        ? { notFound }
        : specifier.startsWith("@/")
          ? { WorkflowWorkspace: "workspace", Header: "header", OperationsSurface: "surface" }
          : require(specifier),
    exports,
    { exports },
  );
  return exports.default;
}
test("route wrappers await exact UUID inputs and reject missing, repeated and malformed inputs", async () => {
  const saved = route("[workflowId]"),
    draft = route("new");
  const id = "40000000-0000-4000-8000-000000000001";
  const uppercase = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
  assert.equal(
    (await saved({ params: Promise.resolve({ workflowId: uppercase }) })).props.children[1].props
      .workflowId,
    uppercase.toLowerCase(),
  );
  assert.equal(
    (await draft({ searchParams: Promise.resolve({ draft: uppercase }) })).props.children[1].props
      .draftId,
    uppercase.toLowerCase(),
  );
  let release;
  const params = new Promise((resolve) => {
    release = resolve;
  });
  let done = false;
  const pending = saved({ params }).then((result) => {
    done = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(done, false);
  release({ workflowId: id });
  assert.equal((await pending).props.children[1].props.workflowId, id);
  assert.equal(
    (await draft({ searchParams: Promise.resolve({ draft: id }) })).props.children[1].props.draftId,
    id,
  );
  for (const value of [undefined, "", [id], [id, id], "javascript:alert(1)", "new", id + "/more"])
    await assert.rejects(draft({ searchParams: Promise.resolve({ draft: value }) }), /NOT_FOUND/);
  for (const value of [undefined, "bad", [id]])
    await assert.rejects(saved({ params: Promise.resolve({ workflowId: value }) }), /NOT_FOUND/);
});
