// Maintainable NAME-ONLY catalogue of common generic medicines (prototype, incomplete).
// Deliberately contains no doses or recommendations. Replace with a verified source
// (e.g. a licensed formulary) before real-world use.
export const CATALOGUE_INFO = {
  version: '0.1',
  limitation: 'Prototype catalogue of common generic names only; it is incomplete and is not a treatment recommendation. Names not listed are entered as unverified.'
};
const NAMES = ['Paracetamol', 'Ibuprofen', 'Aspirin', 'Diclofenac', 'Naproxen', 'Amoxicillin', 'Ampicillin', 'Flucloxacillin', 'Co-amoxiclav',
  'Azithromycin', 'Clarithromycin', 'Ciprofloxacin', 'Doxycycline', 'Cefixime', 'Cefuroxime', 'Metronidazole', 'Co-trimoxazole',
  'Sulfamethoxazole', 'Trimethoprim', 'Fluconazole', 'Acyclovir', 'Metformin', 'Glimepiride', 'Amlodipine', 'Losartan', 'Enalapril',
  'Ramipril', 'Atenolol', 'Metoprolol', 'Hydrochlorothiazide', 'Furosemide', 'Atorvastatin', 'Simvastatin', 'Clopidogrel', 'Warfarin',
  'Omeprazole', 'Pantoprazole', 'Domperidone', 'Ondansetron', 'Loperamide', 'Oral Rehydration Salts', 'Cetirizine', 'Loratadine',
  'Montelukast', 'Salbutamol', 'Prednisolone', 'Levothyroxine', 'Gabapentin', 'Sildenafil', 'Isosorbide Mononitrate', 'Methotrexate',
  'Folic Acid', 'Ferrous Sulfate', 'Vitamin D3'];
export const MEDICINES = NAMES.map((name) => ({ name }));
const KNOWN = new Set(NAMES.map((n) => n.toLowerCase()));
export const isKnownMedicine = (n) => KNOWN.has(String(n).trim().toLowerCase());
export function searchMedicines(q, limit = 8) {
  const s = String(q || '').trim().toLowerCase();
  if (s.length < 2) return [];
  const starts = MEDICINES.filter((m) => m.name.toLowerCase().startsWith(s));
  const has = MEDICINES.filter((m) => !m.name.toLowerCase().startsWith(s) && m.name.toLowerCase().includes(s));
  return [...starts, ...has].slice(0, limit);
}
