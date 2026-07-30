// UK Clearing Advisor - pure grading/subject-matching logic.
// Deliberately has ZERO imports (no AWS SDK, no I/O) so it can be unit
// tested with Node's built-in test runner in plain CI (GitHub Actions'
// ubuntu-latest has no Lambda runtime to provide the @aws-sdk/* packages
// that shared.mjs relies on - see shared.mjs for why those are import-only,
// never installed via npm, in this project). Splitting this out means
// shared.test.mjs never has to pull in the AWS SDK imports just to test
// gradeTotal()/GRADE_VALUES.
//
// shared.mjs re-exports everything from this file, so no other Lambda's
// imports need to change.

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

// Real UCAS Tariff points for A-level, verified directly against Pearson's
// official BTEC/A-level tariff table (qualifications.pearson.com, BTEC and
// A Level UCAS points, 2025/26 AAQs) and cross-checked against two
// independent sources (studentbeans.com, ukcalculator.com) - all three
// agree exactly. Replaces the previous arbitrary internal 7-12 scale with
// the real published Tariff points.
export const GRADE_VALUES = { 'A*': 56, A: 48, B: 40, C: 32, D: 24, E: 16 };

// BTEC National combined-grade UCAS Tariff points, verified against THREE
// independent sources, all agreeing exactly:
//   1. Pearson's own official table (qualifications.pearson.com/btec-int-
//      com, "BTEC and A Level UCAS points", Level 3 BTEC Nationals RQF -
//      2017 admissions cycle onwards, still the current table for 2026
//      entry).
//   2. ukcalculator.com's independently published 2026 tariff calculator.
//   3. Oxford Brookes University's own official admissions pages
//      (brookes.ac.uk/.../ucas-tariff/achieving-112-points and
//      achieving-128-points), which state "BTEC Extended Diploma - Grades
//      DMM" under their 112-points page and "...Grades DDM" under their
//      128-points page - independently confirming DMM=112 and DDM=128.
//
// NOTE on a discrepancy investigated and deliberately NOT incorporated:
// those same Brookes pages also list mixed "1 A-level plus BTEC Diploma"
// example combinations (e.g. "Grades B+DM" for their 112-points page,
// "Grades A+DD" for their 128-points page) that do NOT arithmetically sum
// to 112/128 using this table's values, and are not even self-consistent
// with each other (one implies BTEC Diploma grade DD=88, the other implies
// DD=80 - impossible for a single official value). Every PURE A-level
// example on both of those same pages (e.g. "BBC"=112, "ABB"=128) checks
// out exactly against GRADE_VALUES above. This strongly indicates those
// specific mixed-qualification bullet points are simplified/illustrative
// marketing copy on a general admissions page rather than precise Tariff
// arithmetic (common on university sites, which are written for
// prospective students, not as a calculator) - not evidence that the
// BTEC_DIPLOMA_VALUES table below is wrong. Kept here as a documented,
// deliberate decision rather than silently ignored, since three
// independent, mutually-consistent sources (including this same page's
// own Extended Diploma examples) outweigh one internally-inconsistent
// secondary source.
//
// A student's overall BTEC grade is reported as ONE combined string across
// the whole qualification (e.g. "DDM"), not as a separate grade per
// A-level-equivalent slot the way an A-level student reports one grade per
// subject - so these tables are keyed by the combined grade string, not a
// single letter. Only the standard combinations Pearson actually publishes
// points for are listed (grades are never scrambled out of descending
// order in practice, since they come from the qualification's own grading
// algorithm) - the frontend's dropdown is restricted to exactly these.
//
// Cross-check: every combined value here equals the sum of its individual
// components at D*=56, D=48, M=32, P=16 (e.g. DDM = 48+48+32 = 128,
// matching the table) - i.e. each qualification size is a uniform sum of
// the same per-component values used for the single Extended Certificate,
// which is what makes the slot-based averaging in gradeTotal() below
// mathematically consistent with plain A-levels rather than an
// approximation. This is verified exhaustively, not just asserted, by
// shared.test.mjs's "COMPONENT SUM VERIFICATION" tests below.
export const BTEC_EXTENDED_DIPLOMA_VALUES = {
  'D*D*D*': 168, 'D*D*D': 160, 'D*DD': 152, DDD: 144, DDM: 128,
  DMM: 112, MMM: 96, MMP: 80, MPP: 64, PPP: 48,
};
export const BTEC_DIPLOMA_VALUES = {
  'D*D*': 112, 'D*D': 104, DD: 96, DM: 80, MM: 64, MP: 48, PP: 32,
};
export const BTEC_EXTENDED_CERTIFICATE_VALUES = {
  'D*': 56, D: 48, M: 32, P: 16,
};

// Qualification-type registry. `slots` is how many A-level-equivalent
// places this qualification counts as (a BTEC Extended Diploma is sized
// as three A-levels, a Diploma as two, an Extended Certificate as one -
// per Pearson's own sizing) - used to fairly compare qualifications of
// different sizes against the same 3-subject offer bands in gradeTotal().
// `type` on a submitted subject/qualification entry looks this up; an
// entry with no `type` (or an unrecognised one) defaults to 'alevel' so
// every existing A-level-only request keeps working unchanged.
export const QUALIFICATION_TYPES = {
  alevel: { label: 'A-level', slots: 1, grades: GRADE_VALUES },
  btecExtendedDiploma: { label: 'BTEC Extended Diploma', slots: 3, grades: BTEC_EXTENDED_DIPLOMA_VALUES },
  btecDiploma: { label: 'BTEC Diploma', slots: 2, grades: BTEC_DIPLOMA_VALUES },
  btecExtendedCertificate: { label: 'BTEC Extended Certificate', slots: 1, grades: BTEC_EXTENDED_CERTIFICATE_VALUES },
};

function qualificationType(entry) {
  return QUALIFICATION_TYPES[entry && entry.type] || QUALIFICATION_TYPES.alevel;
}

// Total A-level-equivalent slots represented by a list of qualification
// entries, regardless of whether each entry's grade is recognised - used
// for the "enough qualifications entered" validation in SearchCourses
// (replacing the old fixed "at least 2 A-levels" rule, since a single BTEC
// Diploma or Extended Diploma alone is already worth 2 or 3 A-level
// slots and is a completely normal, real Clearing applicant profile).
export function totalQualificationSlots(subjects) {
  return (subjects || []).reduce((sum, s) => sum + qualificationType(s).slots, 0);
}

// Sum of the best three A-level-equivalent grades, normalised to a
// 3-subject-equivalent score. Offer thresholds (see indicativeGrade/
// offerBand in SearchCourses) are calibrated against three A-levels (e.g.
// BBB = 120 points).
//
// Each entry contributes its total Tariff points divided evenly across its
// own `slots` (e.g. a BTEC Extended Diploma's total points / 3), producing
// that many equal-value "slots" - so a 3-slot BTEC Extended Diploma
// contributes up to 3 slots to the pool on its own, same as three separate
// A-levels would, and a mixed A-level + BTEC profile is pooled fairly
// rather than needing separate code paths. This is exact, not an
// approximation, for every real BTEC combined grade (see the cross-check
// note above the BTEC tables) and reduces to the original plain-A-level
// behaviour unchanged when every entry is an A-level (slots=1 each).
//
// The form allows submitting with as few as 2 A-level-equivalent slots
// total (a real, common case - two A-levels, or a single small BTEC), but
// a plain sum of only 2 slots can never reach a 3-subject threshold - even
// two A*s (112) falls short of the lowest offer band (BBB = 120). That
// would mean every 2-slot search silently returned zero results regardless
// of grades.
// FIX: average the best up to 3 slots, then scale to a 3-subject total, so
// fewer than 3 slots are compared fairly against 3-subject offer bands
// rather than being mathematically incapable of qualifying for anything.
// For 3 or more slots the result is unchanged (average of top 3 * 3 = sum
// of top 3).
export function gradeTotal(subjects) {
  const values = [];
  for (const s of subjects || []) {
    const qtype = qualificationType(s);
    const total = qtype.grades[(s.grade || '').toUpperCase()] || 0;
    if (total <= 0) continue;
    const perSlot = total / qtype.slots;
    for (let i = 0; i < qtype.slots; i++) values.push(perSlot);
  }
  values.sort((a, b) => b - a);
  const top = values.slice(0, 3);
  if (!top.length) return 0;
  const average = top.reduce((a, b) => a + b, 0) / top.length;
  return Math.round(average * 3);
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
