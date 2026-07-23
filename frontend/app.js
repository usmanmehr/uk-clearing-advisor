// UK Clearing Advisor - frontend logic (vanilla JS, no build step).
// Calls the API through the same CloudFront domain under /api/*.
'use strict';

const API = '/api';
const GRADES = ['A*', 'A', 'B', 'C', 'D', 'E'];
const MAX_ALEVELS = 4;
const SEARCH_TIMEOUT_MS = 12000;

let lastResults = [];
let shown = 0;
let subjectNames = []; // full subject list, loaded once, used for "did you mean"
const PAGE = 10;

const el = (id) => document.getElementById(id);
const fmtGBP = (n) => '£' + Number(n).toLocaleString('en-GB');

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

// ---- A-level rows ----
function addAlevelRow(subject = '', grade = 'A') {
  const rows = el('alevels');
  if (rows.children.length >= MAX_ALEVELS) return;
  const row = document.createElement('div');
  row.className = 'alevel-row';
  const idx = rows.children.length;
  row.innerHTML =
    `<div class="field" style="margin:0">
       <label for="subj-${idx}">Subject</label>
       <input type="text" id="subj-${idx}" class="al-subject" list="subject-list" value="${subject}" autocomplete="off">
     </div>
     <div class="field" style="margin:0">
       <label for="grade-${idx}">Grade</label>
       <select id="grade-${idx}" class="al-grade">
         ${GRADES.map((g) => `<option ${g === grade ? 'selected' : ''}>${g}</option>`).join('')}
       </select>
     </div>
     <button type="button" class="remove" aria-label="Remove this A-level">Remove</button>`;
  row.querySelector('.remove').addEventListener('click', () => { row.remove(); validateForm(); });
  row.querySelectorAll('input,select').forEach((i) => i.addEventListener('input', validateForm));
  rows.appendChild(row);
  validateForm();
}

function clearAlevelRows() {
  el('alevels').innerHTML = '';
}

function collectAlevels() {
  return Array.from(document.querySelectorAll('.alevel-row')).map((r) => ({
    subject: r.querySelector('.al-subject').value.trim(),
    grade: r.querySelector('.al-grade').value,
  })).filter((s) => s.subject);
}

function validateForm() {
  el('submit-btn').disabled = collectAlevels().length < 2;
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
  const page = c.clearingPage
    ? `<a href="https://${c.clearingPage.replace(/^https?:\/\//, '')}" target="_blank" rel="noopener">Clearing page</a>` : '';
  const warn = c.subjectWarning ? `<div class="warn">${c.subjectWarning}</div>` : '';
  const est = c.estimatedData ? ' <span class="badge Amber">Indicative offer</span>' : '';
  // Set by the daily automated check when this university's clearing page
  // may have changed since it was last confirmed - advisory, not definitive
  // (see statusNote for the full caveat). Shown as its own line so it's not
  // missed alongside the other status badges.
  const driftWarn = c.possibleStatusChange
    ? '<div class="warn">Automated check flagged a possible change to this page - status above may be out of date. Confirm directly.</div>'
    : '';

  // Only show figures that are verified. Graduate prospects are per-university
  // (CUG 2027) where published and DO vary by university, so they stay on
  // each card. Salary is a national subject median (identical for every
  // university in this search) so it is shown once above the results list
  // instead - see renderSalaryBanner.
  const stats = [];
  if (c.graduateProspects != null) {
    stats.push(`<div class="stat"><b>${c.graduateProspects}%</b><span>graduate prospects</span></div>`);
  }
  stats.push(`<div class="stat"><b>${c.typicalOffer}</b><span>typical offer</span></div>`);

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
    ${sourceLine}
    ${warn}
    ${driftWarn}
    ${c.statusNote ? `<div class="note-line">${c.statusNote}</div>` : ''}
    <div class="contact">Clearing: ${phone} ${page ? '&middot; ' + page : ''}
      ${c.hotlineOpens ? `<br>Hotline: ${c.hotlineOpens}` : ''}</div>
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

function showSkeletons() {
  el('results-section').hidden = false;
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
  for (const s of payload.subjects) params.append('a', `${s.subject}:${s.grade}`);
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
    const [subject, grade] = pair.split(':');
    if (subject) addAlevelRow(decodeURIComponent(subject), GRADES.includes(grade) ? grade : 'A');
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
  if (subjects.length < 2) return;
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
      el('results-summary').innerHTML = `<span class="error">${data.message || 'Something went wrong.'}</span>`;
      return;
    }
    updateShareUrl(payload);
    lastResults = data.results || [];
    shown = 0;
    el('results').innerHTML = '';
    renderSalaryBanner(data.salaryContext);
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

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  const prefilled = prefillFromUrl();
  if (!prefilled) {
    addAlevelRow();
    addAlevelRow();
  }
  loadSubjects('');
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
