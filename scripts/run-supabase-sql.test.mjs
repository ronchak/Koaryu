import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const runner = fileURLToPath(new URL("./run-supabase-sql.sh", import.meta.url));
const mcp = fileURLToPath(new URL("../supabase/verification/mcp_read_connections_contract.sql", import.meta.url));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "koaryu-sql-runner-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "docker.json");
  const ordinary = join(directory, "ordinary.sql");
  writeFileSync(ordinary, "SELECT 1;\n");
  writeFileSync(join(directory, "supabase"), `#!/usr/bin/env python3
import json,os
print(json.dumps({"DB_URL":os.environ["KOARYU_TEST_SQL_URL"]}))
`, { mode: 0o700 });
  writeFileSync(join(directory, "docker"), `#!/usr/bin/env python3
import json,os,sys
if sys.argv[1]=="ps":
 print("supabase_db_contract\\t127.0.0.1:54322->5432/tcp")
elif sys.argv[1]=="exec":
 with open(os.environ["KOARYU_TEST_DOCKER_LOG"],"w") as output:
  json.dump({"args":sys.argv[1:],"sql":sys.stdin.read()},output)
else:
 raise RuntimeError("Unexpected Docker command")
`, { mode: 0o700 });
  function run(sql, url = "postgresql://postgres:synthetic@127.0.0.1:54322/postgres?sslmode=disable") {
    return spawnSync("bash", [runner, sql], {
      encoding: "utf8",
      env: { ...process.env, PATH: directory + delimiter + process.env.PATH, SUPABASE_DB_TARGET: "local", SUPABASE_WORKDIR: "", KOARYU_TEST_SQL_URL: url, KOARYU_TEST_DOCKER_LOG: log },
    });
  }
  return { run, ordinary, read: () => JSON.parse(readFileSync(log, "utf8")) };
}

test("the native MCP Auth-role contract uses only the disposable local bootstrap administrator", (t) => {
  const { run, read } = fixture(t);
  const result = run(mcp);
  assert.equal(result.status, 0, result.stderr);
  const executed = read();
  assert.equal(executed.args[executed.args.indexOf("-U") + 1], "supabase_admin");
  assert.equal(executed.sql, readFileSync(mcp, "utf8"));
  assert.match(executed.sql, /SET LOCAL ROLE supabase_auth_admin/);
});

test("ordinary local contracts retain postgres and unchanged SQL", (t) => {
  const { run, ordinary, read } = fixture(t);
  const result = run(ordinary);
  assert.equal(result.status, 0, result.stderr);
  const executed = read();
  assert.equal(executed.args[executed.args.indexOf("-U") + 1], "postgres");
  assert.equal(executed.sql, "SELECT 1;\n");
});

test("another file with the MCP contract name retains postgres", (t) => {
  const { run, ordinary, read } = fixture(t);
  const other = ordinary.replace("ordinary.sql", "mcp_read_connections_contract.sql");
  writeFileSync(other, "SELECT 1;\n");
  const result = run(other);
  assert.equal(result.status, 0, result.stderr);
  const executed = read();
  assert.equal(executed.args[executed.args.indexOf("-U") + 1], "postgres");
});

test("a non-loopback status URL is refused before running any contract", (t) => {
  const { run, ordinary } = fixture(t);
  const result = run(ordinary, "postgresql://postgres:synthetic@db.remote.invalid:5432/postgres");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /loopback|resolve the local/);
});
