// UK Clearing Advisor - GetSubjects (GET /subjects).
// Returns the subject list for the autocomplete. Static (cached at CloudFront).
import { SUBJECT_NAMES, json, errorResponse, checkOriginSecret } from './shared.mjs';

export const handler = async (event) => {
  const requestId = event?.requestContext?.requestId || 'n/a';
  // Reject direct calls to the execute-api URL that skip CloudFront/WAF.
  if (!checkOriginSecret(event)) {
    return errorResponse(403, 'FORBIDDEN', 'Direct API access is not permitted.', requestId);
  }
  const q = (event?.queryStringParameters?.q || '').trim().toLowerCase();
  let subjects = SUBJECT_NAMES;
  if (q.length >= 2) {
    subjects = SUBJECT_NAMES.filter((s) => s.toLowerCase().includes(q));
  }
  return json(200, { subjects });
};
