import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const fixtureDirectory = resolve(frontend, ".workflow-graph-fixture");
export const initialGraph = {
  graph: {
    schema_version: 1,
    nodes: [
      { id: "trigger", type: "trigger", config: { event_type: "lead.created", program_id: null } },
      { id: "condition", type: "condition", config: { field: null, operator: null } },
      { id: "delay", type: "delay", config: { mode: "duration", minutes: 60 } },
      {
        id: "email",
        type: "email",
        config: {
          recipient: "lead_or_guardian",
          subject_template: "Welcome to the studio",
          body_template: "Hello {{lead_first_name}}",
          reply_to_email: "",
        },
      },
      { id: "follow", type: "lead_follow_up", config: { due_in_days: 2, note: "Call back" } },
      { id: "end", type: "end", config: {} },
    ],
    edges: [
      { id: "trigger_condition", source: "trigger", target: "condition", port: "next" },
      { id: "email_end", source: "email", target: "end", port: "next" },
      { id: "follow_end", source: "follow", target: "end", port: "next" },
    ],
  },
  layout: { positions: {} },
};
export const fixtureTheme = `html{color-scheme:dark}body{margin:0;background:#0b0d10;color:#f3f5f7;font:15px system-ui}main{max-width:1150px;margin:0 auto;padding:16px;box-sizing:border-box}main>button,main>label{display:inline-flex;align-items:center;min-height:44px;margin:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}*{box-sizing:border-box}:root{--surface:#12161b;--surface-raised:#171c22;--surface-hover:#1e2329;--border:#232a33;--text-primary:#f3f5f7;--text-secondary:#98a2b3;--accent:#d6b25e}@media(max-width:767px){main{padding:8px}}`;

export const workflowGraphOwnerSource = `"use client";
import React from 'react';
import {WorkflowGraphEditor} from '@/components/automations/workflow-graph-editor';
import {createWorkflowHistory, editWorkflowHistory, undoWorkflow, redoWorkflow} from '@/lib/automation-workflow-model';
const initial=${JSON.stringify(initialGraph)};
export default function Fixture(){
  const [state,setState]=React.useState(()=>({history:createWorkflowHistory(initial),actions:[]}));
  const [selected,setSelected]=React.useState(null);
  const [disabled,setDisabled]=React.useState(false);
  const [issues,setIssues]=React.useState([]);
  const edit=React.useCallback(edit=>setState(previous=>{const next=editWorkflowHistory(previous.history,edit);if(!next.ok)throw Error(next.reason);return {history:next.history,actions:next.changed?[...previous.actions,edit]:previous.actions};}),[]);
  const undo=React.useCallback(()=>setState(s=>({...s,history:undoWorkflow(s.history)})),[]);
  const redo=React.useCallback(()=>setState(s=>({...s,history:redoWorkflow(s.history)})),[]);
  React.useEffect(()=>{window.workflowFixture={draft:state.history.present,actions:state.actions,selected,disabled,edit,undo,redo,setDisabled,setIssues,reset:draft=>{setState({history:createWorkflowHistory(draft??initial),actions:[]});setSelected(null);}};},[state,selected,disabled,edit,undo,redo]);
  return <main><h1>Workflow graph test fixture</h1><p>Synthetic local test UI. No backend or customer data.</p><label><input type="checkbox" checked={disabled} onChange={e=>setDisabled(e.target.checked)}/> Disable editing</label><input aria-label="Native text undo fixture" defaultValue=""/><WorkflowGraphEditor draft={state.history.present} selectedNodeId={selected} onSelectNode={setSelected} onEdit={edit} onUndo={undo} onRedo={redo} canUndo={state.history.past.length>0} canRedo={state.history.future.length>0} disabled={disabled} issues={issues}/><p>Test action count: <output data-action-count>{state.actions.length}</output></p><p>Test selection: <output data-selected-node>{selected??'none'}</output></p><details><summary>Test graph JSON</summary><pre data-graph-json>{JSON.stringify(state.history.present,null,2)}</pre></details></main>;
}`;

async function prepare() {
  await mkdir(resolve(fixtureDirectory, "app"), { recursive: true });
  await writeFile(
    resolve(fixtureDirectory, "package.json"),
    JSON.stringify({ name: "workflow-graph-disposable-fixture", private: true, type: "module" }),
  );
  await writeFile(
    resolve(fixtureDirectory, "next.config.mjs"),
    `export default {turbopack:{root:${JSON.stringify(dirname(frontend))}},outputFileTracingRoot:${JSON.stringify(dirname(frontend))},devIndicators:false};`,
  );
  await writeFile(
    resolve(fixtureDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2017",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "react-jsx",
        allowImportingTsExtensions: true,
        paths: { "@/*": ["../src/*"] },
      },
      include: ["next-env.d.ts", "app/**/*", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }),
  );
  await writeFile(
    resolve(fixtureDirectory, "app/layout.jsx"),
    `import './theme.css';export const metadata={title:'Workflow graph local fixture'};export default function Layout({children}){return <html lang="en"><body>{children}</body></html>}`,
  );
  await writeFile(resolve(fixtureDirectory, "app/theme.css"), fixtureTheme);
  await writeFile(resolve(fixtureDirectory, "app/page.jsx"), workflowGraphOwnerSource);
  await writeFile(
    resolve(fixtureDirectory, "proxy.js"),
    "export function proxy(){return undefined;} export const config={matcher:[]};",
  );
}
// The Next server can retain open handles after closing its listener. Bound cleanup
// to the child we created, and keep real startup/build failures observable.
export function settleFixtureChild(child, { stopSignals = process, graceMs = 2500 } = {}) {
  return new Promise((resolvePromise, reject) => {
    let stopping = false;
    let forceTimer;
    const cleanup = () => {
      stopSignals.off("SIGINT", stop);
      stopSignals.off("SIGTERM", stop);
      clearTimeout(forceTimer);
      child.off("error", fail);
      child.off("exit", finish);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, graceMs);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const finish = (code, signal) => {
      cleanup();
      if (stopping || code === 0) resolvePromise();
      else reject(new Error(`Next exited ${code ?? signal}`));
    };
    stopSignals.on("SIGINT", stop);
    stopSignals.on("SIGTERM", stop);
    child.once("error", fail);
    child.once("exit", finish);
  });
}
function next(args) {
  return settleFixtureChild(
    spawn(process.execPath, [resolve(frontend, "node_modules/next/dist/bin/next"), ...args], {
      cwd: fixtureDirectory,
      stdio: "inherit",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        NEXT_TELEMETRY_DISABLED: "1",
      },
    }),
  );
}
// Build: node tests/helpers/workflow-graph-fixture.mjs build
// Serve after build: node tests/helpers/workflow-graph-fixture.mjs serve --port 4317
// Stop with Ctrl-C. A lingering child is killed after 2.5 seconds, then clean: node tests/helpers/workflow-graph-fixture.mjs clean
// Only this known disposable directory is removed. No environment files are copied or read.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "clean") await rm(fixtureDirectory, { recursive: true, force: true });
  else if (command === "build") {
    await prepare();
    await next(["build"]);
  } else if (command === "serve") {
    const port = Number(process.argv[4]);
    if (process.argv[3] !== "--port" || !Number.isInteger(port) || port < 1024 || port > 65535)
      throw Error("Use serve --port <explicit unused loopback port>");
    console.log(`Disposable fixture: ${fixtureDirectory}\nLoopback URL: http://127.0.0.1:${port}`);
    await next(["start", "--hostname", "127.0.0.1", "--port", String(port)]);
  } else throw Error("Use build, serve --port <port>, or clean");
}
