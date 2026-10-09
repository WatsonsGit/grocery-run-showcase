/** Money + date helpers. Amounts arrive as Drizzle NUMERIC strings. */

export function money(
  value: string | number,
  opts: { sign?: boolean; cents?: boolean } = {},
): string {
  const n = typeof value === "string" ? parseFloat(value) : value;
  const { sign = false, cents = true } = opts;
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
  const prefix = n < 0 ? "-$" : sign ? "+$" : "$";
  return `${prefix}${abs}`;
}

/** "2026-05-18" -> "05/18/26" */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y.slice(2)}`;
}

/** "2026-05-22" -> "May 22" */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthDay(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${MONTHS[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

export function isInflow(amount: string): boolean {
  return parseFloat(amount) > 0;
}

/** 1 -> "1st", 2 -> "2nd", 22 -> "22nd", 28 -> "28th" */
export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
