// UK Clearing Advisor - shared utilities.
// Uses only the AWS SDK v3 bundled in the Node.js 22 managed runtime (no npm).
//
// DECISION: With no UCAS API key available, search runs in "estimated" mode:
// results are built from seeded university contacts + national subject
// averages, every result flagged estimatedData=true. Live UCAS enrichment is
// implemented behind a feature flag (UCAS_ENABLED) for when a key is added.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand,
  PutCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

// Pure grading/subject-matching logic (no AWS SDK, no I/O) lives in its own
// file so it can be unit tested in plain CI without needing the AWS SDK
// packages, which only exist because the Lambda runtime bundles them - they
// are never `npm install`ed in this project (see grading.mjs). Re-exported
// here so every existing `from './shared.mjs'` import in the other Lambdas
// keeps working unchanged.
export {
  SUBJECTS, SUBJECT_NAMES, REQUIRED_SUBJECTS, GRADE_VALUES,
  gradeTotal, levenshtein, resolveSubject, maskIp,
} from './grading.mjs';

// Clients are created OUTSIDE the handler (cold-start only) and reused.
const ddbClient = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
});
const cw = new CloudWatchClient({});

export const NS = process.env.METRICS_NAMESPACE || 'ClearingAdvisor';
export const ENVIRONMENT = process.env.ENVIRONMENT || 'production';
export const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';
export const API_ORIGIN_SECRET = process.env.API_ORIGIN_SECRET || '';

// Emit a CloudWatch custom metric. Best-effort - never throws.
export async function putMetric(name, value, unit = 'Count', dimensions = []) {
  try {
    await cw.send(new PutMetricDataCommand({
      Namespace: NS,
      MetricData: [{
        MetricName: name, Value: value, Unit: unit,
        Dimensions: dimensions, Timestamp: new Date(),
      }],
    }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'ERROR', msg: 'putMetric failed', name, error: e.message }));
  }
}

export function log(level, fields) {
  const order = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
  if ((order[level] || 20) < (order[LOG_LEVEL] || 20)) return;
  console.log(JSON.stringify({ level, ...fields }));
}

export function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

export function errorResponse(statusCode, code, message, requestId, extra = {}) {
  return json(statusCode, { error: code, message, requestId, ...extra });
}

// Direct-access lockdown: the HTTP API is also reachable at its own
// execute-api URL, which bypasses the WAF/geo-block that only protects the
// CloudFront path. CloudFront is configured to send a shared secret
// (X-Origin-Verify) to the API origin; each public-facing Lambda checks it
// here so a caller hitting execute-api directly (skipping CloudFront) gets
// a 403 instead of a real response. Fails closed if the secret is
// configured but the header is missing/wrong; fails open (allows the
// request) only if no secret has been configured at all, so this is a
// no-op until the CDN stack's OriginSecret is actually deployed.
export function checkOriginSecret(event) {
  if (!API_ORIGIN_SECRET) return true;
  const headers = event?.headers || {};
  const provided = headers['x-origin-verify'] || headers['X-Origin-Verify'];
  return provided === API_ORIGIN_SECRET;
}

// Fixed-window rate limiter backed by RateLimitsTable.
// Returns { allowed, retryAfter }. Fails open on DynamoDB error.
export async function checkRateLimit(table, key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = String(now - (now % windowSeconds));
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: table,
      Key: { limitKey: key, windowStart },
      UpdateExpression: 'ADD #c :one SET #ttl = :ttl',
      ExpressionAttributeNames: { '#c': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': now + windowSeconds + 60 },
      ReturnValues: 'UPDATED_NEW',
    }));
    const count = res.Attributes?.count || 1;
    if (count > limit) {
      return { allowed: false, retryAfter: windowSeconds - (now % windowSeconds) };
    }
    return { allowed: true };
  } catch (e) {
    log('ERROR', { msg: 'rate limit check failed (failing open)', error: e.message });
    return { allowed: true };
  }
}

export { GetCommand, QueryCommand, ScanCommand, PutCommand, UpdateCommand };
