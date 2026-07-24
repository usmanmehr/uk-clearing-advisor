// UK Clearing Advisor - regression tests for shared.mjs grading logic.
// Uses Node's built-in test runner (node:test) - zero dependencies, matching
// the rest of the project's zero-npm-dependency approach.
//
// Run with: node --test lambda/shared/shared.test.mjs
//
// These specifically guard against two real bugs found and fixed this
// session:
//   1. 2-subject searches always returned zero results regardless of
//      grades, because gradeTotal() summed raw grades without normalising
//      for subject count against 3-subject-calibrated offer thresholds.
//   2. GRADE_VALUES used an arbitrary internal 7-12 scale instead of real
//      UCAS Tariff points, which is what let bug #1 go unnoticed - the
//      thresholds and the grade values had never been checked against a
//      real, external source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// Imported from grading.mjs directly (not shared.mjs) - shared.mjs pulls in
// @aws-sdk/* packages which only exist inside the Lambda runtime and are
// never `npm install`ed in this project, so importing shared.mjs in plain
// CI (GitHub Actions ubuntu-latest, no npm install step) throws
// ERR_MODULE_NOT_FOUND before a single test runs. grading.mjs has zero
// imports so it works everywhere.
import { GRADE_VALUES, gradeTotal } from './grading.mjs';

test('GRADE_VALUES match verified UCAS Tariff points (Pearson, 2025/26 AAQs)', () => {
  assert.equal(GRADE_VALUES['A*'], 56);
  assert.equal(GRADE_VALUES.A, 48);
  assert.equal(GRADE_VALUES.B, 40);
  assert.equal(GRADE_VALUES.C, 32);
  assert.equal(GRADE_VALUES.D, 24);
  assert.equal(GRADE_VALUES.E, 16);
});

test('gradeTotal: 3 subjects returns the plain sum (unchanged behaviour)', () => {
  assert.equal(gradeTotal([{ grade: 'B' }, { grade: 'B' }, { grade: 'B' }]), 120); // BBB
  assert.equal(gradeTotal([{ grade: 'A' }, { grade: 'A' }, { grade: 'B' }]), 136); // AAB
  assert.equal(gradeTotal([{ grade: 'A*' }, { grade: 'A*' }, { grade: 'A*' }]), 168); // A*A*A*
});

test('gradeTotal: only the best 3 grades count when more than 3 are given', () => {
  assert.equal(
    gradeTotal([{ grade: 'E' }, { grade: 'B' }, { grade: 'B' }, { grade: 'B' }]),
    120, // the E is dropped, BBB = 120
  );
});

test('REGRESSION: 2 subjects are normalised to a fair 3-subject-equivalent score', () => {
  // Before the fix: gradeTotal([B,B]) = 80 (plain sum), which could never
  // reach the lowest offer band (BBB = 120) - every 2-subject search
  // silently returned zero results no matter how good the grades were.
  // After the fix: average(40,40) * 3 = 120, matching 3-subject BBB exactly.
  assert.equal(gradeTotal([{ grade: 'B' }, { grade: 'B' }]), 120);
  assert.equal(
    gradeTotal([{ grade: 'B' }, { grade: 'B' }]),
    gradeTotal([{ grade: 'B' }, { grade: 'B' }, { grade: 'B' }]),
    '2 subjects at grade B must score identically to 3 subjects at grade B',
  );
});

test('REGRESSION: two A*s (the maximum possible with 2 subjects) can clear every offer band', () => {
  // Before the fix this was 112 (56+56), which failed to reach BBB (120).
  const twoAStar = gradeTotal([{ grade: 'A*' }, { grade: 'A*' }]);
  assert.equal(twoAStar, 168); // average(56,56) * 3 = 168, same as three A*s
  assert.ok(twoAStar >= 152, 'two A*s must clear the top A*AA threshold (152)');
});

test('gradeTotal: unrecognised or missing grades are ignored, not treated as zero-value subjects', () => {
  assert.equal(gradeTotal([{ grade: 'B' }, { grade: 'B' }, { grade: 'not-a-grade' }]), 120);
  assert.equal(gradeTotal([{ grade: '' }, { grade: 'B' }, { grade: 'B' }]), 120);
});

test('gradeTotal: empty or all-invalid input returns 0, not NaN', () => {
  assert.equal(gradeTotal([]), 0);
  assert.equal(gradeTotal([{ grade: 'X' }, { grade: 'Y' }]), 0);
  assert.equal(gradeTotal(undefined), 0);
});

test('gradeTotal: grade letters are case-insensitive', () => {
  assert.equal(gradeTotal([{ grade: 'b' }, { grade: 'b' }, { grade: 'b' }]), 120);
});
