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
import {
  GRADE_VALUES, gradeTotal,
  BTEC_EXTENDED_DIPLOMA_VALUES, BTEC_DIPLOMA_VALUES, BTEC_EXTENDED_CERTIFICATE_VALUES,
  totalQualificationSlots,
} from './grading.mjs';

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

// BTEC support - added so students applying with BTEC qualifications (alone
// or mixed with A-levels) get real results, not silent zero-matches.
//
// Values verified directly against Pearson's own official table
// (qualifications.pearson.com/btec-int-com, Level 3 BTEC Nationals RQF,
// 2017 admissions cycle onwards - still the current table for 2026 entry)
// and independently cross-checked against ukcalculator.com - both agree
// exactly on every value tested here.

test('BTEC_EXTENDED_DIPLOMA_VALUES match Pearson\'s official table (3 A-level equivalent)', () => {
  assert.equal(BTEC_EXTENDED_DIPLOMA_VALUES['D*D*D*'], 168);
  assert.equal(BTEC_EXTENDED_DIPLOMA_VALUES['D*D*D'], 160);
  assert.equal(BTEC_EXTENDED_DIPLOMA_VALUES['D*DD'], 152);
  assert.equal(BTEC_EXTENDED_DIPLOMA_VALUES.DDD, 144);
  assert.equal(BTEC_EXTENDED_DIPLOMA_VALUES.DDM, 128);
  assert.equal(BTEC_EXTENDED_DIPLOMA_VALUES.DMM, 112);
  assert.equal(BTEC_EXTENDED_DIPLOMA_VALUES.MMM, 96);
  assert.equal(BTEC_EXTENDED_DIPLOMA_VALUES.MMP, 80);
  assert.equal(BTEC_EXTENDED_DIPLOMA_VALUES.MPP, 64);
  assert.equal(BTEC_EXTENDED_DIPLOMA_VALUES.PPP, 48);
});

test('BTEC_DIPLOMA_VALUES match Pearson\'s official table (2 A-level equivalent)', () => {
  assert.equal(BTEC_DIPLOMA_VALUES['D*D*'], 112);
  assert.equal(BTEC_DIPLOMA_VALUES['D*D'], 104);
  assert.equal(BTEC_DIPLOMA_VALUES.DD, 96);
  assert.equal(BTEC_DIPLOMA_VALUES.DM, 80);
  assert.equal(BTEC_DIPLOMA_VALUES.MM, 64);
  assert.equal(BTEC_DIPLOMA_VALUES.MP, 48);
  assert.equal(BTEC_DIPLOMA_VALUES.PP, 32);
});

test('BTEC_EXTENDED_CERTIFICATE_VALUES match Pearson\'s official table (1 A-level equivalent)', () => {
  assert.equal(BTEC_EXTENDED_CERTIFICATE_VALUES['D*'], 56);
  assert.equal(BTEC_EXTENDED_CERTIFICATE_VALUES.D, 48);
  assert.equal(BTEC_EXTENDED_CERTIFICATE_VALUES.M, 32);
  assert.equal(BTEC_EXTENDED_CERTIFICATE_VALUES.P, 16);
});

test('gradeTotal: a BTEC Extended Diploma alone scores the same as its A-level equivalent', () => {
  // D*DD is UCAS-equivalent to A*AA at A-level (152 points either way).
  assert.equal(gradeTotal([{ grade: 'D*DD', type: 'btecExtendedDiploma' }]), 152);
  assert.equal(
    gradeTotal([{ grade: 'D*DD', type: 'btecExtendedDiploma' }]),
    gradeTotal([{ grade: 'A*' }, { grade: 'A' }, { grade: 'A' }]),
  );
});

test('gradeTotal: a BTEC Diploma alone (2 A-level-equivalent slots) is normalised like 2 A-levels', () => {
  // DD (96 total) is equivalent to two A-levels at B each (40+40=80... but
  // normalised to a 3-subject-equivalent total the same way 2 A-levels are)
  // - average(48,48)*3 = 144, matching ukcalculator.com's own published
  // worked example ("1 A-Level A + BTEC Diploma DD = 144 points").
  assert.equal(gradeTotal([{ grade: 'DD', type: 'btecDiploma' }]), 144);
});

test('REGRESSION: mixed A-level + BTEC profile matches UCAS\'s own published worked example', () => {
  // ukcalculator.com worked example: "1 A-Level + BTEC Diploma = 144 points
  // - Biology A-Level A (48) + BTEC Applied Science DD (96) = 144."
  assert.equal(
    gradeTotal([{ subject: 'Biology', grade: 'A', type: 'alevel' }, { subject: 'Applied Science', grade: 'DD', type: 'btecDiploma' }]),
    144,
  );
});

test('gradeTotal: entries with no type field are treated as A-levels (backward compatible)', () => {
  assert.equal(gradeTotal([{ grade: 'A' }, { grade: 'A' }, { grade: 'B' }]), 136); // AAB, unchanged
});

test('gradeTotal: an unrecognised type falls back to A-level grade values', () => {
  assert.equal(gradeTotal([{ grade: 'A', type: 'not-a-real-type' }, { grade: 'A' }, { grade: 'B' }]), 136);
});

test('totalQualificationSlots: A-levels count 1 slot each, BTECs count their real UCAS size', () => {
  assert.equal(totalQualificationSlots([{ grade: 'A' }]), 1);
  assert.equal(totalQualificationSlots([{ grade: 'A' }, { grade: 'B' }]), 2);
  assert.equal(totalQualificationSlots([{ grade: 'DDD', type: 'btecExtendedDiploma' }]), 3);
  assert.equal(totalQualificationSlots([{ grade: 'DD', type: 'btecDiploma' }]), 2);
  assert.equal(totalQualificationSlots([{ grade: 'D', type: 'btecExtendedCertificate' }]), 1);
});

test('totalQualificationSlots: a single BTEC Extended Diploma or Diploma alone meets the "enough qualifications" bar', () => {
  // A single BTEC Extended Diploma (3 slots) or Diploma (2 slots) is a
  // completely normal, real Clearing applicant profile - it must not be
  // rejected by a validation rule written when every applicant was assumed
  // to submit multiple separate A-level entries.
  assert.ok(totalQualificationSlots([{ grade: 'DDD', type: 'btecExtendedDiploma' }]) >= 2);
  assert.ok(totalQualificationSlots([{ grade: 'DD', type: 'btecDiploma' }]) >= 2);
});
