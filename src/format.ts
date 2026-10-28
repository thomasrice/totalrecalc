// Small formatting helpers shared by the panels.

import type { Value } from "./types";
import { formatLike } from "./periods";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

export function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return clock(ms);
}

/** "+1,522.2 (+2.2%)", "+1.2pp", "blank → value", or "" when not numeric. */
export function delta(before: Value, after: Value, afterText: string, percentCell: boolean): string {
  if (before === null && after !== null) return "blank → value";
  if (after === null && before !== null) return "cleared";
  if (typeof before !== "number" || typeof after !== "number") return "";
  const d = after - before;
  if (d === 0) return "≈ same value";
  if (percentCell) return signedPercent(d * 100, "pp");
  const abs = formatLike(Math.abs(d), [afterText]);
  const sign = d > 0 ? "+" : "−";
  const pct = before !== 0 ? ` (${signedPercent((d / Math.abs(before)) * 100)})` : "";
  return `${sign}${abs.replace(/^[(-]|\)$/g, "")}${pct}`;
}

export function shortValue(v: Value, text: string): string {
  if (v === null || v === "") return "blank";
  return text || String(v);
}

/** "+2.2%", "−0.45pp", "0%": two decimals below one, otherwise one. */
export function signedPercent(p: number, unit = "%"): string {
  if (Math.abs(p) < 0.005) return `0${unit}`;
  return `${p > 0 ? "+" : "−"}${Math.abs(p).toFixed(Math.abs(p) < 1 ? 2 : 1)}${unit}`;
}
