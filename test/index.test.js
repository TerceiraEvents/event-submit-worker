// Unit tests for the event-submit-worker helpers.
// Run with: node --test test/index.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeKidFriendly, buildIssueBody } from "../src/index.js";

test("normalizeKidFriendly: boolean true", () => {
  assert.equal(normalizeKidFriendly(true), true);
});

test("normalizeKidFriendly: boolean false", () => {
  assert.equal(normalizeKidFriendly(false), false);
});

test("normalizeKidFriendly: missing -> false", () => {
  assert.equal(normalizeKidFriendly(undefined), false);
  assert.equal(normalizeKidFriendly(null), false);
});

test('normalizeKidFriendly: common truthy strings', () => {
  for (const v of ["true", "TRUE", "True", "on", "1", "yes", "  true  "]) {
    assert.equal(normalizeKidFriendly(v), true, `expected "${v}" -> true`);
  }
});

test("normalizeKidFriendly: falsy strings stay false", () => {
  for (const v of ["false", "0", "no", "", "maybe", "off"]) {
    assert.equal(normalizeKidFriendly(v), false, `expected "${v}" -> false`);
  }
});

test("buildIssueBody: includes Kid Friendly line when flag set", () => {
  const body = buildIssueBody({
    name: "Family Movie Night",
    date: "2026-07-04",
    venue: "CCCAH",
    kid_friendly: true,
  });
  assert.match(body, /\*\*Kid Friendly:\*\* yes/);
  assert.match(body, /kid_friendly: true/);
});

test("buildIssueBody: omits Kid Friendly line when flag unset", () => {
  const body = buildIssueBody({
    name: "Late-Night Metal",
    date: "2026-07-04",
    venue: "AMIT",
  });
  assert.ok(!/Kid Friendly/.test(body));
  assert.ok(!/kid_friendly/.test(body));
});

test("buildIssueBody: still produces required fields", () => {
  const body = buildIssueBody({
    name: "Test Event",
    date: "2026-07-04",
    venue: "Some Venue",
  });
  assert.match(body, /\*\*Name:\*\* Test Event/);
  assert.match(body, /\*\*Date:\*\* 2026-07-04/);
  assert.match(body, /\*\*Venue:\*\* Some Venue/);
});
