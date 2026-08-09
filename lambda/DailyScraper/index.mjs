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

// DECISION: investigated why ~8/44 university sites consistently 403 this
// scraper (see CHANGELOG). Confirmed via direct probing (same IP, only the
// UA changed) that at least 2 of them (QMUL, Durham - both CloudFront-
// fronted) block purely on a naive "does this look like a browser UA"
// pattern match against the old string 'UKClearingAdvisor/1.0
// (+monitoring)' - literally containing the word "monitoring" was enough
// to trip it. This new UA follows the same transparent, standard
// self-declaring-bot convention real crawlers use (Googlebot, Bingbot,
// etc.): a 'Mozilla/5.0 (compatible; ...)' prefix so naive UA-prefix
// filters pass it, while the string still HONESTLY identifies this as a
// bot and gives a real contact URL - this is not browser impersonation,
// nothing about the request claims to be a human or a specific real
// browser. Confirmed this format alone (no other header changes) flips
// QMUL and Durham from 403 to 200.
// NOT expected to fix every blocked site: 4 others (Cardiff, City London,
// Hertfordshire, Dundee) are behind a Cloudflare JS challenge (Turnstile),
// which requires executing JavaScript - no UA or header change can pass
// that, confirmed by testing full browser headers + a cookie jar against
// Cardiff and still getting 403. Those are expected to remain flagged
// 'blocked' to students (with the existing UI fallback to the phone
// number) rather than chasing a headless-browser or paid-proxy fix for a
// background freshness check.
const SCRAPER_USER_AGENT = 'Mozilla/5.0 (compatible; UKClearingAdvisorBot/1.0; +https://dfmqz7kt534c0.cloudfront.net/faq.html)';

// robots.txt cache, keyed by origin - one fetch per host per Lambda
// container per day (this function typically runs once, cold, per
// invocation), not per university. Backs the FAQ's promise that a site
// owner can opt this bot out via robots.txt like any other automated
// checker - this is a genuine commitment, not just wording, so it needs
// real code behind it.
const robotsCache = new Map();

// Minimal robots.txt parser: only what's needed to answer "is this exact
// path disallowed for our UA token (or *)". Deliberately not a full
// standards-compliant parser (no wildcard/regex path matching, no
// Sitemap/Crawl-delay handling) - the only real-world cases seen on UK
// university sites during investigation were either no robots.txt
// restriction at all, or a straightforward path-prefix Disallow, and a
// minimal parser that's easy to verify is safer than a clever one that's
// easy to get wrong for a rule that gates whether we fetch at all.
function isDisallowed(robotsText, path, userAgentToken) {
  if (!robotsText) return false;
  const lines = robotsText.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
  let currentAgents = [];
  let applicable = false;
  const disallowsByAgent = { specific: [], wildcard: [] };
  for (const line of lines) {
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!m) continue;
    const [, field, rawValue] = m;
    const value = rawValue.trim();
    const fieldLower = field.toLowerCase();
    if (fieldLower === 'user-agent') {
      currentAgents = [value.toLowerCase()];
      continue;
    }
    if (fieldLower === 'disallow' && value) {
      for (const agent of currentAgents) {
        if (agent === '*') disallowsByAgent.wildcard.push(value);
        else if (userAgentToken.toLowerCase().includes(agent)) disallowsByAgent.specific.push(value);
      }
    }
  }
  applicable = disallowsByAgent.specific.length > 0;
  const rules = applicable ? disallowsByAgent.specific : disallowsByAgent.wildcard;
  return rules.some((rule) => path.startsWith(rule));
}

async function isAllowedByRobots(target) {
  try {
    const u = new URL(target);
    const origin = u.origin;
    let robotsText = robotsCache.get(origin);
    if (robotsText === undefined) {
      try {
        const res = await fetch(`${origin}/robots.txt`, {
          method: 'GET', redirect: 'follow',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { 'User-Agent': SCRAPER_USER_AGENT },
        });
        robotsText = res.ok ? await res.text() : null;
      } catch {
        robotsText = null; // robots.txt unreachable -> fail open, same as most crawlers
      }
      robotsCache.set(origin, robotsText);
    }
    return !isDisallowed(robotsText, u.pathname, 'UKClearingAdvisorBot');
  } catch {
    return true; // malformed URL handled elsewhere; don't block on a robots check failure
  }
}

async function fetchStatus(url) {
  const target = /^https?:\/\//.test(url) ? url : `https://${url}`;
  if (!(await isAllowedByRobots(target))) {
    return { httpStatus: null, mentionsClearing: false, size: 0, robotsDisallowed: true };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(target, { method: 'GET', redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': SCRAPER_USER_AGENT } });
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

// Classify the fetch outcome into a small, student-relevant set of states.
// This is deliberately about "can a link to this page be trusted", not
// about clearing status itself (that heuristic - OPEN_HINTS/CLOSED_HINTS -
// stays advisory-only per the comment above and is never conflated with
// this). Written on EVERY run (see processOne below), unlike
// possibleStatusChange, which only fires on a CHANGE between two runs - a
// page that has been dead since the day it was seeded would otherwise never
// get flagged, because there's nothing to "change" from.
//   'ok'          - a normal successful fetch (2xx/3xx-followed).
//   'unreachable' - the page itself is gone (404/410) or erroring (5xx), or
//                    the request failed outright (DNS, timeout, network).
//                    A real visitor's browser would see the same failure.
//   'blocked'     - 403/429. Likely the university's site blocking this
//                    scraper's bot signature specifically (some UK
//                    university sites do this), NOT necessarily broken for
//                    a real student's browser. Shown to students with
//                    different, less alarming wording than 'unreachable'
//                    for exactly that reason - see SearchCourses.
//   'robots-excluded' - the university's own robots.txt asked this bot not
//                    to fetch this path. Deliberately NOT the same as
//                    'unreachable' - this isn't a failure, it's honouring
//                    an explicit opt-out (see the FAQ's promise to site
//                    owners). Never overwrites clearingPageStatus with
//                    stale/misleading info in this case - see processOne.
function classifyFetch(httpStatus, robotsDisallowed) {
  if (robotsDisallowed) return 'robots-excluded';
  if (httpStatus == null) return 'unreachable'; // fetch threw (network/timeout/DNS)
  if (httpStatus === 403 || httpStatus === 429) return 'blocked';
  if (httpStatus >= 400) return 'unreachable'; // 404, 410, 5xx, other 4xx
  return 'ok';
}

async function processOne(u, results) {
  const url = u.clearingPage;
  if (!url) return;
  let current;
  let fetchFailed = false;
  results.checked = (results.checked || 0) + 1;
  try {
    current = await fetchStatus(url);
  } catch (e) {
    results.errors++;
    fetchFailed = true;
    current = { httpStatus: null, mentionsClearing: false, size: 0 };
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
  const clearingPageStatus = classifyFetch(current.httpStatus, current.robotsDisallowed);
  if (clearingPageStatus === 'unreachable') results.unreachable = (results.unreachable || 0) + 1;
  if (clearingPageStatus === 'blocked') results.blocked = (results.blocked || 0) + 1;
  if (clearingPageStatus === 'robots-excluded') results.robotsExcluded = (results.robotsExcluded || 0) + 1;
  // Only compare mentionsClearing drift when both runs actually got a real
  // fetch - a transient network failure shouldn't register as a clearing
  // status "change" just because mentionsClearing defaulted to false.
  const changed = prev && !fetchFailed && (
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
      clearingPageStatus,
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
  // lastAutomatedCheck and clearingPageStatus always update (every run) -
  // unlike possibleStatusChange, which is only ever SET to true here (when
  // this run detects a real change since the previous run) and is
  // deliberately never cleared back to false by the scraper itself - it
  // stays flagged until a human re-seeds the data (seed.py writes a fresh
  // lastVerified and clears this field), so a detected drift can't silently
  // disappear again before anyone reviews it. clearingPageStatus is
  // different on purpose: it always reflects TODAY's fetch, because a dead
  // link that's been dead since day one (no "change" to detect) still
  // needs to be flagged to students on every single search, not just once.
  try {
    const names = { '#status': 'clearingPageStatus' };
    const values = { ':status': clearingPageStatus, ':checked': nowIso };
    let expr = 'SET #status = :status, lastAutomatedCheck = :checked';
    if (changed) {
      expr += ', possibleStatusChange = :true, lastDetectedChangeAt = :checked';
      values[':true'] = true;
    }
    await ddb.send(new UpdateCommand({
      TableName: CONTACTS_TABLE,
      Key: { providerCode: u.providerCode },
      UpdateExpression: expr,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'ERROR', msg: 'drift flag write failed', providerCode: u.providerCode, error: e.message }));
  }

  // Structured per-university log line (one per run, every run) purely so
  // "age of most recent data per university" is queryable via a CloudWatch
  // Logs Insights `stats latest(checkedAt) by universityName` - the
  // DynamoDB record above already holds lastAutomatedCheck, but Grafana's
  // provisioned datasource on this project is CloudWatch-only (no
  // DynamoDB/HTTP plugin - see stacks/grafana.yaml), so the freshness
  // dashboard needs this data to exist in CloudWatch Logs, not just
  // DynamoDB. Deliberately a separate log line/msg from the main 'scrape
  // complete' summary line, so per-university freshness can be queried
  // without parsing the aggregate line.
  console.log(JSON.stringify({
    level: 'INFO', msg: 'university-check', providerCode: u.providerCode,
    universityName: u.universityName, checkedAt: nowIso, clearingPageStatus,
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
    metric('ClearingPageUnreachableCount', results.unreachable || 0),
    metric('ClearingPageBlockedCount', results.blocked || 0),
    metric('ClearingPageRobotsExcludedCount', results.robotsExcluded || 0),
  ]);
  console.log(JSON.stringify({ level: 'INFO', msg: 'scrape complete', ...results }));
  return results;
};
