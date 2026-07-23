// UK Clearing Advisor - Health (GET /health).
// Lightweight synthetic-monitoring endpoint. Deliberately does NOT require
// the X-Origin-Verify secret (unlike every other route) - external health
// checkers (CloudWatch Synthetics, Route 53 health checks, uptime monitors)
// need to reach this directly without carrying the shared secret, and it
// exposes no business data or PII, only liveness/connectivity status. This
// closes a real observability gap: previously the only way to know the API
// was up was to actually run a search - there was no lightweight check a
// monitor could poll every minute.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CONTACTS_TABLE = process.env.CONTACTS_TABLE;
const START_TIME = Date.now();

export const handler = async () => {
  const checks = {};
  let healthy = true;

  // Cheap DynamoDB connectivity check - a single GetItem (not a Scan) on a
  // key that may or may not exist. We only care whether the call succeeds,
  // not whether an item comes back.
  const dbStart = Date.now();
  try {
    await ddb.send(new GetCommand({ TableName: CONTACTS_TABLE, Key: { providerCode: '__health_check__' } }));
    checks.dynamodb = { ok: true, latencyMs: Date.now() - dbStart };
  } catch (e) {
    checks.dynamodb = { ok: false, latencyMs: Date.now() - dbStart, error: e.name };
    healthy = false;
  }

  const body = {
    status: healthy ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    uptimeMs: Date.now() - START_TIME,
    checks,
  };

  return {
    statusCode: healthy ? 200 : 503,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
};
