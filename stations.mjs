// EMOM / E2M stations from the board text: numbered lines ("1: 15 cal bike + max dual leg c&p"), each with the
// movement done for max reps if there is one. Each max station is scored on its own (total reps over its rounds).
export function parseStations(text = "") {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*(\d+)\s*[:).]\s*(.+)$/);
    if (!m) continue;
    const max = (m[2].match(/\bmax\s+(.+)$/i) || [])[1];
    out.push({ label: m[1], work: m[2].trim(), max: max ? max.replace(/[\s.,;]+$/, "").trim() : null });
  }
  return out;
}
