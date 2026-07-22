// UK Clearing Advisor - DailyScraper (EventBridge cron).
// Reads ALL universities from UniversityContactsTable (no hardcoded list),
// fetches each clearing page, and records status changes in ChangeLogTable.
// Uses the Node 22 global fetch (zero dependencies).
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cw = new CloudWatchClient({});

const CONTACTS_TABLE = process.env.CONTACTS_TABLE;
const CHANGELOG_TABLE = process.env.CHANGELOG_TABLE;
const CACHE_TABLE = process.env.CLEARING_CACHE_TABLE; // reused for scrape state
const NS = 'ClearingAdvisor';
const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 6000;

async function metric(name, value) {
  try {
    await cw.send(new PutMetricDataCommand({
      Namespace: NS, MetricData: [{ MetricName: name, Value: value, Unit: 'Count' }],
    }));
  } catch { /* best effort */ }
}

async function fetchStatus(url) {
  const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, { method: 'GET', redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'UKClearingAdvisor/1.0 (+monitoring)' } });
    const text = await res.text();
    // Cheap signal: reachable + whether the page still mentions clearing.
    const mentionsClearing = /clearing/i.test(text);
    return { httpStatus: res.status, mentionsClearing, size: text.length };
  } finally {
    clearTimeout(t);
  }
}

async function processOne(u, results) {
  const url = u.clearingPage;
  if (!url) return;
  let current;
  try {
    current = await fetchStatus(url);
  } catch (e) {
    results.errors++;
    return;
  }

  // Load previous scrape state from the cache table.
  const stateKey = `scrape#${u.providerCode}`;
  let prev = null;
  try {
    const r = await ddb.send(new GetCommand({
      TableName: CACHE_TABLE, Key: { cacheKey: stateKey, provider: 'state' },
    }));
    prev = r.Item || null;
  } catch { /* ignore */ }

  const now = new Date();
  const nowIso = now.toISOString();
  const changed = prev && (
    prev.httpStatus !== current.httpStatus ||
    prev.mentionsClearing !== current.mentionsClearing);

  if (changed) {
    results.changes++;
    const changeType = current.mentionsClearing && !prev.mentionsClearing ? 'ADDED'
      : (!current.mentionsClearing && prev.mentionsClearing ? 'REMOVED' : 'UPDATED');
    await ddb.send(new PutCommand({
      TableName: CHANGELOG_TABLE,
      Item: {
        changeDate: nowIso.slice(0, 10),
        changeTimestamp: nowIso,
        providerCode: u.providerCode,
        universityName: u.universityName,
        courseName: 'Clearing page',
        ucasCode: u.ucasInstitutionCode || '',
        changeType,
        notes: `httpStatus ${prev.httpStatus}->${current.httpStatus}, mentionsClearing ${prev.mentionsClearing}->${current.mentionsClearing}`,
        ttl: Math.floor(now.getTime() / 1000) + 30 * 24 * 3600,
      },
    }));
  }

  // Persist current scrape state (30-day TTL).
  await ddb.send(new PutCommand({
    TableName: CACHE_TABLE,
    Item: {
      cacheKey: stateKey, provider: 'state',
      httpStatus: current.httpStatus, mentionsClearing: current.mentionsClearing,
      size: current.size, checkedAt: nowIso,
      expiresAt: Math.floor(now.getTime() / 1000) + 30 * 24 * 3600,
    },
  }));
}

export const handler = async () => {
  const results = { changes: 0, errors: 0, count: 0 };
  const scan = await ddb.send(new ScanCommand({ TableName: CONTACTS_TABLE }));
  const universities = (scan.Items || []).filter((u) => u.clearingPage);
  results.count = universities.length;

  // Bounded concurrency.
  for (let i = 0; i < universities.length; i += CONCURRENCY) {
    const batch = universities.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map((u) => processOne(u, results)));
  }

  await Promise.all([
    metric('ScraperRunCount', 1),
    metric('ScraperChangesDetected', results.changes),
    metric('ScraperErrorCount', results.errors),
  ]);
  console.log(JSON.stringify({ level: 'INFO', msg: 'scrape complete', ...results }));
  return results;
};
