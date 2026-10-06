#!/usr/bin/env node
/**
 * Captures the landing page's day-timeline screens (public/marketing/product/day-*.webp)
 * from a preview-mode frontend, which runs on sample data and makes no writes.
 *
 *   NEXT_PUBLIC_PREVIEW_MODE=true npx next dev -p 4115
 *   node scripts/capture-landing-day-shots.mjs --url http://localhost:4115
 *
 * Each crop is one real component at 2x. The preview build's own labels ("Preview data")
 * are hidden, a few wide layouts are narrowed to a timeline column's width so nothing
 * truncates, and the billing crop keeps to the payer column: online tuition collection is
 * not generally available, so provider columns stay out of frame. Run with --only <name>
 * to recapture one screen.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, index, all) => {
    if (token.startsWith("--")) pairs.push([token.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const base = args.url ?? "http://localhost:4115";
const outDir = resolve(import.meta.dirname, "../public/marketing/product");
const IMPORT_CSV = [
  "First Name,Last Name,Email,Phone,Date of Birth,Program,Current Belt",
  "Ava,Martinez,ava.m@example.com,555-0101,2014-03-02,Brazilian Jiu-Jitsu Core,White Belt",
  "Noah,Bennett,noah.b@example.com,555-0102,2012-07-19,Brazilian Jiu-Jitsu Core,Yellow Belt",
  "Hana,Mori,hana.m@example.com,555-0103,2013-11-05,Tae Kwon Do Fundamentals,Orange Belt",
].join("\n");

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();
// Preview mode needs nothing beyond the local server.
await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());

const tidy = () =>
  page.evaluate(() => {
    for (const element of document.querySelectorAll("body *")) {
      if (
        element.children.length === 0 &&
        /^(Preview data|Sample data)$/.test(element.textContent.trim())
      ) {
        element.style.visibility = "hidden";
      }
    }
    document.querySelectorAll("nextjs-portal").forEach((element) => element.remove());
  });

const visit = async (route) => {
  await page.goto(base + route, { waitUntil: "load" });
  await page.waitForTimeout(2500);
  await tidy();
};

/** The element whose own text is `text`, `up` levels above it. */
const find = (text, up = 0, index = 0) =>
  page.evaluateHandle(
    ({ text, up, index }) => {
      let element = [...document.querySelectorAll("body *")].filter((candidate) =>
        [...candidate.childNodes].some(
          (node) => node.nodeType === 3 && node.textContent.trim() === text,
        ),
      )[index];
      for (let step = 0; step < up && element; step += 1) element = element.parentElement;
      return element;
    },
    { text, up, index },
  );

const rect = (handle) =>
  handle.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.left, y: box.top, width: box.width, height: box.height };
  });

const save = async (name, clip) => {
  const png = await page.screenshot({ clip });
  const file = join(outDir, `day-${name}.webp`);
  const info = await sharp(png).webp({ quality: 86 }).toFile(file);
  console.log(`day-${name}.webp ${info.width}x${info.height}`);
};

const shots = {
  async import() {
    await visit("/students/import");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: "roster.csv", mimeType: "text/csv", buffer: Buffer.from(IMPORT_CSV) });
    await page.waitForTimeout(1500);
    await tidy();
    await (
      await find("Your CSV column", 2)
    ).evaluate((element) => {
      element.style.width = "540px";
      element.style.maxWidth = "540px";
    });
    await page.waitForTimeout(400);
    const head = await rect(await find("Your CSV column", 1));
    const email = await rect(await find("ava.m@example.com", 3));
    await save("import", {
      x: head.x,
      y: head.y,
      width: 540,
      height: email.y + email.height - head.y,
    });
  },
  async dashboard() {
    await visit("/dashboard");
    const card = await rect(await find("Classes Today", 3));
    const last = await rect(await find("Adult No-Gi", 1));
    await save("dashboard", { ...card, height: last.y + last.height + 18 - card.y });
  },
  async lead() {
    await visit("/leads");
    await page.getByText("David Chen").first().click();
    await page.waitForTimeout(1200);
    await tidy();
    // The lead and the follow-up it waits on; the form fields between are folded away.
    await page.evaluate(() => {
      const hide = (text, up) => {
        let element = [...document.querySelectorAll("aside *")].find((candidate) =>
          [...candidate.childNodes].some(
            (node) => node.nodeType === 3 && node.textContent.trim() === text,
          ),
        );
        for (let step = 0; step < up && element; step += 1) element = element.parentElement;
        if (element) element.style.display = "none";
      };
      hide("Assigned staff", 1);
      hide("Source", 2);
      hide("Stage", 1);
    });
    await page.waitForTimeout(300);
    const top = await rect(await find("Selected lead", 2));
    const followUp = await rect(await find("Follow-up date", 3));
    await save("lead", { ...top, height: followUp.y + followUp.height + 14 - top.y });
  },
  async family() {
    await visit("/students/mock-1");
    const card = await find("Primary guardian", 1);
    await card.evaluate((element) => {
      element.style.width = "460px";
    });
    await page.waitForTimeout(300);
    await save("family", await rect(card));
  },
  async attendance() {
    await visit("/schedule");
    await page
      .getByText(/Kids BJJ/)
      .first()
      .click();
    await page.waitForTimeout(1500);
    await tidy();
    const dialog = await page.locator('[role="dialog"]').first().boundingBox();
    const row = await rect(await find("Amara Okafor", 3));
    await save("attendance", { ...dialog, height: row.y + row.height - dialog.y });
  },
  async ranks() {
    await visit("/belt-tracker");
    await page
      .getByText(/^Rank Plan$/)
      .first()
      .click();
    await page.waitForTimeout(1500);
    await tidy();
    const group = await find("Red Tip 1", 4);
    await group.evaluate((element) => {
      element.style.width = "540px";
    });
    await page.waitForTimeout(300);
    const box = await rect(group);
    const last = await rect(await find("Black Tip", 2));
    await save("ranks", { ...box, height: last.y + last.height + 10 - box.y });
  },
  async billing() {
    await visit("/billing");
    await page
      .getByText(/^Families$/)
      .first()
      .click();
    await page.waitForTimeout(1500);
    await tidy();
    const section = await find("Kenji Tanaka", 3, 0);
    await section.evaluate((element) => {
      element.style.width = "300px";
      for (const row of element.children) {
        const cells = [...row.children];
        if (cells.length >= 4) {
          cells.slice(1).forEach((cell) => (cell.style.display = "none"));
          row.style.gridTemplateColumns = "1fr";
        }
      }
      element.scrollIntoView({ block: "center" });
    });
    await page.waitForTimeout(500);
    const box = await rect(section);
    const last = await rect(await find("Omar Haddad", 2));
    await save("billing", { ...box, height: last.y + last.height - box.y });
  },
};

await mkdir(outDir, { recursive: true });
for (const [name, shoot] of Object.entries(shots)) {
  if (args.only && args.only !== name) continue;
  await shoot();
}
await browser.close();
