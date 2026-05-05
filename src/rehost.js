// Inline image re-hosting for the event-submit Worker.
//
// Submitters paste whatever image URL they have — Facebook CDN, Instagram,
// random Discord attachments — and those URLs rot within days. See
// EventosTerceira#66 for the motivation and #67 for the full
// pipeline design. This module downloads the submitted image and uploads
// it as a GitHub release asset on a long-lived release (tag:
// `event-images`), so the URL that ends up in `_data/special_events.yml`
// is permanent and points at GitHub's infrastructure.
//
// The asset name is content-addressed:
//
//     <slug>-<yyyymmdd>-<sha8>.<ext>
//
// which makes re-hosting the same image idempotent (GitHub returns 422
// "already_exists" on the second upload and we short-circuit to the
// deterministic public URL).
//
// Runs inside a Cloudflare Worker, so we lean on platform globals
// (`fetch`, `crypto.subtle`) rather than pulling in npm deps.

const SITE_OWNER = "TerceiraEvents";
const SITE_REPO = "EventosTerceira";

export const REHOST_RELEASE_TAG = "event-images";

// Keep well clear of GitHub's 2 GB per-asset ceiling and refuse anything
// that smells like "a random web page URL" — a 10 MB HTML document is
// still garbage as an image.
export const REHOST_MAX_BYTES = 10 * 1024 * 1024;

export const REHOST_CONTENT_TYPE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Thrown from rehostImage when the fetch or upload fails in a way the
// caller should surface to the submitter. `status` is the HTTP code we
// want to return from the Worker handler.
export class RehostError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "RehostError";
    this.status = status;
  }
}

// Fold accents, lowercase, collapse non-alphanumerics. Matches the
// Python slugger in scripts/rehost_image.py so both entry points produce
// the same filename for the same input.
export function slugSafe(value) {
  const base = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "event";
}

// Hex-encoded SHA-256 of the given bytes. Uses the Web Crypto API
// available in Workers (and modern Node via `globalThis.crypto`).
export async function sha256Hex(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(hash);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

// Fetch the source URL with browser-style headers + origin Referer.
// Many CDNs (Facebook/Instagram especially) hotlink-block empty or
// foreign referers, so sending the URL's own origin as referer is what
// their own site would do.
async function fetchImageBytes(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new RehostError(`not a fetchable URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RehostError(`not a fetchable URL: ${url}`);
  }

  const referer = `${parsed.protocol}//${parsed.host}/`;
  let resp;
  try {
    resp = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: referer,
      },
    });
  } catch (err) {
    throw new RehostError(`fetch failed for ${url}: ${err.message}`);
  }
  if (!resp.ok) {
    throw new RehostError(`fetch failed for ${url}: HTTP ${resp.status}`);
  }
  const rawCt = resp.headers.get("content-type") || "";
  const contentType = rawCt.split(";")[0].trim().toLowerCase();
  if (!(contentType in REHOST_CONTENT_TYPE_EXTENSIONS)) {
    throw new RehostError(
      `response content-type is ${JSON.stringify(contentType)}, not an image`,
    );
  }
  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength > REHOST_MAX_BYTES) {
    throw new RehostError(
      `image exceeds ${REHOST_MAX_BYTES} bytes (got ${buffer.byteLength})`,
    );
  }
  return { bytes: new Uint8Array(buffer), contentType };
}

// Return the ``upload_url`` template for the release at ``tag``,
// creating the release if it doesn't exist yet.
export async function ensureRelease(ghJson, tag) {
  try {
    const rel = await ghJson(
      "GET",
      `/repos/${SITE_OWNER}/${SITE_REPO}/releases/tags/${encodeURIComponent(tag)}`,
    );
    return rel.upload_url;
  } catch (err) {
    if (err.status !== 404) {
      throw new RehostError(
        `GET release tag ${tag} failed: ${err.message}`,
        502,
      );
    }
  }
  const created = await ghJson(
    "POST",
    `/repos/${SITE_OWNER}/${SITE_REPO}/releases`,
    {
      tag_name: tag,
      name: "Event flyer images (auto-managed)",
      body:
        "Auto-managed by event-submit-worker (src/rehost.js) and " +
        "scripts/rehost_image.py on the site repo. Each asset is a " +
        "flyer image referenced from `_data/special_events.yml`. Do " +
        "not delete individual assets — events linking to them will " +
        "lose their flyer.",
    },
  );
  return created.upload_url;
}

function assetBrowserUrl(tag, name) {
  return (
    `https://github.com/${SITE_OWNER}/${SITE_REPO}/releases/download/` +
    `${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
  );
}

// POST the image bytes as an asset named `name`. Returns the public
// download URL. On HTTP 422 (asset already exists — same content, same
// sha-derived name) returns the deterministic URL anyway, making
// re-runs idempotent.
export async function uploadAsset({
  token,
  uploadUrlTemplate,
  tag,
  name,
  bytes,
  contentType,
}) {
  const base = uploadUrlTemplate.split("{")[0];
  const url = `${base}?name=${encodeURIComponent(name)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "event-submit-worker",
      "Content-Type": contentType,
    },
    body: bytes,
  });
  if (resp.status === 422) {
    return assetBrowserUrl(tag, name);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new RehostError(
      `asset upload failed: HTTP ${resp.status}: ${detail}`,
      502,
    );
  }
  const payload = await resp.json();
  return payload.browser_download_url;
}

// Entry point used by src/index.js. `ghJson(method, path, body?)` is the
// same shape as the Worker's existing `ghRequest(env, method, path,
// body)` — we take a pre-bound callable so this module stays decoupled
// from the Worker's env plumbing, which makes tests simpler.
export async function rehostImage({
  sourceUrl,
  slug,
  date,
  token,
  ghJson,
  tag = REHOST_RELEASE_TAG,
}) {
  const { bytes, contentType } = await fetchImageBytes(sourceUrl);
  const ext = REHOST_CONTENT_TYPE_EXTENSIONS[contentType];
  const sha8 = (await sha256Hex(bytes)).slice(0, 8);
  const compactDate = String(date).replace(/-/g, "");
  const name = `${slugSafe(slug)}-${compactDate}-${sha8}.${ext}`;
  const uploadUrlTemplate = await ensureRelease(ghJson, tag);
  return await uploadAsset({
    token,
    uploadUrlTemplate,
    tag,
    name,
    bytes,
    contentType,
  });
}
