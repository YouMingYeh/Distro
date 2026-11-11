// node --test scripts/tokportal.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { tokportalArgs } from "../src/tokportal.ts";

test("writes are dry runs unless the caller says otherwise", () => {
  assert.deepEqual(tokportalArgs("tokportal_create_bundle", { country: "US" }, true), { country: "US", dry_run: true });
  assert.deepEqual(tokportalArgs("tokportal_create_bundle", { country: "US", dry_run: false }, true), { country: "US", dry_run: true });
  assert.deepEqual(tokportalArgs("tokportal_create_bundle", { country: "US" }, false), { country: "US" });
  assert.deepEqual(tokportalArgs("tokportal_publish_bundle", { dry_run: true }, false), { dry_run: true });
  // "reset", "reveal" and the like are not reads just because they start with "re".
  assert.equal(tokportalArgs("tokportal_reveal_account_credentials", {}, true).dry_run, true);
});

test("reads are sent as they are", () => {
  for (const tool of ["tokportal_get_credit_balance", "tokportal_list_bundles", "tokportal_export_analytics"]) {
    assert.deepEqual(tokportalArgs(tool, { page: 2 }, true), { page: 2 });
  }
});
