import { ALLERGY_CLASSES, INTERACTION_RULES, DATASET_INFO } from './data/rules.js';

const norm = (s) => String(s || '').trim().toLowerCase();

/** Pure, reusable safety service. Returns alerts plus honest coverage info. */
export function checkSafety(medicines, allergies, rules = INTERACTION_RULES, classes = ALLERGY_CLASSES) {
  const names = medicines.map((m) => norm(m.name)).filter(Boolean);
  const alerts = [];
  const known = new Set();
  for (const r of rules) { known.add(r[0]); known.add(r[1]); }
  for (const list of Object.values(classes)) list.forEach((d) => known.add(d));

  for (const med of names) {
    for (const allergy of allergies.map(norm)) {
      const members = classes[allergy] || [];
      if (med === allergy || members.includes(med)) {
        alerts.push({
          type: 'allergy', severity: 'high', medicines: [med], allergy,
          message: `Recorded ${allergy} allergy conflicts with ${med}` +
            (med === allergy ? '.' : ` (${med} belongs to the ${allergy} group in the rule set).`) +
            ' Clinical review required.'
        });
      }
    }
  }
  for (const [a, b, severity, description] of rules) {
    if (names.includes(a) && names.includes(b)) {
      alerts.push({ type: 'interaction', severity, medicines: [a, b], message: description });
    }
  }
  const notCovered = [...new Set(names.filter((n) => !known.has(n)))];
  return {
    alerts, notCovered,
    dataset: DATASET_INFO,
    // Never claims "no interaction"; only reports rule matches in a limited dataset.
    summary: alerts.length
      ? `${alerts.length} rule match(es) found. Review before finalizing.`
      : 'No rule matches in the prototype dataset. This is NOT confirmation that the combination is safe.'
  };
}
