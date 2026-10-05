import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const { catalog, source_sha: catalogSourceSha } = JSON.parse(
  readFileSync(resolve(frontend, "tests/fixtures/workflow-catalog.json"), "utf8"),
);
export const backendUnicodeDraft = JSON.parse(
  readFileSync(resolve(frontend, "tests/fixtures/workflow-unicode-draft.json"), "utf8"),
);
export const references = {
  "program.id": {
    status: "ready",
    choices: [
      { id: "11111111-1111-4111-8111-111111111111", label: "Junior program" },
      { id: "22222222-2222-4222-8222-222222222222", label: "Adult program" },
    ],
  },
  "promotion.rank_id": {
    status: "ready",
    choices: [{ id: "33333333-3333-4333-8333-333333333333", label: "Blue belt" }],
  },
};
const fixtureThemes = `.inspectorFixture{--danger:#e05a5a}.inspectorFixture[data-theme="light"]{color-scheme:light;--bg:#f7f8fa;--surface:#fff;--surface-raised:#eef1f5;--surface-hover:#e5e9f0;--border:#d9dee7;--text-primary:#111827;--text-secondary:#4b5565;--accent:#b88922;--danger:#c44545;background:var(--bg);color:var(--text-primary)}`;
export const createWorkflowNodeInspectorOwnerSource = (initialGraph) => `"use client";
import React from 'react';
import {WorkflowGraphEditor} from '@/components/automations/workflow-graph-editor';
import {WorkflowNodeInspector} from '@/components/automations/workflow-node-inspector';
import {createWorkflowHistory,editWorkflowHistory,undoWorkflow,redoWorkflow} from '@/lib/automation-workflow-model';
const initial=${JSON.stringify(initialGraph)};
const initialCatalog=${JSON.stringify(catalog)};
const initialReferences=${JSON.stringify(references)};
const themeStyles=${JSON.stringify(fixtureThemes)};
const unicodeDraft=${JSON.stringify(backendUnicodeDraft)};
export default function Fixture(){
 const [state,setState]=React.useState(()=>({history:createWorkflowHistory(initial),actions:[]}));
 const [selected,setSelected]=React.useState('condition');
 const [theme,setTheme]=React.useState('dark');
 const [disabled,setDisabled]=React.useState(false);
 const [issues,setIssues]=React.useState([]);
 const [catalog,setCatalog]=React.useState(initialCatalog);
 const [references,setReferences]=React.useState(initialReferences);
 const edit=React.useCallback(edit=>setState(previous=>{const next=editWorkflowHistory(previous.history,edit);if(!next.ok)throw Error(next.reason);return {history:next.history,actions:next.changed?[...previous.actions,edit]:previous.actions};}),[]);
 const undo=React.useCallback(()=>setState(s=>({...s,history:undoWorkflow(s.history)})),[]);
 const redo=React.useCallback(()=>setState(s=>({...s,history:redoWorkflow(s.history)})),[]);
 React.useEffect(()=>{window.workflowFixture={draft:state.history.present,actions:state.actions,selected,disabled,edit,undo,redo,setDisabled,setIssues,setSelected,setCatalog,setReferences,reset:draft=>{setState({history:createWorkflowHistory(draft??initial),actions:[]});setSelected('condition');setDisabled(false);setIssues([]);setCatalog(initialCatalog);setReferences(initialReferences);}};},[state,selected,disabled,edit,undo,redo]);
 return <main className="inspectorFixture" data-theme={theme}><style>{themeStyles}</style><label>Fixture theme<select aria-label="Fixture theme" value={theme} onChange={event=>setTheme(event.target.value)}><option value="dark">Dark</option><option value="light">Light</option></select></label><h1>Workflow node inspector fixture</h1><p>Synthetic local UI. No backend, customer data, or email sending.</p><label><input type="checkbox" checked={disabled} onChange={e=>setDisabled(e.target.checked)}/> Disable editing</label><button type="button" onClick={()=>{setState({history:createWorkflowHistory(unicodeDraft),actions:[]});setSelected("email");setDisabled(false);setIssues([]);setCatalog(initialCatalog);setReferences(initialReferences);}}>Load backend Unicode draft</button><label>Inspect synthetic step<select aria-label="Inspect synthetic step" value={selected??''} onChange={e=>setSelected(e.target.value||null)}><option value="">None</option>{state.history.present.graph.nodes.map(node=><option key={node.id} value={node.id}>{node.id}</option>)}</select></label><WorkflowGraphEditor draft={state.history.present} selectedNodeId={selected} onSelectNode={setSelected} onEdit={edit} onUndo={undo} onRedo={redo} canUndo={state.history.past.length>0} canRedo={state.history.future.length>0} disabled={disabled} issues={issues}/><WorkflowNodeInspector draft={state.history.present} selectedNodeId={selected} catalog={catalog} references={references} onEdit={edit} onClose={()=>setSelected(null)} disabled={disabled} issues={issues}/><p>Test action count: <output data-action-count>{state.actions.length}</output></p><details><summary>Test graph JSON</summary><pre data-graph-json>{JSON.stringify(state.history.present,null,2)}</pre></details></main>;
}`;
