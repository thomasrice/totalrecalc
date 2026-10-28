// Small formatting helpers shared by the panels.

import type { Value } from "./types";
import { formatLike } from "./periods";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return clock(ms);
}

/** "+1,522.2 (+2.2%)", "+1.2pp", "blank → 0", or "" when not numeric. */
export function delta(before: Value, after: Value, afterText: string, percentCell: boolean): string {
  if (before === null && after !== null) return "blank → value";
  if (after === null && before !== null) return "cleared";
  if (typeof before !== "number" || typeof after !== "number") return "";
  const d = after - before;
  if (d === 0) return "≈ same value";
  if (percentCell) {
    const pp = d * 100;
    return `${pp > 0 ? "+" : "−"}${Math.abs(pp).toFixed(Math.abs(pp) < 1 ? 2 : 1)}pp`;
  }
  const abs = formatLike(Math.abs(d), [afterText]);
  const sign = d > 0 ? "+" : "−";
  const pct = before !== 0 ? ` (${sign}${Math.abs((d / Math.abs(before)) * 100).toFixed(Math.abs(d / before) < 0.01 ? 2 : 1)}%)` : "";
  return `${sign}${abs.replace(/^[(-]|\)$/g, "")}${pct}`;
}

export function shortValue(v: Value, text: string): string {
  if (v === null || v === "") return "blank";
  return text || String(v);
}
