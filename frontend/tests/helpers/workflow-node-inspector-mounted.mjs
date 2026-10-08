import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCommonJsPacker } from "./store-browser-harness.mjs";
import { frontend, initialGraph } from "./workflow-graph-fixture.mjs";
import { workflowGraphCss } from "./workflow-graph-mounted.mjs";
import { createWorkflowNodeInspectorOwnerSource } from "./workflow-node-inspector-fixture.mjs";

const css = readFileSync(
  resolve(frontend, "src/components/automations/workflow-node-inspector.module.css"),
  "utf8",
);
const classes = Object.fromEntries(
  [...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => [match[1], `inspector_${match[1]}`]),
);
const graphCss = readFileSync(
  resolve(frontend, "src/components/automations/workflow-graph-editor.module.css"),
  "utf8",
);
const graphClasses = Object.fromEntries(
  [...graphCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => [match[1], match[1]]),
);
export const workflowInspectorCss =
  workflowGraphCss + css.replace(/\.([a-zA-Z][\w-]*)/g, (_, name) => `.${classes[name]}`);
export function bundleWorkflowInspector(mode = "production") {
  const { add, modules } = createCommonJsPacker({
    "./workflow-node-inspector.module.css": `module.exports=${JSON.stringify(classes)}`,
    "./workflow-graph-editor.module.css": `module.exports=${JSON.stringify(graphClasses)}`,
    "@xyflow/react/dist/style.css": "module.exports={};",
    "next/dynamic": `const React=require('react');module.exports=(loader,options)=>{const Lazy=React.lazy(loader);return props=>React.createElement(React.Suspense,{fallback:React.createElement(options.loading)},React.createElement(Lazy,props));};`,
    "workflow-node-inspector-fixture.tsx": createWorkflowNodeInspectorOwnerSource(initialGraph),
  });
  const react = add("react"),
    dom = add("react-dom/client"),
    fixture = add("workflow-node-inspector-fixture.tsx");
  return `(()=>{const process={env:{NODE_ENV:${JSON.stringify(mode)}}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(${mode === "development" ? "React.StrictMode" : "React.Fragment"},null,React.createElement(require(${fixture}).default)));})();`;
}
