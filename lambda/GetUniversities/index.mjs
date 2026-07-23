// UK Clearing Advisor - GetUniversities (GET /universities).
// Returns university metadata for browsing. NOT cached - clearing status,
// phone lines and hotline hours can change during Clearing, so every
// request re-scans DynamoDB rather than serving a stale CloudFront copy.
import { ddb, ScanCommand, json, errorResponse, log } from './shared.mjs';

const CONTACTS_TABLE = process.env.CONTACTS_TABLE;

export const handler = async (event) => {
  const requestId = event?.requestContext?.requestId || 'n/a';
  try {
    const res = await ddb.send(new ScanCommand({ TableName: CONTACTS_TABLE }));
    const universities = (res.Items || []).sort((a, b) =>
      (a.universityName || '').localeCompare(b.universityName || ''));
    return json(200, { universities, count: universities.length });
  } catch (e) {
    log('ERROR', { level: 'ERROR', msg: 'get universities failed', requestId, error: e.message });
    return errorResponse(500, 'INTERNAL_ERROR', 'Could not load universities.', requestId);
  }
};
