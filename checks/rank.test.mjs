// Team board ranking. Run: node --test checks/
import { test } from "node:test";
import assert from "node:assert/strict";
import { rank } from "../rank.mjs";

const CAPPED = 100000;
const ft = (owner_name, score_value, rx = true) => ({ kind: "for_time", owner_name, score_value, rx });

test("RX first, finishers by time, capped after finishers with more reps first", () => {
  const out = rank([ft("Luke", 470, false), ft("Sam", CAPPED - 140), ft("Paul", 522), ft("Ana", CAPPED - 150), ft("Maria", 555)]);
  assert.deepEqual(out.map(e => e.owner_name), ["Paul", "Maria", "Ana", "Sam", "Luke"]);
  assert.deepEqual(out.map(e => e.place), [1, 2, 3, 4, 5]);
});

test("ties share a place and the next place skips", () => {
  const out = rank([ft("A", 522), ft("B", 522), ft("C", 600)]);
  assert.deepEqual(out.map(e => e.place), [1, 1, 3]);
});

test("lifts: heavier first", () => {
  const out = rank([{ kind: "strength", owner_name: "A", score_value: 95, rx: true }, { kind: "strength", owner_name: "B", score_value: 100, rx: true }]);
  assert.deepEqual(out.map(e => e.owner_name), ["B", "A"]);
});

test("entries without a score go last, unplaced", () => {
  const out = rank([ft("A", null), ft("B", 500)]);
  assert.deepEqual(out.map(e => [e.owner_name, e.place]), [["B", 1], ["A", null]]);
});
