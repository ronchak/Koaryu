import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrialPanelFixture, LEAD } from "./trial-appointment-panel-mounted.mjs";

// Build only. The PM starts a loopback static server and performs Browser proof.
const destination = process.argv[2];
if (!destination) throw Error("Pass an absolute disposable output directory.");
if (!destination.startsWith("/")) throw Error("Use an absolute output directory.");
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const styles = await readFile(
  resolve(frontend, "src/components/leads/leads-ledger.module.css"),
  "utf8",
);
let script = await buildTrialPanelFixture();
script = script.replaceAll(
  "module.exports={};",
  "module.exports={__esModule:true,default:new Proxy({},{get:(_target,name)=>String(name)})};",
);
script += `
const qa=document.getElementById('qa');
function control(label, action){const button=document.createElement('button');button.textContent=label;button.onclick=action;qa.append(button);}
const originalWrite=f.write; f.write=(...args)=>{const promise=originalWrite(...args);const index=f.writes.length-1;setTimeout(()=>{f.commitTrial(index,{lose:Boolean(f.loseNext)});f.loseNext=false;},300);return promise;};
control('Lose next save response',()=>{f.loseNext=true;document.getElementById('qa-status').textContent='Next save will need Check result.';});
control('Hold current reads',()=>{f.holdDetails=true;document.getElementById('qa-status').textContent='Current detail reads are held.';});
control('Finish held reads',()=>{f.holdDetails=false;f.finishReads();document.getElementById('qa-status').textContent='Held reads finished.';});
control('Remove sample lead',async()=>{f.rows=f.rows.filter(row=>row.id!==${JSON.stringify(LEAD)});f.appointments=[];await f.store.refreshLeads();});
control('Make references unavailable',async()=>{f.programError=true;await f.store.refreshPrograms({includeArchived:true,force:true}).catch(()=>{});});
control('Restore references',()=>{f.programError=false;document.getElementById('qa-status').textContent='Use Retry program choices in the form.';});
`;
await mkdir(destination, { recursive: true });
await writeFile(
  resolve(destination, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sample trial appointment QA</title><style>
:root{--color-border:#ccd1d4;--color-surface-raised:#fff;--color-text-primary:#182229;--color-accent:#096f66;--color-surface:#f7f8f8;--color-text-secondary:#42525b;--color-muted:#55646a}*{box-sizing:border-box}body{margin:0;background:#f7f8f8;color:#182229;font:14px system-ui}button,input,select{font:inherit}button{min-height:44px;cursor:pointer}#qa{padding:12px;display:flex;gap:8px;flex-wrap:wrap;border-bottom:1px solid #ccd1d4}#qa-status{padding:8px}h1,h2,h3,h4,p{margin:0} ${styles}
.pageRoot{--border:var(--color-border);--surface-raised:var(--color-surface-raised);--text-primary:var(--color-text-primary);--accent:var(--color-accent)}
</style></head><body><nav id="qa" aria-label="Synthetic QA controls"></nav><p id="qa-status">Local synthetic records only.</p><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
console.log(`Built synthetic trial fixture: ${resolve(destination, "index.html")}`);
