export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
