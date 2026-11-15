import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSafety } from '../src/safety.js';

test('flags amoxicillin for a penicillin-allergic patient', () => {
  const r = checkSafety([{ name: 'Amoxicillin' }], ['penicillin']);
  assert.equal(r.alerts[0].type, 'allergy');
  assert.equal(r.alerts[0].severity, 'high');
});
test('flags a known interaction pair', () => {
  const r = checkSafety([{ name: 'Warfarin' }, { name: 'aspirin' }], []);
  assert.equal(r.alerts[0].severity, 'major');
});
test('never claims safety when nothing matches, and reports uncovered drugs', () => {
  const r = checkSafety([{ name: 'Paracetamol' }], []);
  assert.equal(r.alerts.length, 0);
  assert.deepEqual(r.notCovered, ['paracetamol']);
  assert.match(r.summary, /NOT confirmation/);
  assert.doesNotMatch(r.summary, /no interaction found/i);
});
