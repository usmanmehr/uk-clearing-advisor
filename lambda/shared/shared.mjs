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

// Subject -> indicative UCAS course codes (Section 3 of the spec).
export const SUBJECTS = {
  'Computer Science': ['G400', 'G401', 'G500'],
  'Software Engineering': ['G602', 'G600', 'G610'],
  'Artificial Intelligence': ['G700', 'GG47', 'G5G8'],
  'Data Science': ['G900', 'G901', 'GG14'],
  'Mathematics': ['G100', 'G103', 'G110'],
  'MORSE': ['GLN0'],
  'Actuarial Science': ['GG13', 'NG31'],
  'Economics': ['L100', 'L101', 'L110'],
  'Economics and Finance': ['NL31', 'LN13'],
  'Business': ['N100', 'N200'],
  'Management': ['N200', 'N201', 'N202'],
  'Accounting and Finance': ['N400', 'N410', 'NN43'],
  'Finance': ['N300', 'N301', 'N310'],
  'Medicine': ['A100', 'A101', 'A300'],
  'Dentistry': ['A200', 'A201'],
  'Pharmacy': ['B230', 'B234'],
  'Nursing': ['B700', 'B740', 'B760'],
  'Law': ['M100', 'M102', 'M103'],
  'Psychology': ['C800', 'C801', 'C810'],
  'Politics': ['L200', 'L202', 'L250'],
  'International Relations': ['L250', 'L251', 'LM11'],
  'Political Economy': ['L200', 'LL12'],
  'History': ['V100', 'V101', 'V110'],
  'English': ['Q300', 'Q301', 'Q320'],
  'Geography': ['F800', 'F801', 'F810'],
  'Physics': ['F300', 'F303', 'F304'],
  'Chemistry': ['F100', 'F101', 'F105'],
  'Biology': ['C100', 'C101', 'C102'],
  'Civil Engineering': ['H200', 'H201', 'H210'],
  'Mechanical Engineering': ['H300', 'H301', 'H310'],
  'Electrical Engineering': ['H600', 'H601', 'H610'],
  'Architecture': ['K100', 'K110', 'K120'],
  'Art and Design': ['W100', 'W200', 'W210'],
  'Music': ['W300', 'W302', 'W311'],
  'Drama': ['W400', 'W410', 'W420'],
  'Sports Science': ['C600', 'C601', 'C610'],
  'Sociology': ['L300', 'L301', 'L320'],
  'Philosophy': ['V500', 'V510', 'V520'],
  'PPE': ['L0V0', 'LV15', 'VLL0'],
  'Classics': ['Q800', 'Q810', 'Q820'],
  'Education': ['X300', 'X100', 'X301'],
  'Social Work': ['L500', 'L510', 'L520'],
  'Criminology': ['M900', 'M910', 'M920'],
  'Media Studies': ['P300', 'P310', 'P320'],
  'Journalism': ['P500', 'P510', 'P520'],
  'Marketing': ['N500', 'N510', 'N520'],
};

export const SUBJECT_NAMES = Object.keys(SUBJECTS);

// A-level subjects a course typically requires. Used for the warning badge -
// courses are never excluded for a missing subject (spec Step 3).
export const REQUIRED_SUBJECTS = {
  'Medicine': ['Chemistry', 'Biology'],
  'Dentistry': ['Chemistry', 'Biology'],
  'Pharmacy': ['Chemistry'],
  'Mathematics': ['Mathematics'],
  'MORSE': ['Mathematics'],
  'Actuarial Science': ['Mathematics'],
  'Computer Science': ['Mathematics'],
  'Artificial Intelligence': ['Mathematics'],
  'Data Science': ['Mathematics'],
  'Physics': ['Mathematics', 'Physics'],
  'Civil Engineering': ['Mathematics', 'Physics'],
  'Mechanical Engineering': ['Mathematics', 'Physics'],
  'Electrical Engineering': ['Mathematics', 'Physics'],
  'Economics': ['Mathematics'],
  'Chemistry': ['Chemistry'],
};

export const GRADE_VALUES = { 'A*': 12, A: 11, B: 10, C: 9, D: 8, E: 7 };

// Sum of the best three A-level grades.
export function gradeTotal(subjects) {
  const values = (subjects || [])
    .map((s) => GRADE_VALUES[(s.grade || '').toUpperCase()] || 0)
    .sort((a, b) => b - a);
  return values.slice(0, 3).reduce((a, b) => a + b, 0);
}

// Levenshtein distance (for fuzzy subject matching, threshold <= 2).
export function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// Resolve free-text course interest to a known subject group.
// Exact (case-insensitive) -> substring -> fuzzy (<=2). Returns null if none.
export function resolveSubject(text) {
  if (!text || !text.trim()) return null;
  const q = text.trim().toLowerCase();
  for (const name of SUBJECT_NAMES) {
    if (name.toLowerCase() === q) return name;
  }
  for (const name of SUBJECT_NAMES) {
    if (name.toLowerCase().includes(q) || q.includes(name.toLowerCase())) return name;
  }
  let best = null, bestD = 3;
  for (const name of SUBJECT_NAMES) {
    const d = levenshtein(q, name.toLowerCase());
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

// Mask the last octet of an IPv4 address (never log full IP - Section 7).
export function maskIp(ip) {
  if (!ip) return 'unknown';
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  return ip.split(':').slice(0, 2).join(':') + ':xxx';
}

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
