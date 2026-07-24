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

// Sum of the best three A-level grades, normalised to a 3-subject-equivalent
// score. Offer thresholds (see indicativeGrade/offerBand in SearchCourses)
// are calibrated against three A-levels (e.g. BBB = 120 points). The form
// allows submitting with as few as 2 A-levels (a real, common case), but a
// plain sum of only 2 grades can never reach a 3-subject threshold - even
// two A*s (112) falls short of the lowest offer band (BBB = 120). That
// meant every 2-subject search silently returned zero results regardless
// of grades.
// FIX: average the best up to 3 grades, then scale to a 3-subject total, so
// 2 subjects are compared fairly against 3-subject offer bands rather than
// being mathematically incapable of qualifying for anything. For 3 or more
// subjects the result is unchanged (average of top 3 * 3 = sum of top 3).
export function gradeTotal(subjects) {
  const values = (subjects || [])
    .map((s) => GRADE_VALUES[(s.grade || '').toUpperCase()] || 0)
    .filter((v) => v > 0)
    .sort((a, b) => b - a)
    .slice(0, 3);
  if (!values.length) return 0;
  const average = values.reduce((a, b) => a + b, 0) / values.length;
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
