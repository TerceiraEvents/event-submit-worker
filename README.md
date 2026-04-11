# event-submit-worker

Cloudflare Worker that proxies event submissions from the website form and the Terceira Events mobile app into GitHub:

- `POST /submit-event` — opens a pull request on `TerceiraEvents/TerceiraEvents.github.io` that appends the new event to `_data/special_events.yml`. A human merges the PR to publish the event.
- `POST /flag-event` — opens an `event-edit` issue on `TerceiraEvents/TerceiraEventsFeedback` so a maintainer can manually update an existing entry.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Set the GitHub personal access token as a Worker secret. The token needs write access to **both** repos the worker touches:

   - `TerceiraEvents/TerceiraEvents.github.io`: Contents: read/write, Pull requests: read/write (for `/submit-event`)
   - `TerceiraEvents/TerceiraEventsFeedback`: Issues: read/write (for `/flag-event`)

   A classic PAT with `repo` scope covers both. A fine-grained PAT must be configured for both repos with the permissions above.

```bash
npx wrangler secret put GITHUB_TOKEN
```

3. Make sure `TerceiraEvents/TerceiraEventsFeedback` has an `event-edit` label created (for the `/flag-event` path).

## Development

```bash
npm run dev
```

When running locally with `wrangler dev`, create a `.dev.vars` file (git-ignored) to supply the secret:

```
GITHUB_TOKEN=ghp_your_token_here
```

## Deployment

```bash
npm run deploy
```

## API

### POST /submit-event

Opens a pull request on `TerceiraEvents/TerceiraEvents.github.io` that appends the submitted event to `_data/special_events.yml` on a new branch (`event-suggestion/<date>-<slug>-<random>`). The PR still needs a human merge before the event shows up on the site.

**Request body (JSON):**

| Field          | Required | Description                |
|----------------|----------|----------------------------|
| name           | yes      | Event name                 |
| date           | yes      | Event date (YYYY-MM-DD)    |
| time           | no       | Event time (HH:MM)         |
| venue          | yes      | Venue name                 |
| address        | no       | Venue street address       |
| map_url        | no       | Google Maps URL (full http(s) link, e.g. a `maps.app.goo.gl/...` short link) |
| description    | no       | Event description          |
| instagram      | no       | Instagram link             |
| image          | no       | Flyer/poster image URL     |
| tags           | no       | Array of tag slugs         |
| submitterName  | no       | Who submitted the event    |

**Success response (201):**

```json
{
  "success": true,
  "prUrl": "https://github.com/TerceiraEvents/TerceiraEvents.github.io/pull/42",
  "prNumber": 42
}
```

**Error responses:**

- `400` - Missing required fields or invalid format
- `429` - Rate limited (max 10 submissions per minute per IP)
- `502` - GitHub API failure

All responses include CORS headers allowing requests from any origin.
