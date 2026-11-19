// Team board ranking for one workout on one day (rules from aimuzov/wodlog, MIT): RX ahead of Scaled; for time,
// finished times ascending, then capped results (stored as CAPPED - reps) with more reps first; everything else,
// higher is better; ties share a place; entries without a score go last with no place.
const CAPPED = 100000;
const isCapped = e => e.kind === "for_time" && e.score_value >= CAPPED - 10000;

export function rank(entries) {
  const scored = entries.filter(e => e.score_value != null), unscored = entries.filter(e => e.score_value == null);
  const key = e => [e.rx ? 0 : 1, e.kind === "for_time" ? e.score_value : -e.score_value]; // capped already sorts after times
  scored.sort((a, b) => { const [a1, a2] = key(a), [b1, b2] = key(b); return a1 - b1 || a2 - b2; });
  let place = 0;
  const out = scored.map((e, i) => {
    const prev = scored[i - 1];
    if (!prev || prev.rx !== e.rx || prev.score_value !== e.score_value) place = i + 1;
    return { ...e, place, capped: isCapped(e) };
  });
  return [...out, ...unscored.map(e => ({ ...e, place: null, capped: false }))];
}
