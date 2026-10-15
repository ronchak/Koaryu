import assert from "node:assert/strict";
import { test } from "node:test";
import { phoneHref } from "../src/lib/phone-link.ts";

test("phone links preserve ordinary domestic and international numbers", () => {
  assert.equal(phoneHref("(206) 555-0100"), "tel:2065550100");
  assert.equal(phoneHref(" +44 20 7946 0958 "), "tel:+442079460958");
  assert.equal(phoneHref("+1 (206) 555-0100"), "tel:+12065550100");
});

test("phone links keep explicit extensions separate from the subscriber number", () => {
  for (const suffix of [" ext 42", " ext. 42", " Extension 42", "x42", ";ext=42"]) {
    assert.equal(phoneHref(`+1 (206) 555-0100${suffix}`), "tel:+12065550100;ext=42");
  }
  assert.equal(phoneHref("206.555.0100 ext 0042"), "tel:2065550100;ext=0042");
});

test("ambiguous notes and dial strings do not become a different phone number", () => {
  for (const phone of [
    "",
    "---",
    "+",
    "206-555-0100 or 206-555-0101",
    "206-555-0100 ext",
    "x42 206 555 0100",
    "206-555-0100,42",
    "1-800-FLOWERS",
    "206+5550100",
  ]) {
    assert.equal(phoneHref(phone), undefined, phone);
  }
});
