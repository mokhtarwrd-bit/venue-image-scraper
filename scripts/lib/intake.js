// =============================================================================
// lib/intake.js — lightweight in-scope intake guard.
//
// The lead-qualification role is NOT built yet (queued R14). Until it exists,
// this does a SIMPLE, honest in-scope check: does the lead read as a
// restaurant / riad / transport tourist agency in Morocco? It NEVER hard-fails
// — it flags out-of-scope and recommends skip, leaving the human the call.
// This is a heuristic, explicitly labelled signal-to-test, not a fit verdict.
// =============================================================================

const MOROCCO_HINTS = [
  'morocco', 'maroc', 'marrakech', 'marrakesh', 'casablanca', 'rabat', 'fes', 'fez',
  'tangier', 'tanger', 'essaouira', 'agadir', 'chefchaouen', 'ouarzazate', 'merzouga',
  'medina', 'gueliz', 'kasbah', 'maghreb',
];

const RESTAURANT_HINTS = ['restaurant', 'cuisine', 'cafe', 'café', 'bistro', 'food', 'tagine', 'tajine', 'rooftop', 'dining', 'menu'];
const RIAD_HINTS = ['riad', 'guesthouse', 'guest house', 'maison d', 'hotel', 'hôtel', 'boutique hotel', 'courtyard', 'hammam', 'stay'];
const TRANSPORT_HINTS = ['transport', 'transfer', 'excursion', 'tour', 'tours', '4x4', 'desert tour', 'agency', 'travel agency', 'minibus', 'private driver', 'day trip'];

function scoreHints(text, hints) {
  let n = 0;
  for (const h of hints) if (text.includes(h)) n++;
  return n;
}

// Classify from whatever text signal we have (name + city + listing category +
// any blurb). Returns { inScope, category, morocco, confidence, why }.
export function classifyLead({ name = '', city = '', listingCategory = '', blurb = '' } = {}) {
  const text = `${name} ${city} ${listingCategory} ${blurb}`.toLowerCase();

  const morocco = scoreHints(text, MOROCCO_HINTS) > 0;
  const scores = {
    restaurant: scoreHints(text, RESTAURANT_HINTS),
    riad: scoreHints(text, RIAD_HINTS),
    transport_agency: scoreHints(text, TRANSPORT_HINTS),
  };
  let category = null, best = 0;
  for (const [cat, sc] of Object.entries(scores)) {
    if (sc > best) { best = sc; category = cat; }
  }

  // In scope = (Morocco signal OR no strong out-of-place signal) AND a category hit.
  const inScope = !!category && best > 0;
  // Confidence is intentionally modest — this is a keyword heuristic, not a model.
  let confidence = 0;
  if (inScope) confidence += 0.4;
  if (morocco) confidence += 0.3;
  if (best >= 2) confidence += 0.2;
  confidence = Math.min(confidence, 0.9);

  const why = inScope
    ? `matched ${category} signals (score ${best})${morocco ? ', Morocco signal present' : ', no explicit Morocco signal in provided text'}`
    : `no clear restaurant/riad/transport signal in "${text.trim().slice(0, 80)}"`;

  return { inScope, category, morocco, confidence: Number(confidence.toFixed(2)), why, scores };
}
