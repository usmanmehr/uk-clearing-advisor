// UK Clearing Advisor - GetUniversities (GET /universities).
// Returns university metadata for browsing. NOT cached - clearing status,
// phone lines and hotline hours can change during Clearing, so every
// request re-scans DynamoDB rather than serving a stale CloudFront copy.
import { ddb, ScanCommand, json, errorResponse, log, checkOriginSecret } from './shared.mjs';

const CONTACTS_TABLE = process.env.CONTACTS_TABLE;

export const handler = async (event) => {
  const requestId = event?.requestContext?.requestId || 'n/a';
  // Reject direct calls to the execute-api URL that skip CloudFront/WAF.
  if (!checkOriginSecret(event)) {
    return errorResponse(403, 'FORBIDDEN', 'Direct API access is not permitted.', requestId);
  }
  try {
    const res = await ddb.send(new ScanCommand({ TableName: CONTACTS_TABLE }));
    // Excludes universities that do NOT enter Clearing at all (e.g. Cambridge,
    // Oxford - clearingStatus "Closed"), matching the same filter SearchCourses
    // already applies to search results. This endpoint isn't currently
    // rendered as a browsable list (only used for the hero "checked X ago"
    // freshness stat), but there is no reason for the API response itself to
    // include universities a student could never actually apply to via
    // Clearing, and it keeps this endpoint consistent for anything that
    // reads it in future (e.g. a browse view, or the real scraped-course
    // feature) without each caller having to remember to filter separately.
    const universities = (res.Items || [])
      .filter((u) => (u.clearingStatus || '').toLowerCase() !== 'closed')
      .sort((a, b) => (a.universityName || '').localeCompare(b.universityName || ''));
    return json(200, { universities, count: universities.length });
  } catch (e) {
    log('ERROR', { level: 'ERROR', msg: 'get universities failed', requestId, error: e.message });
    return errorResponse(500, 'INTERNAL_ERROR', 'Could not load universities.', requestId);
  }
};
