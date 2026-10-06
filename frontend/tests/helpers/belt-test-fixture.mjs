import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBeltPanelFixture, EVENT, OTHER, DRAFT } from "./belt-test-panel-mounted.mjs";

// Writes a disposable fixture. The PM starts a loopback server for manual review.
const destination = process.argv[2];
if (!destination?.startsWith("/")) throw Error("Pass an absolute disposable output directory.");
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const files = [
  "belt-tracker/belt-tracker.module.css",
  "leads/leads-ledger.module.css",
  "belt-tests/belt-tests.module.css",
];
const styles = (
  await Promise.all(
    files.map((file) => readFile(resolve(frontend, "src/components", file), "utf8")),
  )
)
  .join("\n")
  .replaceAll(/:global\(([^)]+)\)/g, "$1");
let script = await buildBeltPanelFixture({ route: `/belt-tests?event=${EVENT}` });
script += `
const qa=document.getElementById('qa'),status=document.getElementById('qa-status');
function control(label,action){const button=document.createElement('button');button.textContent=label;button.onclick=()=>Promise.resolve().then(action).catch(()=>{status.textContent='Synthetic control failed; inspect the test fixture.'});qa.append(button);}
const original=f.write;f.write=(...args)=>{const promise=original(...args),index=f.writes.length-1;setTimeout(()=>{f.commitBelt(index,{lose:Boolean(f.loseNext),missingParent:Boolean(f.removeAfterSave),reapprove:Boolean(f.reapproveAfterRevoke)});f.loseNext=false;f.removeAfterSave=false;f.reapproveAfterRevoke=false;},700);return promise;};
control('Lose next response',()=>{f.loseNext=true;status.textContent='Next command will require Check result.'});
control('Hold current reads',()=>{f.holds=[${JSON.stringify(`/belt-tests/${EVENT}`)}];status.textContent='Current reads are held.'});
control('Finish held reads',()=>{f.holds=[];f.finishReads();status.textContent='Held reads completed.'});
control('Fail reference reads',async()=>{f.failures['/programs?include_archived=true']=503;await f.store.refreshPrograms({includeArchived:true,force:true}).catch(()=>{});status.textContent='Reference choices unavailable. History remains readable.'});
control('Restore reference reads',()=>{f.failures={};status.textContent='Use Retry reference choices.'});
control('Fail recipient pages',()=>{f.failures[${JSON.stringify(`/belt-tests/${EVENT}/recipients?limit=50`)}]=503;status.textContent='The next history read will fail.'});
control('Restore recipient pages',()=>{f.failures={};status.textContent='Use Retry recipient history.'});
control('Remove event after next save',()=>{f.removeAfterSave=true;status.textContent='Next saved command will observe a missing event.'});
control('Reapprove after next revoke',()=>{f.reapproveAfterRevoke=true;status.textContent='Next revoke will read a later reapproval.'});
control('Return null recipient',()=>{f.nullRecipient=true;status.textContent='Current recipient reads return invalid null data.'});
control('Restore recipient reads',()=>{f.nullRecipient=false;status.textContent='Check result can read the current recipient again.'});
control('Open other event query',()=>{if(!f.events.some(row=>row.id===${JSON.stringify(OTHER)}))f.events.push({...f.events[0],id:${JSON.stringify(OTHER)},name:'Other synthetic event'});f.navigate('/belt-tests?event='+${JSON.stringify(OTHER)});});
control('Open draft query',()=>f.navigate('/belt-tests?draft='+${JSON.stringify(DRAFT)}));
control('Reset local resource',()=>f.resetBeltResource());
`;
await mkdir(destination, { recursive: true });
await writeFile(
  resolve(destination, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sample belt-test QA</title><style>
:root{--product-ground:#efe8da;--product-paper:#faf5e9;--product-card-stock:#fffaf0;--product-rule-soft:#d8cbb6;--product-rule:#b9a991;--product-ink:#2c241b;--product-soft-ink:#62513d;--product-meta:#796850;--product-wood:#8b5b32;--product-affirm:#407557;--product-straw:#b58a32;--product-vermilion:#ae4f39}*{box-sizing:border-box}body{margin:0;background:var(--product-ground);font:14px system-ui;color:var(--product-ink)}h1,h2,h3,h4,p{margin:0}button,input,select{font:inherit}button{cursor:pointer}#qa{display:flex;flex-wrap:wrap;gap:8px;padding:12px;border-bottom:1px solid var(--product-rule)}#qa button{min-height:44px;padding:8px;border:1px solid var(--product-rule);background:var(--product-paper);color:inherit}#qa-status{padding:12px}.koaryu-modal-root{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center}.koaryu-modal-backdrop{position:absolute;inset:0;background:#201c1880}.koaryu-modal-panel{position:relative;z-index:1}.beltPage>header{padding:20px} ${styles}
</style></head><body><nav id="qa" aria-label="Synthetic QA controls"></nav><p id="qa-status" role="status">Synthetic local data only. Commands affect this fixture.</p><div id="root"></div><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
);
console.log(`Built synthetic belt-test fixture: ${resolve(destination, "index.html")}`);
