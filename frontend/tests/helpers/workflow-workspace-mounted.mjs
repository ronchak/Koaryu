import { createCommonJsPacker } from "./store-browser-harness.mjs";
import { catalog, detail, ids, owner } from "./workflow-workspace-fixture.mjs";

export function bundleWorkspace() {
  const { add, modules } = createCommonJsPacker({
    "@/lib/supabase/client": `exports.createClient=()=>({auth:{onAuthStateChange(callback){window.fixture.auth.add(callback);return {data:{subscription:{unsubscribe(){window.fixture.auth.delete(callback)}}}}}}});`,
    "@/lib/api": `class ApiError extends Error {constructor(message,status){super(message);this.status=status}};exports.ApiError=ApiError;exports.CommandOutcomeUnknown=require('@/lib/command-outcome').CommandOutcomeUnknown;exports.api={get:async(path,token)=>{window.fixture.reads.push({path,token});if(window.fixture.detailFailure) throw new ApiError('Temporarily unavailable',503);return structuredClone(path.endsWith('/catalog')?window.fixture.catalog:window.fixture.current)},post:(path,body,token)=>window.fixture.command(path,body,token),put:(path,body,token)=>window.fixture.command(path,body,token)};`,
    "workflow-workspace-consumer.tsx": `
      const React=require('react');
      const {getBrowserWorkflowWorkspace}=require('@/lib/automation-workflow-workspace-controller');
      const {publishAccessIdentity,invalidateAccessIdentity}=require('@/lib/access-identity');
      const {setActiveStudioIdCookie}=require('@/lib/studio-state-cookie');
      window.fixture.publish=(patch={})=>{window.fixture.profile={...window.fixture.profile,...patch};publishAccessIdentity(window.fixture.profile,patch.accessAllowed??true);};
      window.fixture.invalidate=invalidateAccessIdentity;
      setActiveStudioIdCookie(window.fixture.scope.studioId);
      publishAccessIdentity(window.fixture.profile,true);
      module.exports=function Consumer(){
        const [workspace]=React.useState(()=>getBrowserWorkflowWorkspace({mode:'live',owner:window.fixture.scope,token:window.fixture.token}));
        const state=React.useSyncExternalStore(workspace.subscribe,workspace.getSnapshot,workspace.getSnapshot);
        React.useEffect(()=>{window.fixture.workspace=workspace;if(!workspace.getSnapshot().editor) workspace.openNew(window.fixture.draftId);},[workspace]);
        return React.createElement('section',null,
          React.createElement('output',{'data-state':true},JSON.stringify(state)),
          React.createElement('input',{'aria-label':'Workflow name',value:state.editor?.name??'',onChange:event=>workspace.edit({kind:'metadata',name:event.target.value})}),
          React.createElement('button',{onClick:()=>workspace.submit(state.editor?.workflowId?'workflow.save':'workflow.create')},'Save'));
      };
    `,
  });
  const react = add("react"),
    dom = add("react-dom/client"),
    consumer = add("workflow-workspace-consumer.tsx");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}
    window.fixture={auth:new Set(),reads:[],requests:[],catalog:${JSON.stringify(catalog)},current:${JSON.stringify(detail())},scope:${JSON.stringify(owner)},draftId:'${ids.draft}',token:'token-1',profile:{user:{id:'${ids.user}'},studio_id:'${ids.studio}',role:'admin',membership_status:'active'},command(path,body,token){return new Promise((resolve,reject)=>this.requests.push({path,body,token,resolve,reject}));}};
    const React=require(${react}),root=require(${dom}).createRoot(document.getElementById('root')),Consumer=require(${consumer});
    let generation=0;window.fixture.mount=()=>root.render(React.createElement(Consumer,{key:++generation}));window.fixture.unmount=()=>root.render(null);window.fixture.mount();})();`;
}
