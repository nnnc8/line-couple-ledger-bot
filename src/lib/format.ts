import { tagColor } from "./categories";

const MONTHS_SHORT = ["", "1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function money(value: number): string {
  return `NT$${new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }).format(Math.round(value))}`;
}

export function moneyAbs(value: number): string {
  return money(Math.abs(value));
}

export function signedMoney(value: number): string {
  if (value > 0) return `+${moneyAbs(value)}`;
  if (value < 0) return `−${moneyAbs(value)}`;
  return money(0);
}

export function shortMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}萬`;
  if (abs >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return value.toLocaleString();
}

export function dateFormat(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAYS[d.getDay()]}）`;
}

export function dateShort(dateStr: string): string {
  return dateStr.slice(5).replace("-", "/");
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${y}年 ${MONTHS_SHORT[Number(m)] ?? m}`;
}

export function monthShort(month: string): string {
  const m = Number(month.slice(5));
  return MONTHS_SHORT[m] ?? month.slice(5);
}

export function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function taipeiToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function donutGradient(
  items: Array<{ tag: string; value: number; color?: string }>,
  total: number,
): string {
  let position = 0;
  const parts = items.map((item) => {
    const start = position;
    position += (item.value / Math.max(1, total)) * 100;
    const color = item.color ?? tagColor(item.tag);
    return `${color} ${start}% ${position}%`;
  });
  return `conic-gradient(${parts.join(",")})`;
}
