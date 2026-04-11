// Unit tests for the event-submit-worker helpers.
// Run with: node --test "test/**/*.test.js"
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEventYaml,
  buildPrBody,
  slugify,
  buildBranchName,
} from "../src/index.js";
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

// ---- buildEventYaml --------------------------------------------------------

test("buildEventYaml: required fields in list-item form", () => {
  const snippet = buildEventYaml({
    name: "Test Event",
    date: "2026-07-04",
    venue: "Some Venue",
  });
  assert.match(snippet, /^- name: "Test Event"$/m);
  assert.match(snippet, /^  date: "2026-07-04"$/m);
  assert.match(snippet, /^  venue: "Some Venue"$/m);
});

test("buildEventYaml: renders tags list under the item", () => {
  const snippet = buildEventYaml({
    name: "Family Movie Night",
    date: "2026-07-04",
    venue: "CCCAH",
    tags: ["kid-friendly", "cinema"],
  });
  assert.match(snippet, /tags:\n\s*- kid-friendly\n\s*- cinema/);
});

test("buildEventYaml: omits tags key when none set", () => {
  const snippet = buildEventYaml({
    name: "Late Metal Night",
    date: "2026-07-04",
    venue: "AMIT",
  });
  assert.ok(!/^\s*tags:/m.test(snippet));
});

test("buildEventYaml: optional fields appear only when present", () => {
  const withAll = buildEventYaml({
    name: "N",
    date: "2026-07-04",
    venue: "V",
    time: "21:00",
    address: "A",
    description: "D",
    instagram: "https://ig/x",
    image: "https://img/x.jpg",
  });
  assert.match(withAll, /^  time: "21:00"$/m);
  assert.match(withAll, /^  address: "A"$/m);
  assert.match(withAll, /^  description: "D"$/m);
  assert.match(withAll, /^  instagram: "https:\/\/ig\/x"$/m);
  assert.match(withAll, /^  image: "https:\/\/img\/x\.jpg"$/m);

  const minimal = buildEventYaml({ name: "N", date: "2026-07-04", venue: "V" });
  assert.ok(!/time:/.test(minimal));
  assert.ok(!/address:/.test(minimal));
  assert.ok(!/description:/.test(minimal));
  assert.ok(!/instagram:/.test(minimal));
  assert.ok(!/image:/.test(minimal));
});

// ---- buildPrBody -----------------------------------------------------------

test("buildPrBody: renders metadata summary and provenance note", () => {
  const body = buildPrBody({
    name: "Family Movie Night",
    date: "2026-07-04",
    venue: "CCCAH",
    tags: ["kid-friendly", "cinema"],
    submitterName: "Someone",
  });
  assert.match(body, /\*\*Name:\*\* Family Movie Night/);
  assert.match(body, /\*\*Date:\*\* 2026-07-04/);
  assert.match(body, /\*\*Venue:\*\* CCCAH/);
  assert.match(body, /\*\*Tags:\*\* kid-friendly, cinema/);
  assert.match(body, /\*\*Submitted by:\*\* Someone/);
  assert.match(body, /Auto-generated from the suggest-an-event form/);
});

test("buildPrBody: omits Tags line when none set", () => {
  const body = buildPrBody({
    name: "Late Metal Night",
    date: "2026-07-04",
    venue: "AMIT",
  });
  assert.ok(!/\*\*Tags:\*\*/.test(body));
});

test("buildPrBody: embeds image markdown when image set", () => {
  const body = buildPrBody({
    name: "X",
    date: "2026-07-04",
    venue: "V",
    image: "https://img/x.jpg",
  });
  assert.match(body, /!\[Event flyer\]\(https:\/\/img\/x\.jpg\)/);
});

// ---- slugify ---------------------------------------------------------------

test("slugify: lowercases and dashes non-alphanumerics", () => {
  assert.equal(slugify("Family Movie Night"), "family-movie-night");
  assert.equal(slugify("ESCAMA: de dragão 2#"), "escama-de-drag-o-2");
});

test("slugify: trims and collapses consecutive dashes", () => {
  assert.equal(slugify("  --Hello  World--  "), "hello-world");
});

test("slugify: clamps length and trims trailing dashes after clamp", () => {
  const s = slugify("a".repeat(50) + " " + "b".repeat(50), 10);
  assert.equal(s.length <= 10, true);
  assert.ok(!s.endsWith("-"));
});

test("slugify: falls back to 'event' for empty input", () => {
  assert.equal(slugify(""), "event");
  assert.equal(slugify("!!!"), "event");
  assert.equal(slugify(null), "event");
  assert.equal(slugify(undefined), "event");
});

// ---- buildBranchName -------------------------------------------------------

test("buildBranchName: contains date, slug and random suffix", () => {
  const branch = buildBranchName(
    { name: "Test Event", date: "2026-07-04" },
    "abc123",
  );
  assert.equal(branch, "event-suggestion/2026-07-04-test-event-abc123");
});

test("buildBranchName: uses slug fallback for empty name", () => {
  const branch = buildBranchName({ name: "", date: "2026-07-04" }, "deadbe");
  assert.equal(branch, "event-suggestion/2026-07-04-event-deadbe");
});

test("buildPrBody: includes Map line when map_url set", () => {
  const body = buildPrBody({
    name: "Strawberry Picking",
    date: "2026-04-18",
    venue: "Sabores da Horta",
    address: "Canada do Saco, 9760-123",
    map_url: "https://maps.app.goo.gl/abc123",
  });
  assert.match(body, /\*\*Map:\*\* https:\/\/maps\.app\.goo\.gl\/abc123/);
});

test("buildEventYaml: includes map_url when set", () => {
  const snippet = buildEventYaml({
    name: "Strawberry Picking",
    date: "2026-04-18",
    venue: "Sabores da Horta",
    address: "Canada do Saco, 9760-123",
    map_url: "https://maps.app.goo.gl/abc123",
  });
  assert.match(snippet, /^  map_url: "https:\/\/maps\.app\.goo\.gl\/abc123"$/m);
});

test("buildPrBody / buildEventYaml: omit map_url when not set", () => {
  const body = buildPrBody({
    name: "Test Event",
    date: "2026-07-04",
    venue: "Some Venue",
    address: "Some Street 1",
  });
  const snippet = buildEventYaml({
    name: "Test Event",
    date: "2026-07-04",
    venue: "Some Venue",
    address: "Some Street 1",
  });
  assert.ok(!/\*\*Map:\*\*/.test(body));
  assert.ok(!/map_url:/.test(snippet));
});
