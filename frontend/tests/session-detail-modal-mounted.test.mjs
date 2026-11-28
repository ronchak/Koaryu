import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, expect } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function bundle() {
  const { add, modules } = createCommonJsPacker({
    "lucide-react": "module.exports=new Proxy({},{get:()=>()=>null});",
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const component = add("@/components/schedule/session-detail-modal");
  return `(()=>{
    const process={env:{NODE_ENV:'production'}},modules=[${modules.join(",")}],cache={};
    function require(id){if(cache[id])return cache[id].exports;const m=cache[id]={exports:{}};modules[id](m,m.exports,require);return m.exports;}
    const React=require(${react}),{ScheduleSessionDetailModal}=require(${component});
    const f=window.fixture={calls:[],closed:0};
    function App(){
      const [status,setStatus]=React.useState('canceled'),[open,setOpen]=React.useState(true);
      f.setStatus=setStatus;f.reopen=()=>setOpen(true);
      return React.createElement(ScheduleSessionDetailModal,{
        canManageSchedule:true,open,
        session:{id:'session-1',name:'Synthetic class',date:'2026-10-21',start_time:'18:00',end_time:'19:00',status},
        students:[{id:'student-1',legal_first_name:'Test',legal_last_name:'Student'}],attendance:[],
        isAttendanceReady:true,isStudentRosterComplete:true,
        onToggleAttendance:(...args)=>f.calls.push(args),onDeleteSession(){},
        onClose:()=>{f.closed++;setOpen(false);}
      });
    }
    require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(App));
  })();`;
}

test("canceled attendance stays inert across status changes, repeated clicks and reopening", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.abort());
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle() });
    const row = page.locator('[data-attendance-student-id="student-1"]');
    await expect(row).toBeDisabled();
    await expect(page.getByRole("status")).toHaveText(
      "Attendance is unavailable for canceled classes.",
    );
    await row.click({ force: true });
    await row.click({ force: true });
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), []);

    await page.evaluate(() => window.fixture.setStatus("scheduled"));
    await expect(row).toBeEnabled();
    await row.click();
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [
      ["session-1", "student-1", "Test Student"],
    ]);

    await page.evaluate(() => window.fixture.setStatus("canceled"));
    await expect(row).toBeDisabled();
    await row.click({ force: true });
    await page.getByRole("button", { name: "Close session details" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.evaluate(() => window.fixture.reopen());
    await expect(row).toBeDisabled();
    await row.click({ force: true });
    assert.equal(await page.evaluate(() => window.fixture.closed), 1);
    assert.equal(await page.evaluate(() => window.fixture.calls.length), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
