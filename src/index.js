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

function buildIssueBody(data) {
  const lines = [];

  lines.push("## Event Suggestion");
  lines.push("");
  lines.push(`**Name:** ${data.name}`);
  lines.push(`**Date:** ${data.date}`);
  if (data.time) lines.push(`**Time:** ${data.time}`);
  lines.push(`**Venue:** ${data.venue}`);
  if (data.address) lines.push(`**Address:** ${data.address}`);
  if (data.description) lines.push(`**Description:** ${data.description}`);
  if (data.instagram) lines.push(`**Instagram:** ${data.instagram}`);
  if (data.submitterName) lines.push(`**Submitted by:** ${data.submitterName}`);

  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("### Ready-to-paste YAML for `special_events.yml`");
  lines.push("");
  lines.push("```yaml");
  lines.push(`- name: "${data.name}"`);
  lines.push(`  date: "${data.date}"`);
  if (data.time) lines.push(`  time: "${data.time}"`);
  lines.push(`  venue: "${data.venue}"`);
  if (data.address) lines.push(`  address: "${data.address}"`);
  if (data.description) lines.push(`  description: "${data.description}"`);
  if (data.instagram) lines.push(`  instagram: "${data.instagram}"`);
  lines.push("```");

  return lines.join("\n");
}

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

  // --- Basic format validation ---
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
    return jsonResponse({ error: "Invalid date format. Use YYYY-MM-DD." }, 400);
  }
  if (data.time && !/^\d{2}:\d{2}$/.test(data.time)) {
    return jsonResponse({ error: "Invalid time format. Use HH:MM." }, 400);
  }

  // --- Create GitHub issue ---
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return jsonResponse({ error: "Server misconfiguration: missing GitHub token." }, 500);
  }

  const owner = "TerceiraEvents";
  const repo = "Angraevents.github.io";

  const issuePayload = {
    title: `Event Suggestion: ${data.name}`,
    body: buildIssueBody(data),
    labels: ["event-suggestion"],
  };

  const ghResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "event-submit-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(issuePayload),
  });

  if (!ghResponse.ok) {
    const detail = await ghResponse.text();
    console.error(`GitHub API error ${ghResponse.status}: ${detail}`);
    return jsonResponse({ error: "Failed to create GitHub issue." }, 502);
  }

  const issue = await ghResponse.json();

  return jsonResponse({
    success: true,
    issueUrl: issue.html_url,
    issueNumber: issue.number,
  }, 201);
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

    return jsonResponse({ error: "Not found." }, 404);
  },
};
