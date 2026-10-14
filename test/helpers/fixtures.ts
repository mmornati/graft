import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("../fixtures/webhooks/", import.meta.url);

export interface Fixture {
  event: string;
  payload: Record<string, unknown>;
  /** The exact string to sign. */
  body: string;
}

/** `loadFixture("installation.created")` → event "installation". Name = filename without .json. */
export function loadFixture(name: string): Fixture {
  const body = readFileSync(new URL(`${name}.json`, DIR), "utf8");
  const event = name.split(".")[0] as string;
  return { event, payload: JSON.parse(body) as Record<string, unknown>, body };
}

export function fixtureNames(): string[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}
