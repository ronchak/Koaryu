import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  normalizeLegalName,
  normalizeLegalNameDraft,
  shouldBlockForLegalName,
} from "../src/lib/legal-name-model.ts";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const layoutSource = source("../src/app/(dashboard)/layout.tsx");
const blockingSource = source("../src/components/account/legal-name-blocking-screen.tsx");
const accountSource = source("../src/components/account/account-name-section.tsx");

describe("legal-name decision and normalization model", () => {
  it("does not block when the schema capability is false, even with missing names", () => {
    assert.equal(
      shouldBlockForLegalName({ staffProfilesAvailable: false, firstName: "", lastName: "" }),
      false
    );
    assert.equal(
      shouldBlockForLegalName({ staffProfilesAvailable: false, firstName: "Ari", lastName: "Lane" }),
      false
    );
  });

  it("does not block a complete legal profile when the schema is available", () => {
    assert.equal(
      shouldBlockForLegalName({ staffProfilesAvailable: true, firstName: "Ari", lastName: "Lane" }),
      false
    );
  });

  it("blocks either missing or whitespace-only legal-name field independently of role", () => {
    for (const role of ["admin", "instructor", "front_desk"]) {
      assert.equal(
        shouldBlockForLegalName({
          staffProfilesAvailable: true,
          firstName: " Ari ",
          lastName: "  ",
        }),
        true,
        role
      );
    }
    assert.equal(
      shouldBlockForLegalName({ staffProfilesAvailable: true, firstName: "\n", lastName: "Lane" }),
      true
    );
    assert.equal(
      shouldBlockForLegalName({ staffProfilesAvailable: true, firstName: "Ari", lastName: "  " }),
      true
    );
    assert.equal(
      shouldBlockForLegalName({ staffProfilesAvailable: true, firstName: "\t", lastName: "\n" }),
      true
    );
  });

  it("trims surrounding whitespace and collapses internal runs to ASCII spaces", () => {
    assert.equal(normalizeLegalName("  Ari\t  van\nLane  "), "Ari van Lane");
    assert.deepEqual(
      normalizeLegalNameDraft({ firstName: "  Ari  ", lastName: "\tvan\nLane " }),
      { firstName: "Ari", lastName: "van Lane" }
    );
    assert.deepEqual(normalizeLegalNameDraft({ firstName: "  ", lastName: "\n" }), {
      firstName: "",
      lastName: "",
    });
  });
});

describe("legal-name dashboard blocking contract", () => {
  it("derives the gate from store values at render and suppresses protected dashboard content", () => {
    assert.match(layoutSource, /shouldBlockForLegalName\(\{[\s\S]*?staffProfilesAvailable,[\s\S]*?firstName: legalFirstName,[\s\S]*?lastName: legalLastName/);
    assert.match(layoutSource, /isLegalNameBlocked \? \([\s\S]*?<LegalNameBlockingScreen onSignOut=\{handleSignOut\}/);
    assert.match(layoutSource, /\) : \([\s\S]*?<Sidebar[\s\S]*?<DashboardRouteTransition>\{children\}<\/DashboardRouteTransition>/);
    assert.doesNotMatch(layoutSource, /useEffect/);
    assert.doesNotMatch(layoutSource, /router\.push\([^)]*legal|router\.replace\([^)]*legal/);
    const gateSource = layoutSource.slice(
      layoutSource.indexOf("const isLegalNameBlocked"),
      layoutSource.indexOf("async function handleSignOut")
    );
    assert.doesNotMatch(gateSource, /currentRole|router\.|redirect/);
  });
});

describe("legal-name blocking form contract", () => {
  it("uses required labeled inputs, exact store action, pending/error state, and no navigation", () => {
    assert.match(blockingSource, /<form onSubmit=\{handleSubmit\}/);
    assert.match(blockingSource, /label="Legal first name"[\s\S]*?autoComplete="given-name"[\s\S]*?required/);
    assert.match(blockingSource, /label="Legal last name"[\s\S]*?autoComplete="family-name"[\s\S]*?required/);
    assert.match(blockingSource, /const normalizedNames = normalizeLegalNameDraft\(\{ firstName, lastName \}\)/);
    assert.match(blockingSource, /disabled=\{!canSubmit\}/);
    assert.match(blockingSource, /<Button type="submit" variant="primary"/);
    assert.match(blockingSource, /if \(isSubmitting\) return;/);
    assert.match(blockingSource, /await updateUserLegalName\(normalizedNames\.firstName, normalizedNames\.lastName\)/);
    assert.match(blockingSource, /setIsSubmitting\(true\)[\s\S]*?finally \{[\s\S]*?setIsSubmitting\(false\)/);
    assert.match(blockingSource, /catch \(submitError: unknown\)[\s\S]*?setError\(submitError instanceof Error/);
    assert.match(blockingSource, /aria-live="polite"/);
    assert.match(blockingSource, /onClick=\{\(\) => \{[\s\S]*?void onSignOut\(\)/);
    assert.doesNotMatch(blockingSource, /useRouter|router\.|window\.location|reload\(/);
  });
});

describe("account legal-name view contract", () => {
  it("relabels the editable auth field and preserves display-name saving", () => {
    assert.match(accountSource, />Display name</);
    assert.match(accountSource, /updateUserName\(normalizedNameDraft\)/);
    assert.match(accountSource, /Save display name/);
    assert.match(accountSource, /Display name updated\./);
    assert.doesNotMatch(accountSource, /updateUserLegalName/);
  });

  it("shows legal fields only for the available schema and keeps them read-only", () => {
    assert.match(accountSource, /staffProfilesAvailable && \(/);
    assert.match(accountSource, /Legal first name[\s\S]*?value=\{legalFirstName\}[\s\S]*?readOnly/);
    assert.match(accountSource, /Legal last name[\s\S]*?value=\{legalLastName\}[\s\S]*?readOnly/);
    assert.match(accountSource, /Legal-name changes are managed by an admin in staff management\./);
    assert.match(accountSource, /<span className="font-medium text-text-primary">Email<\/span>[\s\S]*?disabled/);
  });

  it("keeps old-schema accounts display-name-only", () => {
    const legalViewStart = accountSource.indexOf("{staffProfilesAvailable && (");
    assert.notEqual(legalViewStart, -1);
    assert.doesNotMatch(accountSource.slice(0, legalViewStart), /Legal first name|Legal last name/);
  });
});
