// Reading EMOM stations out of the board text. Run: node --test checks/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStations } from "../stations.mjs";

test("E2M with a buy-in and a max movement per station", () => {
  const s = parseStations("E2M for 12min\n1: 15 cal bike + max dual leg c&p\n2: + max DB B. step ups\n\n2' Rest");
  assert.deepEqual(s.map(x => [x.label, x.max]), [["1", "dual leg c&p"], ["2", "DB B. step ups"]]);
});

test("alternatives stay one station; trailing punctuation dropped", () => {
  const s = parseStations("E2 For 12'\n1: 200m runner + max deadlifts\n2: max HSW / HSPU.");
  assert.deepEqual(s.map(x => x.max), ["deadlifts", "HSW / HSPU"]);
});

test("stations without a max are kept with max null", () => {
  const s = parseStations("EMOM 10\n1) 10 burpees\n2) max wall balls");
  assert.deepEqual(s.map(x => x.max), [null, "wall balls"]);
});

test("no numbered stations gives an empty list", () => {
  assert.deepEqual(parseStations("EMOM 12: 5 power cleans @ 70%"), []);
});
