// Unit tests for src/rehost.js.
// Network-free: globalThis.fetch is replaced with a sequenced fake that
// returns the response we queued for the next call.
//
// Run with: node --test "test/**/*.test.js"

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REHOST_RELEASE_TAG,
  REHOST_MAX_BYTES,
  RehostError,
  rehostImage,
  slugSafe,
  sha256Hex,
} from "../src/rehost.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Build a ready-made Response-like object with enough surface for our code.
function jsonResponse(payload, { status = 200, contentType = "application/json" } = {}) {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function binaryResponse(bytes, { status = 200, contentType = "image/png" } = {}) {
  const view = new Uint8Array(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength),
    text: async () => "",
    json: async () => ({}),
  };
}

// Install a sequenced fetch fake. Each call pops the next response from
// the queue. The mock also records the requests for assertions.
function withFakeFetch(responses, fn) {
  const queue = [...responses];
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init || {} });
    if (queue.length === 0) {
      throw new Error(`unexpected fetch: ${url}`);
    }
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next({ url: String(url), init: init || {} });
    return next;
  };
  return (async () => {
    try {
      return await fn({ requests });
    } finally {
      globalThis.fetch = original;
    }
  })();
}

// Build a ghJson callable that uses our fake fetch with GitHub-shaped
// response behavior: 404 on "not found" throws an error with status: 404.
function makeGhJson({ failNotFound = false, createResponse, onApiCall } = {}) {
  return async (method, path, body) => {
    if (onApiCall) onApiCall({ method, path, body });
    if (method === "GET" && /\/releases\/tags\//.test(path)) {
      if (failNotFound) {
        const err = new Error(`GitHub ${method} ${path} -> 404`);
        err.status = 404;
        throw err;
      }
      return {
        id: 111,
        tag_name: REHOST_RELEASE_TAG,
        upload_url: `https://uploads.github.com/repos/Owner/Repo/releases/111/assets{?name,label}`,
      };
    }
    if (method === "POST" && /\/releases$/.test(path)) {
      return createResponse || {
        id: 222,
        tag_name: body.tag_name,
        upload_url: `https://uploads.github.com/repos/Owner/Repo/releases/222/assets{?name,label}`,
      };
    }
    throw new Error(`unexpected ghJson call: ${method} ${path}`);
  };
}

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...new Array(100).fill(0),
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("slugSafe: folds accents and lowercases", () => {
  assert.equal(slugSafe("ESCAMA: de dragão 1#"), "escama-de-dragao-1");
  assert.equal(slugSafe("   weird   --  whitespace  "), "weird-whitespace");
  assert.equal(slugSafe("!!!"), "event");
});

test("sha256Hex: known vector", async () => {
  // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
  const hex = await sha256Hex(new TextEncoder().encode("abc"));
  assert.equal(hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("rehostImage: happy path, release exists", async () => {
  const sha8 = (await sha256Hex(PNG_BYTES)).slice(0, 8);
  const expectedName = `my-event-20260417-${sha8}.png`;
  await withFakeFetch(
    [
      binaryResponse(PNG_BYTES, { contentType: "image/png" }),            // source fetch
      jsonResponse({ browser_download_url: `https://github.com/Owner/Repo/releases/download/event-images/${expectedName}`, name: expectedName }),
    ],
    async ({ requests }) => {
      const url = await rehostImage({
        sourceUrl: "https://example.com/flyer.png",
        slug: "My Event",
        date: "2026-04-17",
        token: "ghp_test",
        ghJson: makeGhJson(),
      });
      assert.match(url, /releases\/download\/event-images\//);
      assert.ok(url.includes(sha8));
      // The asset upload must use the upload_url template with name param.
      const uploadReq = requests[1];
      assert.match(uploadReq.url, /uploads\.github\.com.*name=/);
      assert.equal(uploadReq.init.method, "POST");
      assert.equal(uploadReq.init.headers["Content-Type"], "image/png");
    },
  );
});

test("rehostImage: creates release on 404", async () => {
  const sha8 = (await sha256Hex(PNG_BYTES)).slice(0, 8);
  let createCalled = false;
  const ghJson = makeGhJson({
    failNotFound: true,
    onApiCall: ({ method, path }) => {
      if (method === "POST" && path.endsWith("/releases")) createCalled = true;
    },
  });
  await withFakeFetch(
    [
      binaryResponse(PNG_BYTES, { contentType: "image/png" }),
      jsonResponse({ browser_download_url: `https://github.com/Owner/Repo/releases/download/event-images/x-${sha8}.png`, name: `x-${sha8}.png` }),
    ],
    async () => {
      await rehostImage({
        sourceUrl: "https://example.com/x.png",
        slug: "x",
        date: "2026-04-17",
        token: "t",
        ghJson,
      });
      assert.ok(createCalled, "expected a POST to /releases");
    },
  );
});

test("rehostImage: 422 on upload returns deterministic URL", async () => {
  const sha8 = (await sha256Hex(PNG_BYTES)).slice(0, 8);
  const expectedName = `x-20260417-${sha8}.png`;
  await withFakeFetch(
    [
      binaryResponse(PNG_BYTES, { contentType: "image/png" }),
      { ok: false, status: 422, headers: { get: () => null }, text: async () => "already_exists", json: async () => ({}) },
    ],
    async () => {
      const url = await rehostImage({
        sourceUrl: "https://example.com/x.png",
        slug: "x",
        date: "2026-04-17",
        token: "t",
        ghJson: makeGhJson(),
      });
      assert.ok(
        url.endsWith(`/releases/download/event-images/${expectedName}`),
        `unexpected url ${url}`,
      );
    },
  );
});

test("rehostImage: rejects HTML response", async () => {
  await withFakeFetch(
    [binaryResponse(new TextEncoder().encode("<html>hi</html>"), { contentType: "text/html" })],
    async () => {
      await assert.rejects(
        rehostImage({
          sourceUrl: "https://www.facebook.com/somepage",
          slug: "x",
          date: "2026-04-17",
          token: "t",
          ghJson: makeGhJson(),
        }),
        (err) => err instanceof RehostError && /content-type/.test(err.message),
      );
    },
  );
});

test("rehostImage: rejects oversize response", async () => {
  const huge = new Uint8Array(REHOST_MAX_BYTES + 1);
  await withFakeFetch(
    [binaryResponse(huge, { contentType: "image/jpeg" })],
    async () => {
      await assert.rejects(
        rehostImage({
          sourceUrl: "https://example.com/huge.jpg",
          slug: "x",
          date: "2026-04-17",
          token: "t",
          ghJson: makeGhJson(),
        }),
        (err) => err instanceof RehostError && /exceeds/.test(err.message),
      );
    },
  );
});

test("rehostImage: rejects non-http URLs", async () => {
  await withFakeFetch([], async () => {
    await assert.rejects(
      rehostImage({
        sourceUrl: "ftp://example.com/x.jpg",
        slug: "x",
        date: "2026-04-17",
        token: "t",
        ghJson: makeGhJson(),
      }),
      (err) => err instanceof RehostError && /fetchable URL/.test(err.message),
    );
  });
});

test("rehostImage: wraps network errors as RehostError", async () => {
  await withFakeFetch(
    [new TypeError("network is unreachable")],
    async () => {
      await assert.rejects(
        rehostImage({
          sourceUrl: "https://example.com/x.jpg",
          slug: "x",
          date: "2026-04-17",
          token: "t",
          ghJson: makeGhJson(),
        }),
        (err) => err instanceof RehostError && /fetch failed/.test(err.message),
      );
    },
  );
});

test("rehostImage: propagates unexpected ghJson failure (not 404)", async () => {
  const ghJson = async (method, path) => {
    if (method === "GET" && /\/releases\/tags\//.test(path)) {
      const err = new Error("boom");
      err.status = 500;
      throw err;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  await withFakeFetch(
    [binaryResponse(PNG_BYTES, { contentType: "image/png" })],
    async () => {
      await assert.rejects(
        rehostImage({
          sourceUrl: "https://example.com/x.png",
          slug: "x",
          date: "2026-04-17",
          token: "t",
          ghJson,
        }),
        (err) => err instanceof RehostError && /GET release/.test(err.message),
      );
    },
  );
});
