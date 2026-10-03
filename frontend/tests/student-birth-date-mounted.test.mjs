import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";
import { createCommonJsPacker } from "./helpers/store-browser-harness.mjs";

function studentFormBundle() {
  const { add, modules } = createCommonJsPacker({
    "@/lib/store": `exports.useConfigStore=()=>window.fixture.config;exports.useProgramStore=()=>({programs:[]});`,
    "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
  });
  const react = add("react");
  const dom = add("react-dom/client");
  const subject = add("@/components/students/student-form");
  return `(()=>{const process={env:{NODE_ENV:'production'}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});const StudentForm=require(${subject}).StudentForm;require(${dom}).createRoot(document.getElementById('root')).render(React.createElement(StudentForm,{initialData:window.fixture.initialData,onClose:()=>{},onSubmit:data=>{window.fixture.writes.push(data)}}));})();`;
}

const source = studentFormBundle();

test("mounted student create/edit forms reject future DOB with an accessible studio-date error", async () => {
  const browser = await chromium.launch({ headless: true });
  // The browser date is ahead of the Los Angeles studio near UTC midnight.
  const context = await browser.newContext({ timezoneId: "Pacific/Kiritimati" });
  try {
    for (const isEdit of [false, true]) {
      for (const businessDate of ["2026-09-29", "2026-09-30"]) {
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date("2026-09-30T01:00:00Z"));
        page.setDefaultTimeout(6000);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/*", (route) => route.abort());
        await page.setContent('<div id="root"></div>');
        await page.evaluate(
          ({ isEdit, businessDate }) => {
            window.fixture = {
              config: { businessDate },
              initialData: isEdit
                ? { legal_first_name: "Aiko", legal_last_name: "Tanaka" }
                : undefined,
              writes: [],
            };
          },
          { isEdit, businessDate },
        );
        await page.addScriptTag({ content: source });
        await page.getByRole("dialog", { name: isEdit ? "Edit student" : "Add student" }).waitFor();
        await page.getByLabel("Legal first name *", { exact: true }).fill("Aiko");
        await page.getByLabel("Legal last name *", { exact: true }).fill("Tanaka");
        const dob = page.getByLabel("Date of birth", { exact: true });
        const save = page.getByRole("button", {
          name: isEdit ? "Save changes" : "Add student",
          exact: true,
        });
        assert.equal(await dob.getAttribute("max"), businessDate);

        const tomorrow = businessDate === "2026-09-29" ? "2026-09-30" : "2026-10-01";
        for (const futureDate of [tomorrow, "2027-01-01"]) {
          await dob.fill(futureDate);
          await page.waitForFunction(
            () =>
              document.querySelector('input[type="date"]')?.getAttribute("aria-invalid") === "true",
          );
          assert.equal(await dob.getAttribute("aria-invalid"), "true");
          const description = await dob.evaluate((input) =>
            input
              .getAttribute("aria-describedby")
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent)
              .join(" "),
          );
          assert.equal(description, "Date of birth cannot be in the future.");
          assert.equal(
            await page
              .getByText("Date of birth cannot be in the future.", { exact: true })
              .isVisible(),
            true,
          );
          assert.equal(await dob.evaluate((input) => input.validity.rangeOverflow), true);
          await save.click();
          assert.equal(await page.evaluate(() => window.fixture.writes.length), 0);
        }

        // DOB is unmounted on another tab, so native input constraints cannot
        // replace the form hook's validation at submission time.
        await page.getByRole("button", { name: "Contact", exact: true }).click();
        assert.equal(await dob.count(), 0);
        await save.click();
        await dob.waitFor();
        assert.equal(await page.evaluate(() => window.fixture.writes.length), 0);
        assert.equal(await dob.getAttribute("aria-invalid"), "true");

        for (const validDate of [businessDate, "2008-02-29"]) {
          await dob.fill(validDate);
          await page.waitForFunction(
            () => !document.querySelector('input[type="date"]')?.hasAttribute("aria-invalid"),
          );
          assert.equal(await dob.evaluate((input) => input.checkValidity()), true);
          const previousWrites = await page.evaluate(() => window.fixture.writes.length);
          await save.click();
          await page.waitForFunction(
            (count) => window.fixture.writes.length === count + 1,
            previousWrites,
          );
          assert.equal(
            await page.evaluate(() => window.fixture.writes.at(-1).date_of_birth),
            validDate,
          );
          await page.waitForFunction(
            () => !document.querySelector('button[type="submit"]')?.disabled,
          );
        }
        assert.deepEqual(errors, []);
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
});
