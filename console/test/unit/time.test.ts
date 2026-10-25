import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../server/src/queries/changes.js";
import { addDays, dateIn, isDate, wilson } from "../../server/src/time.js";

describe("dates", () => {
  it("reads the calendar date in a time zone", () => {
    const at = new Date("2026-10-25T22:30:00Z");
    expect(dateIn("UTC", at)).toBe("2026-10-25");
    expect(dateIn("Europe/Paris", at)).toBe("2026-10-25");
    expect(dateIn("Asia/Tokyo", at)).toBe("2026-10-26");
  });

  it("validates and steps dates", () => {
    expect(isDate("2026-02-29")).toBe(false);
    expect(isDate("2028-02-29")).toBe(true);
    expect(isDate("2026-10-25T00")).toBe(false);
    expect(addDays("2026-10-25", -25)).toBe("2026-09-30");
  });
});

describe("wilson", () => {
  it("has no interval without votes and brackets the share", () => {
    expect(wilson(0, 0)).toBeNull();
    const w = wilson(9, 10);
    expect(w?.low).toBeCloseTo(0.596, 2);
    expect(w?.high).toBeCloseTo(0.982, 2);
    expect(wilson(10, 10)?.high).toBeCloseTo(1, 10);
  });
});

describe("register cursor", () => {
  it("round-trips and rejects junk", () => {
    const at = new Date("2026-10-25T10:00:00Z");
    const id = "6b1f0b2e-5a5e-4c7e-9f8a-0d1e2f3a4b5c";
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ openedAt: at, id });
    expect(decodeCursor("bm9wZQ")).toBeNull();
    expect(
      decodeCursor(Buffer.from("2026-10-25T10:00:00Z|x;drop").toString("base64url")),
    ).toBeNull();
  });
});
