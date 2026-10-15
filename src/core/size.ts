/** Size buckets by changed lines (the step 4 thresholds), shared by eval sampling and the baseline. */
export type SizeBucket = "S" | "M" | "L" | "XL";

export function sizeBucket(changedLines: number): SizeBucket {
  if (changedLines <= 50) return "S";
  if (changedLines <= 300) return "M";
  if (changedLines <= 1500) return "L";
  return "XL";
}
