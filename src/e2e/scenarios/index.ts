import { b1 } from "./b1.js";
import { b2 } from "./b2.js";
import type { ScenarioDef } from "./common.js";
import { s01 } from "./s01.js";
import { s02 } from "./s02.js";
import { s03 } from "./s03.js";
import { s04 } from "./s04.js";
import { s05 } from "./s05.js";
import { s06 } from "./s06.js";
import { s07 } from "./s07.js";
import { s08 } from "./s08.js";
import { s09 } from "./s09.js";
import { s10 } from "./s10.js";

/** Fixed order: s01..s10, b1, then b2 on request. */
export const SCENARIOS: readonly ScenarioDef[] = [
  s01,
  s02,
  s03,
  s04,
  s05,
  s06,
  s07,
  s08,
  s09,
  s10,
  b1,
  b2,
];

export const SCENARIO_IDS: readonly string[] = SCENARIOS.map((s) => s.id);

export function scenarioById(id: string): ScenarioDef {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario ${id}`);
  return s;
}

/**
 * The scenarios to run, in order: the selection plus its `needs` transitively (D19). With no
 * selection, s01..s10 and b1 (b2 only when `withB2`).
 */
export function selectScenarios(selected: readonly string[], withB2: boolean): ScenarioDef[] {
  const wanted = new Set<string>();
  const add = (id: string) => {
    if (wanted.has(id)) return;
    wanted.add(id);
    for (const n of scenarioById(id).needs) add(n);
  };
  if (selected.length === 0) {
    for (const s of SCENARIOS) if (s.id !== "b2") add(s.id);
  } else {
    for (const id of selected) add(id);
  }
  if (withB2) add("b2");
  return SCENARIOS.filter((s) => wanted.has(s.id));
}
