// UK Clearing Advisor - SearchCourses (POST /search).
// Runs in estimated mode (seeded contacts + national subject averages).
// See shared.mjs for the no-UCAS-key DECISION.

import { randomUUID } from 'node:crypto';
import {
  ddb, GetCommand, ScanCommand, PutCommand,
  SUBJECTS, REQUIRED_SUBJECTS, gradeTotal, resolveSubject, maskIp,
  putMetric, log, json, errorResponse, checkRateLimit, ENVIRONMENT,
} from './shared.mjs';

const CONTACTS_TABLE = process.env.CONTACTS_TABLE;
const SUBJECT_DEFAULTS_TABLE = process.env.SUBJECT_DEFAULTS_TABLE;
const QUERY_CACHE_TABLE = process.env.QUERY_CACHE_TABLE;
const RATE_LIMITS_TABLE = process.env.RATE_LIMITS_TABLE;

// Specialist subjects are only offered by specific UK schools. We restrict
// these to the actual providers (by providerCode) so non-offering universities
// stop appearing (e.g. Bath for Dentistry). Common subjects are left
// unfiltered because nearly all universities offer them.
// DECISION: lists cover the seeded 44 universities only, from well-established
// UK medical/dental school lists. Pharmacy/Nursing are left unfiltered (offered
// broadly). Course-level truth still ultimately needs the live UCAS feed.
const RESTRICTED_SUBJECTS = {
  Dentistry: new Set([
    '0023', '0007', '0117', '0031', '0054', '0072', '0077', '0083',
    '0094', '0100', '0115', '0118', '0123', '0090',
  ]),
  Medicine: new Set([
    '0023', '0007', '0117', '0114', '0042', '0044', '0054', '0060', '0072',
    '0077', '0078', '0083', '0094', '0100', '0106', '0111', '0115', '0118',
    '0123', '0127', '0132', '0090', '0031', '0064', '0042-ea', '0116', '0122',
    '0013', '0019', '0105', '0082',
  ]),
};

const PRIORITIES = ['salary', 'employability', 'ranking', 'balanced'];
const LOCATIONS = ['any', 'england', 'scotland', 'wales', 'ni', 'london'];
const STUDY_MODES = ['full-time', 'part-time', 'any'];

// Reference data (university contacts, subject medians) changes throughout
// Clearing - status, phone lines and offers can change within the hour on
// Results Day. So there is NO caching here: every request re-scans DynamoDB
// so students always see the latest data, not a stale warm-Lambda snapshot.
let SUBJECT_DEFAULTS_CACHE = null;
let CONTACTS_CACHE = null;

async function loadReferenceData() {
  const [contacts, defaults] = await Promise.all([
    ddb.send(new ScanCommand({ TableName: CONTACTS_TABLE })),
    ddb.send(new ScanCommand({ TableName: SUBJECT_DEFAULTS_TABLE })),
  ]);
  CONTACTS_CACHE = contacts.Items || [];
  SUBJECT_DEFAULTS_CACHE = {};
  for (const d of defaults.Items || []) SUBJECT_DEFAULTS_CACHE[d.subjectGroup] = d;
}

// Indicative clearing entry threshold (numeric, best-3 grade points).
// DECISION: with no live UCAS grades, derive an indicative threshold from
// institution tier so filtering works. Always flagged as estimated.
function indicativeGrade(u) {
  if (u.ibTier === 'Tier 1' || (u.highFliersRank && u.highFliersRank <= 5)) return 34; // ~A*AA
  if (u.russellGroup) return 32; // ~AAB
  if (u.ibTier === 'Semi-target' || (u.highFliersRank && u.highFliersRank <= 20)) return 31; // ~ABB
  return 30; // ~BBB
}

function offerBand(numeric) {
  if (numeric >= 34) return 'A*AA (indicative)';
  if (numeric >= 33) return 'AAA (indicative)';
  if (numeric >= 32) return 'AAB (indicative)';
  if (numeric >= 31) return 'ABB (indicative)';
  if (numeric >= 30) return 'BBB (indicative)';
  return 'BBC (indicative)';
}

// Badge reflects the UNIVERSITY's overall Clearing status, not the specific
// course. Labels are worded to make that explicit (see also statusNote below).
function statusBadge(clearingStatus) {
  const s = (clearingStatus || '').toLowerCase();
  if (s.includes('closed')) return { colour: 'Red', label: 'University not in Clearing' };
  if (s.includes('opens')) return { colour: 'Amber', label: 'University opens on Results Day' };
  return { colour: 'Green', label: 'University in Clearing' };
}

const REGION_MATCH = {
  england: (u) => u.region === 'England',
  scotland: (u) => u.region === 'Scotland',
  wales: (u) => u.region === 'Wales',
  ni: (u) => u.region === 'Northern Ireland',
  london: (u) => (u.location || '').toLowerCase().includes('london'),
};

function validate(body) {
  if (!body || typeof body !== 'object') return 'Request body is required.';
  if (!Array.isArray(body.subjects) || body.subjects.length < 2) {
    return 'At least two A-level subject and grade pairs are required.';
  }
  for (const s of body.subjects) {
    if (!s || typeof s.subject !== 'string' || typeof s.grade !== 'string') {
      return 'Each subject must have a subject name and grade.';
    }
  }
  if (body.priority && !PRIORITIES.includes(body.priority)) return 'Invalid priority.';
  if (body.location && !LOCATIONS.includes(body.location)) return 'Invalid location.';
  if (body.studyMode && !STUDY_MODES.includes(body.studyMode)) return 'Invalid study mode.';
  return null;
}

export const handler = async (event) => {
  const started = Date.now();
  const requestId = event?.requestContext?.requestId || randomUUID();
  const sourceIp = event?.requestContext?.http?.sourceIp
    || event?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || 'unknown';
  const maskedIp = maskIp(sourceIp);

  // Geolocation + device from CloudFront viewer headers (forwarded by the
  // CloudFront origin-request policy). Logged as structured fields so the
  // Grafana geomap / breakdown panels can query them via Logs Insights.
  const h = event?.headers || {};
  const geoLatRaw = h['cloudfront-viewer-latitude'];
  const geoLonRaw = h['cloudfront-viewer-longitude'];
  const geo = {
    geoCountry: h['cloudfront-viewer-country'] || null,
    geoRegion: h['cloudfront-viewer-country-region-name'] || h['cloudfront-viewer-country-region'] || null,
    geoCity: h['cloudfront-viewer-city'] || null,
    geoLat: geoLatRaw ? Number(geoLatRaw) : null,
    geoLon: geoLonRaw ? Number(geoLonRaw) : null,
    device: h['cloudfront-is-mobile-viewer'] === 'true' ? 'Mobile'
      : h['cloudfront-is-tablet-viewer'] === 'true' ? 'Tablet'
      : h['cloudfront-is-desktop-viewer'] === 'true' ? 'Desktop' : 'Unknown',
    userAgent: h['user-agent'] || null,
  };

  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body || '{}') : (event.body || {});
  } catch {
    return errorResponse(400, 'INVALID_INPUT', 'Request body must be valid JSON.', requestId);
  }

  // WarmUp bypass (spec: token "__WARMUP__").
  if (body.cfTurnstileToken === '__WARMUP__') {
    await putMetric('WarmUpExecuted', 1);
    return json(200, { warmed: true });
  }

  // STEP 0 - honeypot. Non-empty "website" -> 200 empty (do not 403).
  if (body.website) {
    await putMetric('HoneypotTriggered', 1);
    log('WARN', { level: 'WARN', msg: 'honeypot triggered', requestId, sourceIp: maskedIp });
    return json(200, { results: [], totalMatches: 0, queryId: null, searchTimeMs: Date.now() - started });
  }

  // STEP 0b - validation.
  const validationError = validate(body);
  if (validationError) {
    return errorResponse(400, 'INVALID_INPUT', validationError, requestId);
  }

  // STEP 1 - Turnstile: no key configured -> allow through (spec: never block).

  // STEP 2 - rate limiting (per IP: 10/min, 100/hour).
  const perMin = await checkRateLimit(RATE_LIMITS_TABLE, `ip#${sourceIp}#m`, 10, 60);
  if (!perMin.allowed) {
    await putMetric('RateLimitedCount', 1);
    return errorResponse(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment.', requestId, { retryAfter: perMin.retryAfter });
  }
  const perHour = await checkRateLimit(RATE_LIMITS_TABLE, `ip#${sourceIp}#h`, 100, 3600);
  if (!perHour.allowed) {
    await putMetric('RateLimitedCount', 1);
    return errorResponse(429, 'RATE_LIMITED', 'Hourly request limit reached.', requestId, { retryAfter: perHour.retryAfter });
  }

  try {
    await loadReferenceData();

    // STEP 3 - grade conversion.
    const candidateTotal = gradeTotal(body.subjects);
    const candidateSubjects = body.subjects.map((s) => (s.subject || '').trim());

    // STEP 4 - resolve course interest.
    const resolved = resolveSubject(body.courseInterest || '');
    const priority = body.priority || 'balanced';
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 10, 1), 50);

    // STEP 6/7 - build candidate courses from seeded data (estimated mode).
    const restrictedSet = resolved ? RESTRICTED_SUBJECTS[resolved] : null;
    const courses = [];
    for (const u of CONTACTS_CACHE) {
      // Specialist-subject filter: only actual offering schools.
      if (restrictedSet && !restrictedSet.has(u.providerCode)) continue;
      // Location filter.
      if (body.location && body.location !== 'any') {
        const fn = REGION_MATCH[body.location];
        if (fn && !fn(u)) continue;
      }
      if (body.russellGroupOnly && !u.russellGroup) continue;
      // Skip institutions that do not enter clearing at all.
      if ((u.clearingStatus || '').toLowerCase() === 'closed') continue;

      const subjectName = resolved || 'Multiple subjects';
      const defaults = resolved ? SUBJECT_DEFAULTS_CACHE[resolved] : null;
      // Salary is the NATIONAL median for the subject - identical for every
      // university in a given search, so it is kept here only for ranking
      // and the minSalary filter, then stripped from each result before the
      // response goes out. It is shown once, in the top-level salaryContext
      // below, rather than repeated on every course card.
      const nationalMedianSalary = defaults ? Number(defaults.salary15months) : null;
      // Employability is the verified per-university graduate prospects figure
      // (CUG 2027) where published; otherwise null (never estimated/derived).
      // This DOES vary by university, so it stays on each result.
      const graduateProspects = u.graduateProspects != null ? Number(u.graduateProspects) : null;

      const gradeNumeric = indicativeGrade(u);

      // subjectWarning: course typically needs a subject the student didn't list.
      let subjectWarning = null;
      if (resolved && REQUIRED_SUBJECTS[resolved]) {
        const missing = REQUIRED_SUBJECTS[resolved].filter(
          (req) => !candidateSubjects.some((cs) => cs.toLowerCase() === req.toLowerCase()));
        if (missing.length) {
          subjectWarning = `Usually requires A-level ${missing.join(' or ')}. Confirm with the university.`;
        }
      }

      const badge = statusBadge(u.clearingStatus);
      const codes = resolved ? (SUBJECTS[resolved] || []) : [];

      courses.push({
        providerCode: u.providerCode,
        universityName: u.universityName,
        courseTitle: resolved ? `${subjectName} (indicative)` : 'Multiple subjects - see clearing page',
        ucasCode: codes[0] || null,
        region: u.region,
        location: u.location,
        russellGroup: !!u.russellGroup,
        clearingStatus: u.clearingStatus,
        statusBadge: badge,
        typicalOffer: offerBand(gradeNumeric),
        clearingGradeNumeric: gradeNumeric,
        graduateProspects,
        graduateProspectsYear: graduateProspects != null ? 'Complete University Guide 2027' : null,
        graduateProspectsSource: u.graduateProspectsSource || null,
        graduateProspectsSourceUrl: u.graduateProspectsSourceUrl || null,
        // nationalMedianSalary is intentionally NOT included per-result - see
        // salaryContext in the top-level response. Kept as _nationalMedianSalary
        // (internal, stripped before the response is sent) so ranking and the
        // minSalary filter still work.
        _nationalMedianSalary: nationalMedianSalary,
        highFliersRank: u.highFliersRank ?? null,
        clearingPhone: u.clearingPhone || null,
        clearingEmail: u.clearingEmail || null,
        clearingPage: u.clearingPage || null,
        accommodationGuarantee: !!u.accommodationGuarantee,
        hotlineOpens: u.hotlineOpens || null,
        estimatedData: true,
        courseLevelConfirmed: false,
        statusNote: 'Status shown is for the university overall, not this specific course. Confirm this course is in Clearing with the university.',
        subjectWarning,
        notes: u.notes || null,
      });
    }

    // STEP 8 - filter by achievable grade + numeric thresholds.
    let filtered = courses.filter((c) => c.clearingGradeNumeric <= candidateTotal);
    if (body.minEmployability) {
      filtered = filtered.filter((c) => c.graduateProspects != null && c.graduateProspects >= body.minEmployability);
    }
    if (body.minSalary) {
      filtered = filtered.filter((c) => c._nationalMedianSalary != null && c._nationalMedianSalary >= body.minSalary);
    }

    const ranked = rankCourses(filtered, priority);
    // Salary is identical for every result in a search (same subject ->
    // same national median), so surface it once at the top level instead of
    // repeating it on every card, then drop the internal field from results.
    const salaryContext = resolved && SUBJECT_DEFAULTS_CACHE[resolved]
      ? {
          subject: resolved,
          nationalMedianSalary: Number(SUBJECT_DEFAULTS_CACHE[resolved].salary15months),
          source: SUBJECT_DEFAULTS_CACHE[resolved].source || null,
          sourceUrl: SUBJECT_DEFAULTS_CACHE[resolved].salarySourceUrl || null,
          year: SUBJECT_DEFAULTS_CACHE[resolved].salaryYear || null,
        }
      : null;
    const results = ranked.slice(0, limit).map((c) => {
      const { _nationalMedianSalary, ...rest } = c;
      return rest;
    });

    // STEP 9 - store query (30-min TTL) for export/share.
    const queryId = randomUUID();
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      await ddb.send(new PutCommand({
        TableName: QUERY_CACHE_TABLE,
        Item: {
          queryId,
          results: JSON.stringify(results),
          salaryContext: JSON.stringify(salaryContext),
          totalMatches: filtered.length,
          createdAt: new Date().toISOString(),
          exported: false,
          sourceIp: maskedIp,
          ttl: nowSec + 30 * 60,
        },
      }));
    } catch (e) {
      log('ERROR', { level: 'ERROR', msg: 'query cache write failed', requestId, error: e.message });
    }

    const totalLatencyMs = Date.now() - started;

    // STEP 10 - metrics.
    await Promise.all([
      putMetric('SearchCount', 1),
      putMetric('CacheMiss', 1),
      putMetric('EstimatedDataServed', 1),
      putMetric('ResultsReturned', results.length),
      putMetric('TotalSearchLatencyMs', totalLatencyMs, 'Milliseconds'),
      results.length === 0 ? putMetric('ZeroResultsCount', 1) : Promise.resolve(),
      putMetric('CourseInterestSearched', 1, 'Count', [{ Name: 'CourseInterest', Value: resolved || 'unspecified' }]),
      putMetric('PrioritySelected', 1, 'Count', [{ Name: 'Priority', Value: priority }]),
    ]);

    // Human-readable "Subject:Grade" list (e.g. "Mathematics:A, Physics:A,
    // History:B") so Grafana can show what students are actually entering,
    // not just the numeric grade total.
    const subjectsEntered = body.subjects
      .map((s) => `${(s.subject || '').trim()}:${(s.grade || '').toUpperCase()}`)
      .join(', ');

    log('INFO', {
      level: 'INFO', msg: 'search', requestId, sourceIp: maskedIp,
      courseInterest: resolved || 'unspecified', subjectCount: body.subjects.length,
      subjectsEntered, gradeTotal: candidateTotal,
      priority, locationFilter: body.location || 'any', russellGroupOnly: !!body.russellGroupOnly,
      cacheHit: false, totalLatencyMs,
      resultsCount: results.length, usingFallback: true, environment: ENVIRONMENT,
      geoCountry: geo.geoCountry, geoRegion: geo.geoRegion, geoCity: geo.geoCity,
      geoLat: geo.geoLat, geoLon: geo.geoLon, device: geo.device, userAgent: geo.userAgent,
    });

    return json(200, {
      results,
      salaryContext,
      totalMatches: filtered.length,
      queryId,
      searchTimeMs: totalLatencyMs,
      dataFreshness: new Date().toISOString(),
      usingCachedData: false,
      estimatedData: true,
      notice: 'Salary shown is the national median for the subject (HESA Graduate Outcomes 2022/23), not a university-specific figure - it does not vary by university. Graduate prospects, where shown, are from the Complete University Guide 2027 and do vary by university. Live UCAS clearing vacancies are confirmed by phone on Results Day (Thursday 13 August 2026).',
    });
  } catch (e) {
    log('ERROR', { level: 'ERROR', msg: 'search failed', requestId, error: e.message, stack: e.stack });
    await putMetric('LambdaErrorCount', 1);
    return errorResponse(500, 'INTERNAL_ERROR', 'An unexpected error occurred.', requestId);
  }
};

// Normalise each metric 0..1 across the result set, then weight by priority.
function rankCourses(courses, priority) {
  if (!courses.length) return courses;
  // Salary is a national subject median (identical across universities for a
  // given subject) and graduate prospects are only present for some
  // universities, so both are null-safe and default to a neutral 0.5.
  const salaries = courses.map((c) => c._nationalMedianSalary).filter((v) => v != null);
  const emps = courses.map((c) => c.graduateProspects).filter((v) => v != null);
  const minS = salaries.length ? Math.min(...salaries) : 0;
  const maxS = salaries.length ? Math.max(...salaries) : 0;
  const minE = emps.length ? Math.min(...emps) : 0;
  const maxE = emps.length ? Math.max(...emps) : 0;
  const norm = (v, lo, hi) => (hi === lo ? 0.5 : (v - lo) / (hi - lo));
  const salaryScore = (c) => (c._nationalMedianSalary == null ? 0.5 : norm(c._nationalMedianSalary, minS, maxS));
  const empScore = (c) => (c.graduateProspects == null ? 0.5 : norm(c.graduateProspects, minE, maxE));
  // Ranking dimension: use highFliersRank where present (1 -> 1.0), else 0.5.
  const rankScore = (c) => (c.highFliersRank ? Math.max(0, 1 - (c.highFliersRank - 1) / 30) : 0.5);

  const weights = {
    salary: { s: 0.7, e: 0.2, r: 0.1 },
    employability: { s: 0.2, e: 0.7, r: 0.1 },
    ranking: { s: 0.15, e: 0.25, r: 0.6 },
    balanced: { s: 0.35, e: 0.4, r: 0.25 },
  }[priority] || { s: 0.35, e: 0.4, r: 0.25 };

  for (const c of courses) {
    c.score = Number((
      weights.s * salaryScore(c) +
      weights.e * empScore(c) +
      weights.r * rankScore(c)
    ).toFixed(4));
  }
  return courses.sort((a, b) => b.score - a.score);
}
