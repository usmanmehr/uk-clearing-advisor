// UK Clearing Advisor - ScrapeConfirmedCourses (EventBridge Scheduler).
//
// DECISION: DailyScraper (see lambda/DailyScraper) only checks whether a
// university's clearing page is REACHABLE and mentions "clearing" - it
// never extracts real course/vacancy data, because almost every UK
// university's clearing course finder loads its data via client-side
// JS/AJAX, which this project's Lambda-based scraper cannot execute
// (confirmed by direct investigation - see CHANGELOG). Out of all 44
// seeded universities, exactly 4 publish their course list as genuine
// static server-rendered HTML that a plain fetch can read: Manchester,
// UCL, Warwick, Lincoln. This Lambda is dedicated to those 4 only - it is
// NOT a generalised scraper and deliberately does not attempt the other
// 40 (see WELL-ARCHITECTED.md for why: JS-rendered pages need a headless
// browser, which was assessed as disproportionate cost/fragility for
// this project, same reasoning as the earlier UA/robots.txt work).
//
// Writes to ScrapedCoursesTable, a table entirely separate from
// ClearingCacheTable/UniversityContactsTable - this is real, per-course,
// confirmed-on-a-specific-page data, not the estimated/national-average
// data SearchCourses serves today. Nothing in SearchCourses reads this
// table yet (see PR description) - this Lambda exists standalone so the
// scraping/parsing logic can be built and verified against live data
// with zero risk to the current, working student-facing search.
//
// Each of the 4 parsers is a pure function operating on raw HTML text
// (regex-based, not a DOM parser - there is no npm install in this
// project's Lambda build, see build_lambdas.py, so no cheerio/jsdom is
// available; a small set of regexes verified against real fetched HTML
// is simpler and easier to audit than a hand-rolled HTML tokenizer).
// A broken/changed parser for ONE university must never affect the
// other 3 or fail the whole run - each university is wrapped in its own
// try/catch, matching DailyScraper's per-university error isolation.
import { ddb, PutCommand, putMetric, log } from './shared.mjs';

const TABLE = process.env.SCRAPED_COURSES_TABLE;
const FETCH_TIMEOUT_MS = 8000;
// Same UA as DailyScraper (lambda/DailyScraper/index.mjs) - a standard,
// transparent self-declaring-bot string, not browser impersonation. See
// that file's DECISION comment for the full investigation this came from.
const SCRAPER_USER_AGENT = 'Mozilla/5.0 (compatible; UKClearingAdvisorBot/1.0; +https://dfmqz7kt534c0.cloudfront.net/faq.html)';
// 90 minutes: long enough that a single failed fetch (network blip) doesn't
// immediately blank out a university's confirmed courses, short enough
// that on Results Day a course closing for Clearing (see Lincoln's live
// open/closed status) doesn't keep showing as available for hours after
// this Lambda stops running or a parser silently breaks. Deliberately
// shorter than DailyScraper's own cadence - confirmed vacancy data needs
// to go stale and disappear (via TTL) faster than a page-reachability
// check does, not slower.
const TTL_SECONDS = 90 * 60;

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET', redirect: 'follow', signal: ctrl.signal,
      headers: { 'User-Agent': SCRAPER_USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ---- Manchester ----
// Static <li> list: <li id="..."><a href="..."><div class="title">Name
// <span class="screenreader"> Degree</span></div><div class="degree">Degree
// </div><div class="ucas"><div class="ucas-code">CODE</div></div></a></li>
// No open/closed status published per course on this page - every course
// listed here is, by definition, one Manchester has put in Clearing.
function parseManchester(html) {
  const re = /<li id="[^"]*"><a href="([^"]*)"><div class="title">(.*?)<span class="screenreader"> ([^<]*)<\/span><\/div><div class="degree">([^<]*)<\/div><div class="ucas"><div class="ucas-code">([^<]*)<\/div>/g;
  const courses = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, href, titleRaw, , degree, ucasCode] = m;
    const title = titleRaw.trim();
    courses.push({
      courseKey: ucasCode,
      courseTitle: `${title} (${degree})`,
      ucasCode,
      degreeType: degree,
      sourceUrl: new URL(href, 'https://www.manchester.ac.uk/study/undergraduate/applying/clearing/home/').toString(),
      clearingOpenStatus: null, // not published per-course on this page
    });
  }
  return courses;
}

// ---- UCL ----
// Real course data lives inside CSS/JS-toggled (but server-rendered, so
// present in a plain fetch) accordion sections:
// <div class="accordion__content js-accordion-content">
//   <div class="accordion__text"><ul>
//     <li><a href="URL">Title</a> - CODE</li>...
//   </ul></div></div>
function parseUcl(html) {
  const sectionRe = /<div  class="accordion__content js-accordion-content">\s*<div  class="accordion__text">(.*?)<\/div>\s*<\/div>/gs;
  const itemRe = /<li><a href="([^"]*)">([^<]*)<\/a>\s*-\s*([A-Z0-9]{4,5})<\/li>/g;
  const courses = [];
  let sectionMatch;
  while ((sectionMatch = sectionRe.exec(html)) !== null) {
    const section = sectionMatch[1];
    let m;
    itemRe.lastIndex = 0;
    while ((m = itemRe.exec(section)) !== null) {
      const [, href, titleRaw, ucasCode] = m;
      courses.push({
        courseKey: ucasCode,
        courseTitle: titleRaw.trim(),
        ucasCode,
        degreeType: null, // already folded into courseTitle (e.g. "BA Archaeology")
        sourceUrl: href,
        clearingOpenStatus: null,
      });
    }
  }
  return courses;
}

// ---- Warwick ----
// Server-rendered accordion tabs, one per subject area:
// <section ... aria-label="SubjectLabel" ...>...<li><a href="URL">Title
// (Degree)</a></li>...</section>
// Most panels show "Name (BSc)" - degree type only, no UCAS code in the
// visible text (confirmed: only the Chemistry panel happens to include one,
// e.g. "Chemistry BSc (F100)" - not a reliable pattern to depend on across
// panels). ucasCode is therefore usually null here; courseKey falls back to
// the course's own detail-page URL, which IS guaranteed unique per course.
const WARWICK_NON_SUBJECT_PANELS = new Set(['About Clearing at Warwick', 'Get in touch']);
function parseWarwick(html) {
  const panelRe = /<section aria-hidden="[^"]*" class="tabs-component--panel[^"]*"[^>]*aria-label="([^"]*)"[^>]*>(.*?)<\/section>/gs;
  const itemRe = /<li><a href="([^"]*)">([^<]*)<\/a><\/li>/g;
  const courses = [];
  let panelMatch;
  while ((panelMatch = panelRe.exec(html)) !== null) {
    const [, label, content] = panelMatch;
    if (WARWICK_NON_SUBJECT_PANELS.has(label)) continue;
    let m;
    itemRe.lastIndex = 0;
    while ((m = itemRe.exec(content)) !== null) {
      const [, href, titleRaw] = m;
      const title = titleRaw.trim();
      const ucasMatch = title.match(/\(([A-Z0-9]{4,5})\)\s*$/);
      courses.push({
        courseKey: href,
        courseTitle: title,
        ucasCode: ucasMatch ? ucasMatch[1] : null,
        degreeType: null, // folded into courseTitle
        sourceUrl: href,
        clearingOpenStatus: null,
      });
    }
  }
  return courses;
}

// ---- Lincoln ----
// <div id="..." class="clearingCourse uol-d-none" data-title="Name">
//   <h3 >Name</h3><p class="clearingStatus --open|--closed">Open/Closed for
//   Clearing</p>
//   [only when open: <p ...><strong>Clearing offers from N UCAS Tariff
//   Points</strong></p>]
//   <a href="URL" ...>View Course</a>
// The ONLY one of the 4 with live per-course open/closed status AND a
// numeric UCAS Tariff Points offer - both genuinely valuable, and both
// exactly the kind of thing that goes stale fastest on Results Day (see
// TTL_SECONDS above). Closed-for-Clearing courses are filtered out before
// storage, same principle as GetUniversities excluding closed
// universities - a closed course isn't an available vacancy, so it
// shouldn't be stored/shown as one.
function parseLincoln(html) {
  const re = /<div id="[^"]*" class="clearingCourse uol-d-none" data-title="([^"]*)"><h3 >[^<]*<\/h3><p class="clearingStatus (--open|--closed)">([^<]*)<\/p>(?:<p style="margin-left: 1\.5rem;"><strong>Clearing offers from ([0-9]+) UCAS Tariff Points<\/strong><\/p>)?<a href="([^"]*)"/g;
  const courses = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, title, statusClass, , tariffPoints, href] = m;
    if (statusClass === '--closed') continue; // not an available vacancy
    courses.push({
      courseKey: href, // stable per-course path, e.g. /course/acfnbsub
      courseTitle: title,
      ucasCode: null, // not published on this page
      degreeType: null, // folded into courseTitle (e.g. "... - BSc (Hons)")
      sourceUrl: new URL(href, 'https://www.lincoln.ac.uk/clearing/').toString(),
      clearingOpenStatus: 'open',
      minTariffPoints: tariffPoints ? Number(tariffPoints) : null,
    });
  }
  return courses;
}

// Each entry: providerCode (must match UniversityContactsTable's real
// seeded providerCode - see scripts/seed.py - so this data can eventually
// be joined against it), the exact URL to fetch, and the matching parser.
const TARGETS = [
  { providerCode: '0094', universityName: 'University of Manchester', url: 'https://www.manchester.ac.uk/study/undergraduate/applying/clearing/home/', parser: parseManchester },
  { providerCode: '0132', universityName: 'University College London', url: 'https://www.ucl.ac.uk/study/prospective-students/undergraduate/clearing', parser: parseUcl },
  { providerCode: '0137', universityName: 'University of Warwick', url: 'https://warwick.ac.uk/study/results/clearing/', parser: parseWarwick },
  { providerCode: '0082', universityName: 'University of Lincoln', url: 'https://www.lincoln.ac.uk/clearing/', parser: parseLincoln },
];

async function scrapeOne(target, results) {
  const nowSec = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  try {
    const html = await fetchHtml(target.url);
    const courses = target.parser(html);
    if (!courses.length) {
      // A parser returning zero courses on a 200 response is a strong
      // signal the site's HTML structure changed (parser broke), not that
      // the university genuinely has zero vacancies - flagged distinctly
      // from a normal per-course write failure so it surfaces on its own
      // metric rather than being silently indistinguishable from "0
      // courses were open today".
      results.zeroCourseUniversities = (results.zeroCourseUniversities || 0) + 1;
      log('WARN', {
        level: 'WARN', msg: 'scraper returned zero courses - parser may be broken',
        providerCode: target.providerCode, universityName: target.universityName,
      });
    }
    let written = 0;
    for (const course of courses) {
      try {
        await ddb.send(new PutCommand({
          TableName: TABLE,
          Item: {
            providerCode: target.providerCode,
            courseKey: course.courseKey,
            universityName: target.universityName,
            courseTitle: course.courseTitle,
            ucasCode: course.ucasCode,
            degreeType: course.degreeType,
            sourceUrl: course.sourceUrl,
            clearingOpenStatus: course.clearingOpenStatus,
            minTariffPoints: course.minTariffPoints ?? null,
            scrapedAt: nowIso,
            ttl: nowSec + TTL_SECONDS,
          },
        }));
        written++;
      } catch (e) {
        results.writeErrors = (results.writeErrors || 0) + 1;
        log('ERROR', {
          level: 'ERROR', msg: 'course write failed', providerCode: target.providerCode,
          courseKey: course.courseKey, error: e.message,
        });
      }
    }
    results.coursesWritten = (results.coursesWritten || 0) + written;
    results.universitiesOk = (results.universitiesOk || 0) + 1;
    log('INFO', {
      level: 'INFO', msg: 'university scraped', providerCode: target.providerCode,
      universityName: target.universityName, coursesFound: courses.length, coursesWritten: written,
    });
  } catch (e) {
    // A failure for ONE university (network error, timeout, HTTP error)
    // must never affect the other 3 - caught here, not at the handler
    // level, matching DailyScraper's per-university isolation.
    results.universitiesFailed = (results.universitiesFailed || 0) + 1;
    log('ERROR', {
      level: 'ERROR', msg: 'university scrape failed', providerCode: target.providerCode,
      universityName: target.universityName, error: e.message,
    });
  }
}

export const handler = async () => {
  const results = {};
  // Sequential, not Promise.all - only 4 targets, and keeping this simple
  // and easy to read in logs matters more than shaving a few seconds off
  // total runtime for a background job with no user waiting on it.
  for (const target of TARGETS) {
    await scrapeOne(target, results);
  }
  await Promise.all([
    putMetric('ConfirmedCoursesScraperRunCount', 1),
    putMetric('ConfirmedCoursesWrittenCount', results.coursesWritten || 0),
    putMetric('ConfirmedCoursesUniversitiesOkCount', results.universitiesOk || 0),
    putMetric('ConfirmedCoursesUniversitiesFailedCount', results.universitiesFailed || 0),
    putMetric('ConfirmedCoursesZeroCourseCount', results.zeroCourseUniversities || 0),
  ]);
  log('INFO', { level: 'INFO', msg: 'confirmed courses scrape complete', ...results });
  return results;
};
