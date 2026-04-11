import { normalizeSubmissionTags } from "./tags.js";

// In-memory rate limit store. Resets when the worker is evicted, which is
// acceptable for basic abuse protection.  Keys are IP addresses, values are
// arrays of request timestamps (epoch ms) within the current window.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10;

function isRateLimited(ip) {
  const now = Date.now();
  let timestamps = rateLimitMap.get(ip);
  if (!timestamps) {
    timestamps = [];
    rateLimitMap.set(ip, timestamps);
  }
  // Prune entries outside the window
  while (timestamps.length > 0 && timestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    timestamps.shift();
  }
  if (timestamps.length >= RATE_LIMIT_MAX) {
    return true;
  }
  timestamps.push(now);
  return false;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ---- Site repo constants ---------------------------------------------------

const SITE_OWNER = "TerceiraEvents";
const SITE_REPO = "TerceiraEvents.github.io";
const SITE_BASE_BRANCH = "main";
const EVENTS_FILE_PATH = "_data/special_events.yml";

const FEEDBACK_OWNER = "TerceiraEvents";
const FEEDBACK_REPO = "TerceiraEventsFeedback";

// ---- Helpers: YAML snippet and PR body ------------------------------------

// The YAML list-item that will be appended to _data/special_events.yml.
// Exported for unit tests.
export function buildEventYaml(data) {
  const tags = Array.isArray(data.tags) ? data.tags : [];
  const lines = [];
  lines.push(`- name: "${data.name}"`);
  lines.push(`  date: "${data.date}"`);
  if (data.time) lines.push(`  time: "${data.time}"`);
  lines.push(`  venue: "${data.venue}"`);
  if (data.address) lines.push(`  address: "${data.address}"`);
  if (data.map_url) lines.push(`  map_url: "${data.map_url}"`);
  if (data.description) lines.push(`  description: "${data.description}"`);
  if (data.instagram) lines.push(`  instagram: "${data.instagram}"`);
  if (data.image) lines.push(`  image: "${data.image}"`);
  if (tags.length) {
    lines.push(`  tags:`);
    for (const t of tags) lines.push(`    - ${t}`);
  }
  return lines.join("\n");
}

// Human-readable PR body: the submission metadata summary followed by a
// short note about provenance. The YAML shows up in the diff view, so we
// don't need to re-embed it here.
// Exported for unit tests.
export function buildPrBody(data) {
  const lines = [];
  const tags = Array.isArray(data.tags) ? data.tags : [];

  lines.push("## Event Suggestion");
  lines.push("");
  lines.push(`**Name:** ${data.name}`);
  lines.push(`**Date:** ${data.date}`);
  if (data.time) lines.push(`**Time:** ${data.time}`);
  lines.push(`**Venue:** ${data.venue}`);
  if (data.address) lines.push(`**Address:** ${data.address}`);
  if (data.map_url) lines.push(`**Map:** ${data.map_url}`);
  if (data.description) lines.push(`**Description:** ${data.description}`);
  if (data.instagram) lines.push(`**Instagram:** ${data.instagram}`);
  if (data.image) lines.push(`**Image:** ${data.image}`);
  if (tags.length) lines.push(`**Tags:** ${tags.join(", ")}`);
  if (data.submitterName) lines.push(`**Submitted by:** ${data.submitterName}`);

  if (data.image) {
    lines.push("");
    lines.push(`![Event flyer](${data.image})`);
  }

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Auto-generated from the suggest-an-event form. Please review dates, venue, and description before merging.",
  );

  return lines.join("\n");
}

// Lowercase, collapse non-alphanumerics to dashes, trim, clamp length.
// Exported for unit tests.
export function slugify(s, maxLen = 40) {
  const slug = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || "event";
}

// Short random hex suffix for branch uniqueness. Uses Workers' crypto.
function randomHex(nChars = 6) {
  const bytes = new Uint8Array(Math.ceil(nChars / 2));
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out.slice(0, nChars);
}

// Build a unique branch name for the PR. Exported for tests.
export function buildBranchName(data, randomSuffix) {
  const suffix = randomSuffix || randomHex(6);
  return `event-suggestion/${data.date}-${slugify(data.name, 40)}-${suffix}`;
}

// ---- Base64 helpers (UTF-8 safe, Workers-friendly) ------------------------

function utf8ToBase64(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---- GitHub API wrapper ---------------------------------------------------

async function ghRequest(env, method, path, body) {
  const token = env.GITHUB_TOKEN;
  if (!token) {
    const err = new Error("Missing GITHUB_TOKEN");
    err.status = 500;
    throw err;
  }
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "event-submit-worker",
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    const err = new Error(`GitHub ${method} ${path} -> ${resp.status}: ${detail}`);
    err.status = resp.status;
    throw err;
  }
  // Some endpoints (e.g. 204 No Content) have empty bodies.
  if (resp.status === 204) return null;
  return resp.json();
}

// ---- Create PR on site repo -----------------------------------------------

// Orchestrates: resolve main HEAD → create branch → fetch file → append
// snippet → commit on branch via Contents API → open PR. Returns the PR
// payload from GitHub.
async function createEventPr(env, data) {
  // 1. Resolve main's HEAD commit SHA.
  const mainRef = await ghRequest(
    env,
    "GET",
    `/repos/${SITE_OWNER}/${SITE_REPO}/git/ref/heads/${SITE_BASE_BRANCH}`,
  );
  const mainSha = mainRef.object.sha;

  // 2. Create a unique branch off main.
  const branch = buildBranchName(data);
  await ghRequest(
    env,
    "POST",
    `/repos/${SITE_OWNER}/${SITE_REPO}/git/refs`,
    { ref: `refs/heads/${branch}`, sha: mainSha },
  );

  // 3. Fetch the current events file on main (content + blob sha).
  const fileMeta = await ghRequest(
    env,
    "GET",
    `/repos/${SITE_OWNER}/${SITE_REPO}/contents/${EVENTS_FILE_PATH}?ref=${encodeURIComponent(SITE_BASE_BRANCH)}`,
  );
  const currentContent = base64ToUtf8(fileMeta.content);

  // 4. Append the new snippet, separated by a blank line.
  let next = currentContent;
  if (next.length > 0 && !next.endsWith("\n")) next += "\n";
  if (!next.endsWith("\n\n")) next += "\n";
  next += buildEventYaml(data) + "\n";

  // 5. Commit the updated file on the new branch.
  const commitMessage = `Add event: ${data.name}`;
  await ghRequest(
    env,
    "PUT",
    `/repos/${SITE_OWNER}/${SITE_REPO}/contents/${EVENTS_FILE_PATH}`,
    {
      message: commitMessage,
      content: utf8ToBase64(next),
      sha: fileMeta.sha,
      branch,
    },
  );

  // 6. Open the PR.
  const pr = await ghRequest(
    env,
    "POST",
    `/repos/${SITE_OWNER}/${SITE_REPO}/pulls`,
    {
      title: `Add event: ${data.name}`,
      head: branch,
      base: SITE_BASE_BRANCH,
      body: buildPrBody(data),
    },
  );
  return pr;
}

// ---- /submit-event handler ------------------------------------------------

async function handleSubmit(request, env) {
  // --- Rate limiting ---
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (isRateLimited(ip)) {
    return jsonResponse({ error: "Rate limit exceeded. Try again in a minute." }, 429);
  }

  // --- Parse body ---
  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  // --- Honeypot: silently drop if filled (bot indicator) ---
  if (data.website && String(data.website).trim() !== "") {
    return jsonResponse({ success: true, prUrl: null, prNumber: null }, 200);
  }

  // --- Validate required fields ---
  const missing = [];
  for (const field of ["name", "date", "venue"]) {
    if (!data[field] || typeof data[field] !== "string" || data[field].trim() === "") {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    return jsonResponse({ error: `Missing required fields: ${missing.join(", ")}` }, 400);
  }

  // Trim all string values
  for (const key of Object.keys(data)) {
    if (typeof data[key] === "string") {
      data[key] = data[key].trim();
    }
  }

  // Normalize tags (accepts array, comma-separated string, or legacy
  // kid_friendly boolean). Unknown tags are dropped, duplicates collapsed.
  data.tags = normalizeSubmissionTags(data);
  delete data.kid_friendly;

  // --- Basic format validation ---
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    return jsonResponse({ error: "Invalid date format. Use YYYY-MM-DD." }, 400);
  }
  if (data.time && !/^\d{2}:\d{2}$/.test(data.time)) {
    return jsonResponse({ error: "Invalid time format. Use HH:MM." }, 400);
  }
  if (data.map_url && !/^https?:\/\//i.test(data.map_url)) {
    return jsonResponse({ error: "Invalid map_url. Must be a full http(s) URL." }, 400);
  }

  if (!env.GITHUB_TOKEN) {
    return jsonResponse({ error: "Server misconfiguration: missing GitHub token." }, 500);
  }

  let pr;
  try {
    pr = await createEventPr(env, data);
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    return jsonResponse({ error: "Failed to create GitHub pull request." }, 502);
  }

  return jsonResponse(
    {
      success: true,
      prUrl: pr.html_url,
      prNumber: pr.number,
    },
    201,
  );
}

// ---- /flag-event handler (edit suggestions stay as issues) ----------------

function buildFlagBody(data) {
  const lines = [];
  lines.push("## Edit Suggestion");
  lines.push("");
  lines.push("**Event:** " + data.eventName);
  if (data.eventDate) lines.push("**Date:** " + data.eventDate);
  if (data.eventVenue) lines.push("**Venue:** " + data.eventVenue);
  lines.push("");
  lines.push("### What needs to change");
  lines.push("");
  lines.push(data.reason);
  if (data.submitterName) {
    lines.push("");
    lines.push("---");
    lines.push("*Reported by: " + data.submitterName + "*");
  }
  return lines.join("\n");
}

async function handleFlag(request, env) {
  // --- Rate limiting (shared counter) ---
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (isRateLimited(ip)) {
    return jsonResponse({ error: "Rate limit exceeded. Try again in a minute." }, 429);
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  // Honeypot
  if (data.website && String(data.website).trim() !== "") {
    return jsonResponse({ success: true, issueUrl: null, issueNumber: null }, 200);
  }

  // Validate
  const missing = [];
  for (const field of ["eventName", "reason"]) {
    if (!data[field] || typeof data[field] !== "string" || data[field].trim() === "") {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    return jsonResponse({ error: `Missing required fields: ${missing.join(", ")}` }, 400);
  }

  // Trim
  for (const key of Object.keys(data)) {
    if (typeof data[key] === "string") {
      data[key] = data[key].trim();
    }
  }

  if (!env.GITHUB_TOKEN) {
    return jsonResponse({ error: "Server misconfiguration: missing GitHub token." }, 500);
  }

  const dateSuffix = data.eventDate ? ` (${data.eventDate})` : "";
  const issuePayload = {
    title: `Edit Suggestion: ${data.eventName}${dateSuffix}`,
    body: buildFlagBody(data),
    labels: ["event-edit"],
  };

  let issue;
  try {
    issue = await ghRequest(
      env,
      "POST",
      `/repos/${FEEDBACK_OWNER}/${FEEDBACK_REPO}/issues`,
      issuePayload,
    );
  } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    return jsonResponse({ error: "Failed to create GitHub issue." }, 502);
  }

  return jsonResponse(
    {
      success: true,
      issueUrl: issue.html_url,
      issueNumber: issue.number,
    },
    201,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/submit-event" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    if (url.pathname === "/flag-event" && request.method === "POST") {
      return handleFlag(request, env);
    }

    return jsonResponse({ error: "Not found." }, 404);
  },
};
