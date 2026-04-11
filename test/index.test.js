// Unit tests for the event-submit-worker helpers.
// Run with: node --test "test/**/*.test.js"
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildIssueBody } from "../src/index.js";
import { normalizeSubmissionTags, VALID_TAG_SLUGS } from "../src/tags.js";

test("normalizeSubmissionTags: undefined -> []", () => {
  assert.deepEqual(normalizeSubmissionTags({}), []);
  assert.deepEqual(normalizeSubmissionTags(null), []);
  assert.deepEqual(normalizeSubmissionTags(undefined), []);
});

test("normalizeSubmissionTags: array of known slugs passes through", () => {
  assert.deepEqual(
    normalizeSubmissionTags({ tags: ["kid-friendly", "cinema"] }),
    ["kid-friendly", "cinema"],
  );
});

test("normalizeSubmissionTags: unknown tags are dropped", () => {
  assert.deepEqual(
    normalizeSubmissionTags({ tags: ["kid-friendly", "made-up-tag", "cinema"] }),
    ["kid-friendly", "cinema"],
  );
});

test("normalizeSubmissionTags: comma-separated string input", () => {
  assert.deepEqual(
    normalizeSubmissionTags({ tags: "kid-friendly, cinema, free" }),
    ["kid-friendly", "cinema", "free"],
  );
});

test("normalizeSubmissionTags: case and whitespace normalized", () => {
  assert.deepEqual(
    normalizeSubmissionTags({ tags: ["  Kid-Friendly  ", "CINEMA"] }),
    ["kid-friendly", "cinema"],
  );
});

test("normalizeSubmissionTags: duplicates collapsed, order preserved", () => {
  assert.deepEqual(
    normalizeSubmissionTags({ tags: ["cinema", "kid-friendly", "cinema"] }),
    ["cinema", "kid-friendly"],
  );
});

test("normalizeSubmissionTags: legacy kid_friendly=true merges kid-friendly", () => {
  assert.deepEqual(
    normalizeSubmissionTags({ kid_friendly: true }),
    ["kid-friendly"],
  );
  assert.deepEqual(
    normalizeSubmissionTags({ kid_friendly: "true" }),
    ["kid-friendly"],
  );
  assert.deepEqual(
    normalizeSubmissionTags({ kid_friendly: "on" }),
    ["kid-friendly"],
  );
});

test("normalizeSubmissionTags: kid_friendly + tags de-duped", () => {
  assert.deepEqual(
    normalizeSubmissionTags({
      kid_friendly: true,
      tags: ["cinema", "kid-friendly"],
    }),
    ["cinema", "kid-friendly"],
  );
});

test("normalizeSubmissionTags: non-array non-string tags ignored", () => {
  assert.deepEqual(normalizeSubmissionTags({ tags: { foo: "bar" } }), []);
  assert.deepEqual(normalizeSubmissionTags({ tags: 42 }), []);
});

test("VALID_TAG_SLUGS includes kid-friendly and core music tags", () => {
  assert.ok(VALID_TAG_SLUGS.has("kid-friendly"));
  assert.ok(VALID_TAG_SLUGS.has("live-music"));
  assert.ok(VALID_TAG_SLUGS.has("cinema"));
  assert.ok(!VALID_TAG_SLUGS.has("nonsense"));
});

test("buildIssueBody: renders Tags line and YAML list", () => {
  const body = buildIssueBody({
    name: "Family Movie Night",
    date: "2026-07-04",
    venue: "CCCAH",
    tags: ["kid-friendly", "cinema"],
  });
  assert.match(body, /\*\*Tags:\*\* kid-friendly, cinema/);
  assert.match(body, /tags:\n\s*- kid-friendly\n\s*- cinema/);
});

test("buildIssueBody: omits Tags when none set", () => {
  const body = buildIssueBody({
    name: "Late Metal Night",
    date: "2026-07-04",
    venue: "AMIT",
  });
  assert.ok(!/Tags/.test(body));
  assert.ok(!/^\s*tags:/m.test(body));
});

test("buildIssueBody: required fields always present", () => {
  const body = buildIssueBody({
    name: "Test Event",
    date: "2026-07-04",
    venue: "Some Venue",
  });
  assert.match(body, /\*\*Name:\*\* Test Event/);
  assert.match(body, /\*\*Date:\*\* 2026-07-04/);
  assert.match(body, /\*\*Venue:\*\* Some Venue/);
});

test("buildIssueBody: includes map_url in metadata and YAML when set", () => {
  const body = buildIssueBody({
    name: "Strawberry Picking",
    date: "2026-04-18",
    venue: "Sabores da Horta",
    address: "Canada do Saco, 9760-123",
    map_url: "https://maps.app.goo.gl/abc123",
  });
  assert.match(body, /\*\*Map:\*\* https:\/\/maps\.app\.goo\.gl\/abc123/);
  assert.match(body, /map_url: "https:\/\/maps\.app\.goo\.gl\/abc123"/);
});

test("buildIssueBody: omits map_url lines when not set", () => {
  const body = buildIssueBody({
    name: "Test Event",
    date: "2026-07-04",
    venue: "Some Venue",
    address: "Some Street 1",
  });
  assert.ok(!/\*\*Map:\*\*/.test(body));
  assert.ok(!/map_url:/.test(body));
});
