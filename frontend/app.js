// UK Clearing Advisor - frontend logic (vanilla JS, no build step).
// Calls the API through the same CloudFront domain under /api/*.
'use strict';

const API = '/api';
const GRADES = ['A*', 'A', 'B', 'C', 'D', 'E'];
const MAX_ALEVELS = 4;

let lastResults = [];
let shown = 0;
const PAGE = 10;

const el = (id) => document.getElementById(id);
const fmtGBP = (n) => '£' + Number(n).toLocaleString('en-GB');

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

function collectAlevels() {
  return Array.from(document.querySelectorAll('.alevel-row')).map((r) => ({
    subject: r.querySelector('.al-subject').value.trim(),
    grade: r.querySelector('.al-grade').value,
  })).filter((s) => s.subject);
}

function validateForm() {
  el('submit-btn').disabled = collectAlevels().length < 2;
}

// ---- Subject autocomplete (debounced) ----
let debounce;
async function loadSubjects(q) {
  try {
    const res = await fetch(`${API}/subjects${q ? `?q=${encodeURIComponent(q)}` : ''}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const list = el('subject-list');
    list.innerHTML = (data.subjects || []).map((s) => `<option value="${s}">`).join('');
  } catch { /* non-fatal */ }
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

  // Only show figures that are verified. Graduate prospects are per-university
  // (CUG 2027) where published; salary is the national median for the subject
  // (HESA), clearly labelled so it is never read as a university-specific wage.
  const stats = [];
  if (c.graduateProspects != null) {
    stats.push(`<div class="stat"><b>${c.graduateProspects}%</b><span>graduate prospects</span></div>`);
  }
  if (c.nationalMedianSalary != null) {
    stats.push(`<div class="stat"><b>${fmtGBP(c.nationalMedianSalary)}</b><span>national median${c.salarySubject ? ' &middot; ' + c.salarySubject : ''}</span></div>`);
  }
  stats.push(`<div class="stat"><b>${c.typicalOffer}</b><span>typical offer</span></div>`);

  const sources = [];
  if (c.nationalMedianSalary != null && c.salarySourceUrl) {
    sources.push(`<a href="${c.salarySourceUrl}" target="_blank" rel="noopener">Salary: HESA Graduate Outcomes ${c.salaryYear || ''}</a>`);
  }
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

function showSkeletons() {
  el('results-section').hidden = false;
  el('results-summary').textContent = 'Searching...';
  el('results').innerHTML = Array(3).fill('<div class="skeleton"></div>').join('');
  el('show-more').hidden = true;
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

  const started = performance.now();
  try {
    const res = await fetch(`${API}/search`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      el('results').innerHTML = '';
      el('results-summary').innerHTML = `<span class="error">${data.message || 'Something went wrong.'}</span>`;
      return;
    }
    lastResults = data.results || [];
    shown = 0;
    el('results').innerHTML = '';
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    if (!lastResults.length) {
      el('results-summary').textContent = 'No matching courses found. Try widening your filters.';
      el('show-more').hidden = true;
      return;
    }
    const freshness = data.dataFreshness ? new Date(data.dataFreshness).toLocaleString('en-GB') : '';
    el('results-summary').textContent =
      `Found ${data.totalMatches} courses in ${secs} seconds. Showing the top ${Math.min(PAGE, lastResults.length)}. Data last updated: ${freshness}.`;
    renderMore();
  } catch (err) {
    el('results').innerHTML = '';
    el('results-summary').innerHTML = '<span class="error">Could not reach the service. Please try again.</span>';
  }
}

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  addAlevelRow();
  addAlevelRow();
  loadSubjects('');
  el('add-alevel').addEventListener('click', () => addAlevelRow());
  el('course-interest').addEventListener('input', (e) => {
    clearTimeout(debounce);
    const q = e.target.value.trim();
    if (q.length >= 2) debounce = setTimeout(() => loadSubjects(q), 300);
  });
  el('search-form').addEventListener('submit', onSubmit);
  el('show-more').addEventListener('click', renderMore);
  validateForm();
});
