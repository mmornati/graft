import { TIME_ZONE } from "./api.js";

const nf = new Intl.NumberFormat("en-US");
export const num = (n: number) => nf.format(n);
export const usd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(n);
export const pct = (x: number) => `${Math.round(x * 100)}%`;

const time = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const dayMonth = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
});
const stamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export const hhmm = (iso: string) => time.format(new Date(iso));
export const dm = (iso: string) => dayMonth.format(new Date(iso));
export const when = (iso: string) => stamp.format(new Date(iso));

/** A local date `YYYY-MM-DD` read as a calendar date (no time zone shift). */
const civil = (date: string) => new Date(`${date}T12:00:00Z`);
export const weekday = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(civil(date));
export const weekdayShort = (date: string) =>
  new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(civil(date));
export const longDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(civil(date));
export const dayOfMonth = (date: string) => String(Number(date.slice(8, 10)));

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${num(n)} ${n === 1 ? one : many}`;
export const words = (s: string) => s.replaceAll("_", " ");
export const shortRepo = (full: string) => full.split("/")[1] ?? full;
