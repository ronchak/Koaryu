import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createCommonJsPacker } from "./store-browser-harness.mjs";
import { frontend, fixtureTheme, workflowGraphOwnerSource } from "./workflow-graph-fixture.mjs";

const componentCss = readFileSync(
  resolve(frontend, "src/components/automations/workflow-graph-editor.module.css"),
  "utf8",
);
const classes = Object.fromEntries(
  [...componentCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => [match[1], match[1]]),
);
export const workflowGraphCss =
  fixtureTheme +
  componentCss.replace(/:global\(([^)]+)\)/g, "$1") +
  readFileSync(resolve(frontend, "node_modules/@xyflow/react/dist/style.css"), "utf8");

export function bundleWorkflowGraph(mode = "production") {
  const { add, modules } = createCommonJsPacker({
    "./workflow-graph-editor.module.css": `module.exports=${JSON.stringify(classes)}`,
    "@xyflow/react/dist/style.css": "module.exports={};",
    "next/dynamic": `const React=require('react');module.exports=(loader,options)=>{const Lazy=React.lazy(loader);return props=>React.createElement(React.Suspense,{fallback:React.createElement(options.loading)},React.createElement(Lazy,props));};`,
    "workflow-graph-fixture.tsx": workflowGraphOwnerSource,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const fixture = add("workflow-graph-fixture.tsx");
  return `(()=>{const process={env:{NODE_ENV:${JSON.stringify(mode)}}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(${mode === "development" ? "React.StrictMode" : "React.Fragment"},null,React.createElement(require(${fixture}).default)));})();`;
}
