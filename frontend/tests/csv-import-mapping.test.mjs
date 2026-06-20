import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  getMissingCsvImportRequiredFields,
  getSkippedBillingImportHeaders,
  splitCsvImportFullName,
} from "../src/lib/csv-import-mapping.ts";

describe("getMissingCsvImportRequiredFields", () => {
  it("accepts explicit first and last name mappings", () => {
    assert.deepEqual(
      getMissingCsvImportRequiredFields({
        Given: "legal_first_name",
        Surname: "legal_last_name",
      }),
      []
    );
  });

  it("treats an import full name column as satisfying both name requirements", () => {
    assert.deepEqual(
      getMissingCsvImportRequiredFields({
        "Full Student Name": "full_name",
      }),
      []
    );
  });

  it("still requires the missing side when only one explicit name is mapped", () => {
    assert.deepEqual(
      getMissingCsvImportRequiredFields({
        Child: "legal_first_name",
      }),
      ["legal_last_name"]
    );
  });
});

describe("splitCsvImportFullName", () => {
  it("keeps common compound family names together", () => {
    assert.deepEqual(splitCsvImportFullName("Ana Maria de la Cruz"), {
      firstName: "Ana Maria",
      lastName: "de la Cruz",
    });
    assert.deepEqual(splitCsvImportFullName("Sofia St. James"), {
      firstName: "Sofia",
      lastName: "St. James",
    });
    assert.deepEqual(splitCsvImportFullName("John Smith Jr."), {
      firstName: "John",
      lastName: "Smith Jr.",
    });
  });

  it("still supports last-name-first CSV exports", () => {
    assert.deepEqual(splitCsvImportFullName("Nguyen, Ava"), {
      firstName: "Ava",
      lastName: "Nguyen",
    });
  });
});

describe("getSkippedBillingImportHeaders", () => {
  it("surfaces skipped billing columns without treating roster columns as billing data", () => {
    assert.deepEqual(
      getSkippedBillingImportHeaders(
        ["Full Student Name", "Tuition Plan", "Payment Status", "Current Belt"],
        {
          "Full Student Name": "full_name",
          "Tuition Plan": "",
          "Payment Status": "",
          "Current Belt": "current_belt_rank_id",
        }
      ),
      ["Tuition Plan", "Payment Status"]
    );
  });
});
