// UK Clearing Advisor - GetSubjects (GET /subjects).
// Returns the subject list for the autocomplete. Static (cached at CloudFront).
import { SUBJECT_NAMES, json } from './shared.mjs';

export const handler = async (event) => {
  const q = (event?.queryStringParameters?.q || '').trim().toLowerCase();
  let subjects = SUBJECT_NAMES;
  if (q.length >= 2) {
    subjects = SUBJECT_NAMES.filter((s) => s.toLowerCase().includes(q));
  }
  return json(200, { subjects }, { 'Cache-Control': 'public, max-age=604800' });
};
