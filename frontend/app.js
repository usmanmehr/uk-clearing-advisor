// UK Clearing Advisor - frontend logic (vanilla JS, no build step).
// Calls the API through the same CloudFront domain under /api/*.
'use strict';

const API = '/api';
const MAX_ALEVELS = 4;
const SEARCH_TIMEOUT_MS = 12000;

// Qualification types and their grade options. Values verified against
// Pearson's official BTEC/A-level UCAS Tariff table (qualifications.pearson.com)
// and cross-checked against ukcalculator.com - see lambda/shared/grading.mjs
// for the full verification note (this list only needs the grade labels,
// not the point values themselves - those are looked up server-side).
// Order matters: this is also the order shown in the "Qualification" dropdown.
const QUALIFICATION_TYPES = {
  alevel: { label: 'A-level', grades: ['A*', 'A', 'B', 'C', 'D', 'E'] },
  btecExtendedDiploma: {
    label: 'BTEC Extended Diploma (= 3 A-levels)',
    grades: ['D*D*D*', 'D*D*D', 'D*DD', 'DDD', 'DDM', 'DMM', 'MMM', 'MMP', 'MPP', 'PPP'],
  },
  btecDiploma: {
    label: 'BTEC Diploma (= 2 A-levels)',
    grades: ['D*D*', 'D*D', 'DD', 'DM', 'MM', 'MP', 'PP'],
  },
  btecExtendedCertificate: {
    label: 'BTEC Extended Certificate (= 1 A-level)',
    grades: ['D*', 'D', 'M', 'P'],
  },
};
let lastResults = [];
let shown = 0;
let subjectNames = []; // full subject list, loaded once, used for "did you mean"
const PAGE = 10;

// Valid A-level / BTEC subjects for the qualifications section - a
// DIFFERENT list from the course/degree subjects loaded via /subjects for
// "What do you want to study?" above. These are the actual exam subjects a
// student can hold a grade in (e.g. "Physics" the A-level, or "Applied
// Science" as a BTEC sector with no direct degree equivalent), not degree
// course names - the two vocabularies overlap a lot but aren't identical
// (e.g. "PPE" or "MORSE" are course names, never A-level/BTEC subjects).
// Static list rather than a server round-trip: this never changes at
// runtime, unlike course subjects which are looked up server-side.
const VALID_QUALIFICATION_SUBJECTS = [
  // Common A-level subjects
  'Mathematics', 'Further Mathematics', 'Physics', 'Chemistry', 'Biology',
  'Computer Science', 'Economics', 'Business', 'Business Studies', 'Accounting',
  'History', 'Geography', 'English Literature', 'English Language',
  'Psychology', 'Sociology', 'Politics', 'Law', 'Philosophy', 'Religious Studies',
  'French', 'Spanish', 'German', 'Latin', 'Classical Civilisation',
  'Art and Design', 'Design and Technology', 'Music', 'Music Technology', 'Drama and Theatre',
  'Physical Education', 'Media Studies', 'Film Studies',
  'Environmental Science', 'Statistics', 'Government and Politics',
  // Common BTEC subject/sector areas
  'Applied Science', 'Health and Social Care', 'Information Technology',
  'Engineering', 'Sport', 'Sport and Exercise Science', 'Performing Arts',
  'Creative Digital Media Production', 'Travel and Tourism', 'Hospitality',
  'Enterprise and Entrepreneurship', 'Construction and the Built Environment',
  'Applied Law', 'Applied Psychology',
];
// Lower-cased once for fast exact/substring lookups.
const VALID_QUALIFICATION_SUBJECTS_LOWER = VALID_QUALIFICATION_SUBJECTS.map((s) => s.toLowerCase());

const el = (id) => document.getElementById(id);
const fmtGBP = (n) => '£' + Number(n).toLocaleString('en-GB');

// Short relative-time string ("3 min ago", "yesterday") - used by the hero
// freshness stat so a visitor can see how current the automated checks are
// without doing date-maths on an ISO timestamp themselves.
function timeAgo(isoString) {
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return null;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Small Levenshtein distance for client-side "did you mean" suggestions.
// (A separate, tiny implementation - not shared with the backend's - since
// there is no build step to share modules between frontend and Lambda.)
function levenshtein(a, b) {
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

// ---- Qualification subject validation (A-level/BTEC subject field) ----
// Separate from the course-interest "did you mean" above: this is a hard
// allowlist check (must match a real qualification subject), not a soft
// free-text resolve, since a wrong course-interest just returns broader
// results, but a made-up qualification subject would be sent to the
// backend as if it were real.
//
// Returns { exact: true, name } for a case-insensitive exact match,
// { exact: false, name } for the closest fuzzy match (edit distance <=2,
// e.g. "Chemestry" -> "Chemistry"), or null if nothing is close enough to
// suggest.
function findClosestQualificationSubject(text) {
  const q = (text || '').trim().toLowerCase();
  if (!q) return null;
  const exactIdx = VALID_QUALIFICATION_SUBJECTS_LOWER.indexOf(q);
  if (exactIdx !== -1) return { exact: true, name: VALID_QUALIFICATION_SUBJECTS[exactIdx] };
  let best = null, bestD = 3; // threshold matches the course-interest "did you mean" logic above
  for (let i = 0; i < VALID_QUALIFICATION_SUBJECTS_LOWER.length; i++) {
    const d = levenshtein(q, VALID_QUALIFICATION_SUBJECTS_LOWER[i]);
    if (d < bestD) { bestD = d; best = VALID_QUALIFICATION_SUBJECTS[i]; }
  }
  return best ? { exact: false, name: best } : null;
}

function isValidQualificationSubject(text) {
  const q = (text || '').trim().toLowerCase();
  if (!q) return true; // not filled in yet - not an error, just incomplete
  return VALID_QUALIFICATION_SUBJECTS_LOWER.includes(q);
}

// Updates one row's inline error/suggestion. `showSuggestion` gates whether
// the "did you mean" text is actually shown (vs. just marking the field
// aria-invalid) - debounced on input so it doesn't flash while someone is
// mid-way through typing a longer subject name, but always shown on blur.
function updateSubjectValidation(row, showSuggestion) {
  const input = row.querySelector('.al-subject');
  const errorEl = row.querySelector('.subject-error');
  const value = input.value.trim();
  if (!value) {
    errorEl.hidden = true;
    input.removeAttribute('aria-invalid');
    return;
  }
  const match = findClosestQualificationSubject(value);
  if (match && match.exact) {
    errorEl.hidden = true;
    input.removeAttribute('aria-invalid');
    return;
  }
  input.setAttribute('aria-invalid', 'true');
  if (!showSuggestion) { errorEl.hidden = true; return; }
  if (match) {
    errorEl.innerHTML = `Not a recognised subject. Did you mean <button type="button" class="link-btn subject-suggestion">${match.name}</button>?`;
    errorEl.querySelector('.subject-suggestion').addEventListener('click', () => {
      input.value = match.name;
      updateSubjectValidation(row, true);
      validateForm();
    });
  } else {
    errorEl.textContent = 'Not a recognised A-level or BTEC subject. Choose one from the list.';
  }
  errorEl.hidden = false;
}

// Every row that has SOME text entered must be an exact allowlist match -
// an empty row (not yet filled in) is fine and doesn't block submission,
// matching the existing "at least 2 slots" rule's tolerance for blank rows.
function allQualificationSubjectsValid() {
  return Array.from(document.querySelectorAll('.alevel-row')).every(
    (r) => isValidQualificationSubject(r.querySelector('.al-subject').value));
}

// ---- Qualification rows (A-level or BTEC) ----
function gradeOptionsHtml(type, selectedGrade) {
  const grades = (QUALIFICATION_TYPES[type] || QUALIFICATION_TYPES.alevel).grades;
  // Keep the same grade selected across a type switch where the option
  // still exists (e.g. switching alevel<->btecExtendedCertificate both
  // have single-letter grades in a similar band); otherwise default to
  // the first (highest) option rather than leaving nothing selected.
  const grade = grades.includes(selectedGrade) ? selectedGrade : grades[0];
  return grades.map((g) => `<option ${g === grade ? 'selected' : ''}>${g}</option>`).join('');
}

function addAlevelRow(subject = '', grade = 'A', type = 'alevel') {
  const rows = el('alevels');
  if (rows.children.length >= MAX_ALEVELS) return;
  const row = document.createElement('div');
  row.className = 'alevel-row';
  const idx = rows.children.length;
  row.innerHTML =
    `<div class="field" style="margin:0">
       <label for="qual-${idx}">Qualification</label>
       <select id="qual-${idx}" class="al-type">
         ${Object.entries(QUALIFICATION_TYPES).map(([key, t]) =>
           `<option value="${key}" ${key === type ? 'selected' : ''}>${t.label}</option>`).join('')}
       </select>
     </div>
     <div class="field" style="margin:0">
       <label for="subj-${idx}">Subject</label>
       <input type="text" id="subj-${idx}" class="al-subject" list="qual-subject-list" value="${subject}" autocomplete="off">
       <p class="subject-error" hidden></p>
     </div>
     <div class="field" style="margin:0">
       <label for="grade-${idx}">Grade</label>
       <select id="grade-${idx}" class="al-grade">
         ${gradeOptionsHtml(type, grade)}
       </select>
     </div>
     <button type="button" class="remove" aria-label="Remove this qualification">Remove</button>`;
  row.querySelector('.remove').addEventListener('click', () => { row.remove(); validateForm(); });
  // Changing the qualification type swaps the grade dropdown's options to
  // match that qualification's real grade scale (e.g. A*-E for A-level vs
  // D*D*D*-PPP for a BTEC Extended Diploma) - the two scales use different
  // strings so the grade select can't just stay as-is across a type change.
  row.querySelector('.al-type').addEventListener('change', (e) => {
    const gradeSelect = row.querySelector('.al-grade');
    const currentGrade = gradeSelect.value;
    gradeSelect.innerHTML = gradeOptionsHtml(e.target.value, currentGrade);
    validateForm();
  });
  const subjectInput = row.querySelector('.al-subject');
  // Debounced fuzzy check while typing (mirrors the course-interest "did
  // you mean" debounce above) - shows a suggestion once the user pauses,
  // rather than flashing an error on every keystroke of a longer subject
  // name (e.g. "Religious Studies" would otherwise show an error for most
  // of the time it's being typed).
  let subjectDebounce;
  subjectInput.addEventListener('input', () => {
    updateSubjectValidation(row, false);
    clearTimeout(subjectDebounce);
    subjectDebounce = setTimeout(() => updateSubjectValidation(row, true), 400);
    validateForm();
  });
  // Always show the full error/suggestion immediately on blur, regardless
  // of the debounce timer - catches the case where a user tabs/clicks away
  // right after finishing typing, before the debounce would have fired.
  subjectInput.addEventListener('blur', () => updateSubjectValidation(row, true));
  row.querySelectorAll('select').forEach((i) => i.addEventListener('input', validateForm));
  rows.appendChild(row);
  if (subject) updateSubjectValidation(row, true); // prefilled row (e.g. from a shared URL) - validate immediately
  validateForm();
}

function clearAlevelRows() {
  el('alevels').innerHTML = '';
}

function collectAlevels() {
  return Array.from(document.querySelectorAll('.alevel-row')).map((r) => {
    const raw = r.querySelector('.al-subject').value.trim();
    // Normalise to the canonical allowlist spelling/casing on an exact
    // (case-insensitive) match - e.g. a user typing "chemistry" submits as
    // "Chemistry", matching what's shown everywhere else (results,
    // exports, logs) rather than whatever casing they happened to type.
    const match = findClosestQualificationSubject(raw);
    return {
      subject: match && match.exact ? match.name : raw,
      grade: r.querySelector('.al-grade').value,
      type: r.querySelector('.al-type').value,
    };
  }).filter((s) => s.subject);
}

// A-level-equivalent "slots" a qualification counts as - mirrors
// totalQualificationSlots() in lambda/shared/grading.mjs so the submit
// button's enabled state matches what the backend will actually accept
// (e.g. a single BTEC Diploma is 2 slots and is enough on its own, even
// though it's only 1 row).
const QUALIFICATION_SLOTS = { alevel: 1, btecExtendedDiploma: 3, btecDiploma: 2, btecExtendedCertificate: 1 };
function totalSlots(entries) {
  return entries.reduce((sum, s) => sum + (QUALIFICATION_SLOTS[s.type] || 1), 0);
}

function validateForm() {
  el('submit-btn').disabled = totalSlots(collectAlevels()) < 2 || !allQualificationSubjectsValid();
}

// ---- Subject autocomplete (debounced) + "did you mean" ----
let debounce;
async function loadSubjects(q) {
  try {
    const res = await fetch(`${API}/subjects${q ? `?q=${encodeURIComponent(q)}` : ''}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const list = el('subject-list');
    list.innerHTML = (data.subjects || []).map((s) => `<option value="${s}">`).join('');
    if (!q) subjectNames = data.subjects || []; // cache the full list from the initial empty-query load
  } catch { /* non-fatal */ }
}

// Shown while the user is typing, before they submit - lets a mistyped
// subject ("Buisness", "Comp Sci") get corrected early rather than silently
// resolving server-side or matching nothing.
function renderDidYouMean(query) {
  const box = el('did-you-mean');
  if (!query || query.length < 3 || !subjectNames.length) { box.hidden = true; return; }
  const qLower = query.toLowerCase();
  const exact = subjectNames.some((s) => s.toLowerCase() === qLower || s.toLowerCase().includes(qLower));
  if (exact) { box.hidden = true; return; }
  let best = null, bestD = 3;
  for (const name of subjectNames) {
    const d = levenshtein(qLower, name.toLowerCase());
    if (d < bestD) { bestD = d; best = name; }
  }
  if (!best) { box.hidden = true; return; }
  box.innerHTML = `Did you mean <button type="button" class="link-btn" id="dym-btn">${best}</button>?`;
  box.hidden = false;
  el('dym-btn').addEventListener('click', () => {
    el('course-interest').value = best;
    box.hidden = true;
  });
}

// ---- Rendering ----
function courseCard(c) {
  const badge = c.statusBadge || { colour: 'Amber', label: 'Check on Results Day' };
  const phone = c.clearingPhone
    ? `<a href="tel:${c.clearingPhone.replace(/[^+\d]/g, '')}">${c.clearingPhone}</a>` : 'See clearing page';
  // clearingPageState (set server-side from the daily automated check - see
  // SearchCourses) changes how the clearing-page link itself is shown:
  //  - 'unreachable': the page was broken the last time it was checked, so
  //    linking to it as if it works would send students to a dead page (the
  //    exact problem reported). Swap the link for a plain warning instead.
  //  - 'blocked': the university's site blocked the automated check
  //    specifically (likely anti-bot, not necessarily broken for a real
  //    browser) - keep the link but add a softer heads-up rather than
  //    hiding it.
  //  - 'robots-excluded': the university's own robots.txt asked our
  //    checker not to visit - we honour that (see the FAQ), so we
  //    genuinely have no verified freshness data here. Keep the link (a
  //    real visitor's browser isn't bound by robots.txt) but say plainly
  //    that we can't confirm it, without implying anything is broken.
  //  - anything else ('ok', or no data yet): show the link as normal.
  let page = '';
  let pageWarn = '';
  if (c.clearingPage) {
    const url = `https://${c.clearingPage.replace(/^https?:\/\//, '')}`;
    if (c.clearingPageState === 'unreachable') {
      pageWarn = '<div class="warn">Our last automated check could not load this university\'s clearing page - it may have moved. Use the phone number above instead.</div>';
    } else if (c.clearingPageState === 'blocked') {
      page = `<a href="${url}" target="_blank" rel="noopener">Clearing page</a>`;
      pageWarn = '<div class="note-line">Our automated check could not confirm this link is working, but it may just be blocking automated visits - it may still work fine in your browser.</div>';
    } else if (c.clearingPageState === 'robots-excluded') {
      page = `<a href="${url}" target="_blank" rel="noopener">Clearing page</a>`;
      pageWarn = '<div class="note-line">This university has asked automated checkers not to visit this page, so we can\'t confirm it\'s working - it should still work fine in your browser.</div>';
    } else {
      page = `<a href="${url}" target="_blank" rel="noopener">Clearing page</a>`;
    }
  }
  const warn = c.subjectWarning ? `<div class="warn">${c.subjectWarning}</div>` : '';
  const est = c.estimatedData ? ' <span class="badge Amber">Rough guide, not confirmed</span>' : '';
  // Set by the daily automated check when this university's clearing page
  // may have changed since it was last confirmed - advisory, not definitive
  // (see statusNote for the full caveat). Shown as its own line so it's not
  // missed alongside the other status badges.
  const driftWarn = c.possibleStatusChange
    ? '<div class="warn">Automated check flagged a possible change to this page - status above may be out of date. Confirm directly.</div>'
    : '';
  // Per-course "Clearing page checked X ago" line was removed - it added
  // no value at the individual-card level (see renderResultsDisclaimer
  // below for the single, page-level timestamp that replaces it).

  // Only show figures that are verified. Graduate prospects are per-university
  // (CUG 2027) where published and DO vary by university, so they stay on
  // each card. Salary is a national subject median (identical for every
  // university in this search) so it is shown once above the results list
  // instead - see renderSalaryBanner.
  const stats = [];
  if (c.graduateProspects != null) {
    stats.push(`<div class="stat"><b>${c.graduateProspects}%</b><span>graduate prospects</span></div>`);
  }
  // typicalOffer is now a plain-English sentence (e.g. "Likely to need
  // strong grades (e.g. AAB-level)"), not a compact figure like the stats
  // above, so it doesn't belong in the same bold-number stat box - it's
  // rendered as its own line instead, with a link to the FAQ explaining
  // where this comes from.
  const offerLine = `<div class="offer-line">${c.typicalOffer}
    <a href="/faq.html#grades" class="faq-inline-link">How is this worked out?</a></div>`;

  const sources = [];
  if (c.graduateProspects != null && c.graduateProspectsSourceUrl) {
    sources.push(`<a href="${c.graduateProspectsSourceUrl}" target="_blank" rel="noopener">Prospects: ${c.graduateProspectsYear || 'CUG 2027'}</a>`);
  }
  const sourceLine = sources.length ? `<div class="sources">Sources: ${sources.join(' &middot; ')}</div>` : '';

  return `<article class="course">
    <h3>${c.universityName}</h3>
    <div class="meta">${c.courseTitle}${c.ucasCode ? ` &middot; UCAS ${c.ucasCode}` : ''} &middot; ${c.location} &middot;
      <span class="badge ${badge.colour}">${badge.label}</span>${est}</div>
    <div class="stat-row">
      ${stats.join('\n      ')}
    </div>
    ${offerLine}
    ${sourceLine}
    ${warn}
    ${driftWarn}
    <div class="contact">Clearing: ${phone} ${page ? '&middot; ' + page : ''}
      ${c.hotlineOpens ? `<br>Hotline: ${c.hotlineOpens}` : ''}</div>
    ${pageWarn}
  </article>`;
}

function renderMore() {
  const container = el('results');
  const next = lastResults.slice(shown, shown + PAGE);
  container.insertAdjacentHTML('beforeend', next.map(courseCard).join(''));
  shown += next.length;
  el('show-more').hidden = shown >= lastResults.length;
}

// Salary is a national subject median - identical for every university in
// this result set - so it's shown once here rather than repeated per card.
function renderSalaryBanner(salaryContext) {
  const banner = el('salary-banner');
  if (!salaryContext || salaryContext.nationalMedianSalary == null) {
    banner.hidden = true;
    return;
  }
  const sourceLink = salaryContext.sourceUrl
    ? `<a href="${salaryContext.sourceUrl}" target="_blank" rel="noopener">HESA Graduate Outcomes ${salaryContext.year || ''}</a>`
    : `HESA Graduate Outcomes ${salaryContext.year || ''}`;
  banner.innerHTML =
    `National median salary for <b>${salaryContext.subject}</b> graduates: `
    + `<b>${fmtGBP(salaryContext.nationalMedianSalary)}</b> (15 months post-graduation, ${sourceLink}). `
    + `This is a national figure - it is the same for every university below, not a per-university wage.`;
  banner.hidden = false;
}

// ---- Global results-page disclaimer ----
// One prominent, page-level notice (not per-course) covering the two things
// that matter before a student trusts anything below it: how current the
// underlying clearing-page checks are, and that every status badge reflects
// the UNIVERSITY overall, not the specific course. Says this ONCE for the
// whole page - the per-card statusNote text and the per-card "checked X
// ago" timestamp were both removed as redundant, since every card was
// repeating the identical sentence.
function renderResultsDisclaimer(results) {
  const box = el('results-disclaimer');
  if (!results || !results.length) { box.hidden = true; return; }
  const timestamps = results
    .map((c) => c.lastAutomatedCheck)
    .filter(Boolean)
    .map((t) => new Date(t).getTime())
    .filter((t) => !Number.isNaN(t));
  const checkedLine = timestamps.length
    ? `Clearing pages last checked: <b>${new Date(Math.max(...timestamps)).toLocaleString('en-GB')}</b>.`
    : 'Clearing page check times are not yet available for these results.';
  box.innerHTML =
    `${checkedLine} The status shown for each university reflects its `
    + `<b>overall</b> Clearing availability, not this specific course - always `
    + `confirm directly with the university before relying on it.`;
  box.hidden = false;
}

function showSkeletons() {
  el('results-section').hidden = false;
  el('results-disclaimer').hidden = true;
  el('results-summary').textContent = 'Searching...';
  el('results').innerHTML = Array(3).fill('<div class="skeleton"></div>').join('');
  el('show-more').hidden = true;
}

// Actionable next steps when a search returns nothing, based on which
// filters are actually active - rather than a generic dead-end message.
function renderZeroResultsGuidance(payload) {
  const tips = [];
  if (payload.courseInterest) {
    tips.push(`Clear "${payload.courseInterest}" from what you want to study, to see every course you qualify for.`);
  }
  if (payload.russellGroupOnly) {
    tips.push('Untick "Russell Group only" - most universities in Clearing are outside the Russell Group.');
  }
  if (payload.location && payload.location !== 'any') {
    tips.push('Change location to "Anywhere in the UK".');
  }
  tips.push('Double-check your grades are entered correctly - a lower grade than intended will rule out more courses.');
  tips.push('If your grades are genuinely below what Clearing universities are asking for this year, call a university\'s clearing hotline directly - some accept applications below their published typical offer.');

  el('results-summary').innerHTML =
    'No matching courses found with these settings. Try:'
    + '<ul class="tip-list">' + tips.map((t) => `<li>${t}</li>`).join('') + '</ul>';
  el('show-more').hidden = true;
}

// ---- Shareable URL ----
// Encodes the current search into the address bar as query params (not
// pushState - replaceState only, so the back button isn't spammed) so a
// student can copy the link and send it to themselves or a parent, or
// reopen it later without retyping everything. Deliberately does NOT
// auto-run the search on page load - a URL with query params should
// pre-fill the form, not silently spend the visitor's rate-limit budget
// the moment the page opens.
function updateShareUrl(payload) {
  const params = new URLSearchParams();
  // Third segment (qualification type) is omitted for plain A-levels to
  // keep old-style links unchanged/shorter for the common case; only
  // appended for BTEC entries. prefillFromUrl() below treats a missing
  // third segment as 'alevel', so links generated before this feature
  // existed keep working exactly as before.
  for (const s of payload.subjects) {
    params.append('a', s.type && s.type !== 'alevel' ? `${s.subject}:${s.grade}:${s.type}` : `${s.subject}:${s.grade}`);
  }
  if (payload.courseInterest) params.set('ci', payload.courseInterest);
  if (payload.priority && payload.priority !== 'balanced') params.set('priority', payload.priority);
  if (payload.location && payload.location !== 'any') params.set('location', payload.location);
  if (payload.russellGroupOnly) params.set('rg', '1');
  const url = `${location.pathname}?${params.toString()}`;
  history.replaceState(null, '', params.toString() ? url : location.pathname);
}

function prefillFromUrl() {
  const params = new URLSearchParams(location.search);
  const subjectPairs = params.getAll('a');
  if (!subjectPairs.length) return false;
  clearAlevelRows();
  for (const pair of subjectPairs.slice(0, MAX_ALEVELS)) {
    // Backward compatible: links created before BTEC support only have
    // "subject:grade" (2 parts) and always meant an A-level - a missing
    // third segment defaults to 'alevel' so those old links still prefill
    // correctly rather than silently dropping the row.
    const [subject, grade, type] = pair.split(':');
    const qualType = QUALIFICATION_TYPES[type] ? type : 'alevel';
    const grades = QUALIFICATION_TYPES[qualType].grades;
    if (subject) addAlevelRow(decodeURIComponent(subject), grades.includes(grade) ? grade : grades[0], qualType);
  }
  if (params.get('ci')) el('course-interest').value = params.get('ci');
  if (params.get('priority')) el('priority').value = params.get('priority');
  if (params.get('location')) el('location').value = params.get('location');
  if (params.get('rg') === '1') el('russellGroupOnly').checked = true;
  return true;
}

// ---- Submit ----
async function onSubmit(e) {
  e.preventDefault();
  const subjects = collectAlevels();
  // Belt-and-braces alongside the disabled submit button: a subject
  // typed and left un-corrected (or a row prefilled from a manipulated
  // share URL) must not reach the backend as if it were a real
  // qualification subject. Surface every offending row's suggestion/error
  // rather than submitting silently.
  if (totalSlots(subjects) < 2 || !allQualificationSubjectsValid()) {
    document.querySelectorAll('.alevel-row').forEach((row) => updateSubjectValidation(row, true));
    return;
  }
  showSkeletons();

  const payload = {
    subjects,
    courseInterest: el('course-interest').value.trim(),
    priority: el('priority').value,
    location: el('location').value,
    russellGroupOnly: el('russellGroupOnly').checked,
    website: el('website').value, // honeypot
    limit: 50,
  };

  // Lock the form while the request is in flight - prevents a double-tap
  // on a slow connection from firing two searches and burning the rate
  // limit for nothing, and gives clear feedback that something is happening.
  const submitBtn = el('submit-btn');
  const originalLabel = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Searching...';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  const started = performance.now();
  try {
    const res = await fetch(`${API}/search`, {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      el('results').innerHTML = '';
      el('salary-banner').hidden = true;
      el('results-disclaimer').hidden = true;
      el('results-summary').innerHTML = `<span class="error">${data.message || 'Something went wrong.'}</span>`;
      return;
    }
    updateShareUrl(payload);
    lastResults = data.results || [];
    shown = 0;
    el('results').innerHTML = '';
    renderSalaryBanner(data.salaryContext);
    renderResultsDisclaimer(lastResults);
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    if (!lastResults.length) {
      renderZeroResultsGuidance(payload);
      return;
    }
    const freshness = data.dataFreshness ? new Date(data.dataFreshness).toLocaleString('en-GB') : '';
    el('results-summary').textContent =
      `Found ${data.totalMatches} courses in ${secs} seconds. Showing the top ${Math.min(PAGE, lastResults.length)}. Data last updated: ${freshness}.`;
    renderMore();
  } catch (err) {
    el('results').innerHTML = '';
    el('salary-banner').hidden = true;
    el('results-disclaimer').hidden = true;
    if (err.name === 'AbortError') {
      el('results-summary').innerHTML = '<span class="error">This is taking longer than usual. Please try again in a moment.</span>';
    } else {
      el('results-summary').innerHTML = '<span class="error">Could not reach the service. Please try again.</span>';
    }
  } finally {
    clearTimeout(timeoutId);
    submitBtn.textContent = originalLabel;
    validateForm(); // restores disabled state based on current field values, not just re-enabling blindly
  }
}

// ---- Freshness stat (hero banner) ----
// Shows students the ACTUAL most recent automated check across all tracked
// universities, not a raw "N drifts detected" count. A change count is an
// engineering signal (and can be a false positive - see DailyScraper's own
// heuristic caveats); "checked 12 minutes ago" is something a student can
// actually use to judge how current the status badges are, without reading
// it as "something is wrong". Falls back to the static "Hourly" label
// already in the HTML if this fails - never blocks or breaks the page.
async function updateFreshnessStat() {
  try {
    const res = await fetch(`${API}/universities`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const timestamps = (data.universities || [])
      .map((u) => u.lastAutomatedCheck)
      .filter(Boolean)
      .map((t) => new Date(t).getTime())
      .filter((t) => !Number.isNaN(t));
    if (!timestamps.length) return;
    const mostRecent = new Date(Math.max(...timestamps)).toISOString();
    const ago = timeAgo(mostRecent);
    if (ago) el('freshness-value').textContent = `Checked ${ago}`;
  } catch { /* keep the static "Hourly" fallback already in the HTML */ }
}

// Populates the qualifications section's subject datalist once - static
// list, no server round-trip needed (unlike loadSubjects() above, which
// hits /subjects for the different course-interest vocabulary).
function populateQualificationSubjectList() {
  el('qual-subject-list').innerHTML =
    VALID_QUALIFICATION_SUBJECTS.map((s) => `<option value="${s}">`).join('');
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  populateQualificationSubjectList();
  const prefilled = prefillFromUrl();
  if (!prefilled) {
    addAlevelRow();
    addAlevelRow();
  }
  loadSubjects('');
  updateFreshnessStat();
  el('add-alevel').addEventListener('click', () => addAlevelRow());
  el('course-interest').addEventListener('input', (e) => {
    clearTimeout(debounce);
    const q = e.target.value.trim();
    if (q.length >= 2) {
      debounce = setTimeout(() => { loadSubjects(q); renderDidYouMean(q); }, 300);
    } else {
      el('did-you-mean').hidden = true;
    }
  });
  el('search-form').addEventListener('submit', onSubmit);
  el('show-more').addEventListener('click', renderMore);
  validateForm();
});
