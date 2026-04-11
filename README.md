# event-submit-worker

Cloudflare Worker that proxies event suggestions from the Terceira Events mobile app into GitHub Issues on `TerceiraEvents/TerceiraEventsFeedback`.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Set the GitHub personal access token as a Worker secret. The token needs the `repo` scope (or `public_repo` if the target repo is public):

```bash
npx wrangler secret put GITHUB_TOKEN
```

3. Make sure the target repository (`TerceiraEvents/TerceiraEventsFeedback`) has an `event-suggestion` label created.

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
| submitterName  | no       | Who submitted the event    |

**Success response (201):**

```json
{
  "success": true,
  "issueUrl": "https://github.com/TerceiraEvents/TerceiraEventsFeedback/issues/42",
  "issueNumber": 42
}
```

**Error responses:**

- `400` - Missing required fields or invalid format
- `429` - Rate limited (max 10 submissions per minute per IP)
- `502` - GitHub API failure

All responses include CORS headers allowing requests from any origin.
