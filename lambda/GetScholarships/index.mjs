// UK Clearing Advisor - GetScholarships (GET /scholarships?university=X&subject=Y).
// Reads ScholarshipsTable. Currently unseeded (no verified data) so returns an
// empty list with a clear notice rather than fabricated figures.
import { ddb, QueryCommand, json, errorResponse, log, checkOriginSecret } from './shared.mjs';

const SCHOLARSHIPS_TABLE = process.env.SCHOLARSHIPS_TABLE;

export const handler = async (event) => {
  const requestId = event?.requestContext?.requestId || 'n/a';
  // Reject direct calls to the execute-api URL that skip CloudFront/WAF.
  if (!checkOriginSecret(event)) {
    return errorResponse(403, 'FORBIDDEN', 'Direct API access is not permitted.', requestId);
  }
  const qp = event?.queryStringParameters || {};
  try {
    let items = [];
    if (qp.university) {
      const res = await ddb.send(new QueryCommand({
        TableName: SCHOLARSHIPS_TABLE,
        KeyConditionExpression: 'universityId = :u',
        ExpressionAttributeValues: { ':u': qp.university },
      }));
      items = res.Items || [];
    } else if (qp.subject) {
      const res = await ddb.send(new QueryCommand({
        TableName: SCHOLARSHIPS_TABLE,
        IndexName: 'SubjectIndex',
        KeyConditionExpression: 'subjectGroup = :s',
        ExpressionAttributeValues: { ':s': qp.subject },
      }));
      items = res.Items || [];
    }
    return json(200, {
      scholarships: items,
      count: items.length,
      notice: items.length ? undefined : 'No verified scholarship data loaded yet.',
    });
  } catch (e) {
    log('ERROR', { level: 'ERROR', msg: 'get scholarships failed', requestId, error: e.message });
    return errorResponse(500, 'INTERNAL_ERROR', 'Could not load scholarships.', requestId);
  }
};
