// PROTOTYPE DATASET. Small, hand-curated, widely documented examples.
// Must be reviewed by a clinical pharmacist before any real-world use.
export const DATASET_INFO = {
  name: 'MediCare EHR prototype rule set',
  version: '0.1',
  limitation: 'Limited demonstration dataset. It does NOT detect every interaction or allergy cross-reaction. Alerts support, not replace, clinical judgment.'
};
export const ALLERGY_CLASSES = {
  penicillin: ['penicillin', 'amoxicillin', 'ampicillin', 'flucloxacillin', 'piperacillin', 'co-amoxiclav'],
  sulfonamide: ['sulfamethoxazole', 'co-trimoxazole', 'sulfasalazine'],
  nsaid: ['ibuprofen', 'diclofenac', 'naproxen', 'aspirin']
};
export const INTERACTION_RULES = [
  ['warfarin', 'aspirin', 'major', 'Increased bleeding risk with combined anticoagulant and antiplatelet effect.'],
  ['warfarin', 'ibuprofen', 'major', 'NSAIDs raise bleeding risk in patients taking warfarin.'],
  ['simvastatin', 'clarithromycin', 'major', 'Raised simvastatin levels increase the risk of myopathy.'],
  ['sildenafil', 'isosorbide mononitrate', 'contraindicated', 'Severe hypotension risk with nitrates.'],
  ['methotrexate', 'trimethoprim', 'major', 'Additive antifolate effect can cause bone marrow suppression.'],
  ['aspirin', 'ibuprofen', 'moderate', 'Ibuprofen may reduce the antiplatelet effect of low-dose aspirin.']
];
