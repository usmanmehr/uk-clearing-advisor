// UK Clearing Advisor - DailyScraper (EventBridge cron).
// Reads ALL universities from UniversityContactsTable (no hardcoded list),
// fetches each clearing page, and records status changes in ChangeLogTable.
// Uses the Node 22 global fetch (zero dependencies).
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand,
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

// Word-count based signal instead of a single regex match. A page mentioning
// "clearing" once in an unrelated footer/nav link is a much weaker signal
// than a page with several mentions in close proximity to phrases that
// typically indicate active status ("open", "closed", "now open", "not
// available", "no vacancies"). This still isn't a substitute for a real
// UCAS feed - it is only used to flag POSSIBLE drift for a human/automated
// re-seed to check, never to silently overwrite clearingStatus (see
// processOne below).
const OPEN_HINTS = /clearing\s+(is\s+)?(now\s+)?open|open\s+for\s+clearing|now\s+open/i;
const CLOSED_HINTS = /clearing\s+(is\s+)?(now\s+)?closed|no\s+(clearing\s+)?vacancies|not\s+(currently\s+)?(taking|accepting)|fully\s+booked/i;

async function fetchStatus(url) {
  const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, { method: 'GET', redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': 'UKClearingAdvisor/1.0 (+monitoring)' } });
    const text = await res.text();
    const mentionCount = (text.match(/clearing/gi) || []).length;
    // "Mentions clearing" now requires more than one hit (a single stray
    // mention in a nav/footer link no longer counts) OR an explicit
    // open/closed phrase - tighter than the previous single-word match.
    const mentionsClearing = mentionCount > 1 || OPEN_HINTS.test(text) || CLOSED_HINTS.test(text);
    const hasOpenHint = OPEN_HINTS.test(text);
    const hasClosedHint = CLOSED_HINTS.test(text);
    return { httpStatus: res.status, mentionsClearing, hasOpenHint, hasClosedHint, size: text.length };
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

  // Surface drift on the record students actually see, WITHOUT silently
  // overwriting clearingStatus - the page-text heuristic above is not
  // reliable enough to be authoritative (a false positive could wrongly
  // flag a university as closed or open). Instead this writes advisory
  // fields that SearchCourses/GetUniversities can expose so students see
  // "last checked" freshness and a "this may have changed" flag rather
  // than an unqualified status that could quietly be stale.
  // lastAutomatedCheck always updates (every run). possibleStatusChange is
  // only ever SET to true here (when this run detects a real change since
  // the previous run) and is deliberately never cleared back to false by
  // the scraper itself - it stays flagged until a human re-seeds the data
  // (seed.py writes a fresh lastVerified and clears this field), so a
  // detected drift can't silently disappear again before anyone reviews it.
  try {
    const expr = changed
      ? 'SET possibleStatusChange = :true, lastAutomatedCheck = :checked, lastDetectedChangeAt = :checked'
      : 'SET lastAutomatedCheck = :checked';
    await ddb.send(new UpdateCommand({
      TableName: CONTACTS_TABLE,
      Key: { providerCode: u.providerCode },
      UpdateExpression: expr,
      ExpressionAttributeValues: changed ? { ':true': true, ':checked': nowIso } : { ':checked': nowIso },
    }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'ERROR', msg: 'drift flag write failed', providerCode: u.providerCode, error: e.message }));
  }
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
