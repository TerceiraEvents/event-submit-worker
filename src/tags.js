// Shared tag vocabulary for special events.
//
// Keep this list in sync with:
//   - TerceiraEvents.github.io   _data/event_tags.yml
//   - TerceiraEventsApp          src/utils/tags.js

export const VALID_TAG_SLUGS = new Set([
  'kid-friendly',
  'live-music',
  'cinema',
  'theater',
  'dance',
  'nightlife',
  'karaoke',
  'food-drink',
  'exhibition',
  'literature',
  'workshop',
  'free',
  'outdoor',
  'bullfighting',
]);

// Normalize a submission's tags field. Accepts:
//   - an array of strings       ["kid-friendly", "cinema"]
//   - a comma-separated string  "kid-friendly, cinema"
//   - undefined / null / other  -> []
// Unknown tags are dropped. Duplicates are collapsed. Order preserved.
//
// If the legacy `kid_friendly: true` boolean is also set, "kid-friendly"
// is merged in.
export function normalizeSubmissionTags(submission) {
  if (!submission) return [];
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (typeof t !== 'string') return;
    const slug = t.trim().toLowerCase();
    if (!slug || seen.has(slug) || !VALID_TAG_SLUGS.has(slug)) return;
    seen.add(slug);
    out.push(slug);
  };
  const raw = submission.tags;
  if (Array.isArray(raw)) {
    raw.forEach(push);
  } else if (typeof raw === 'string') {
    raw.split(',').forEach(push);
  }
  if (submission.kid_friendly === true ||
      submission.kid_friendly === 'true' ||
      submission.kid_friendly === 'on' ||
      submission.kid_friendly === '1' ||
      submission.kid_friendly === 'yes') {
    push('kid-friendly');
  }
  return out;
}
