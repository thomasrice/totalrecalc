// Workbook colours on screen. In the light theme they are exactly as the file
// defines them. In the dark theme a fill and its text are mapped together, so
// a dark header fill with white text stays solid and legible, and light
// fills become tints.

export type Theme = "light" | "dark";

type Rgb = [number, number, number];

const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const toHex = (c: Rgb) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const luminance = ([r, g, b]: Rgb) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function hsl([r, g, b]: Rgb): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

const DARK_SURFACE: Rgb = [20, 23, 28];
const DARK_TEXT = "#e6e8eb";

const cache = new Map<string, { fill?: string; text?: string }>();

export function workbookColors(theme: Theme, fill: string | undefined, text: string | undefined): { fill?: string; text?: string } {
  if (theme === "light") return { fill, text };
  const key = `${fill}|${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let outFill: string | undefined;
  let outText: string | undefined;
  const fillRgb = fill ? hex(fill) : null;
  const textRgb = text ? hex(text) : null;
  const strongFill = fillRgb !== null && luminance(fillRgb) < 0.45;
  if (fillRgb && strongFill) {
    // A dark fill (section headers): keep it solid, a touch deeper.
    const [h, s, l] = hsl(fillRgb);
    outFill = toHex(fromHsl(h, s * 0.85, Math.max(0.12, l * 0.8)));
    outText = textRgb ? toHex(textRgb) : DARK_TEXT;
  } else {
    if (fillRgb && luminance(fillRgb) < 0.97) {
      const [h, s] = hsl(fillRgb);
      // Yellow input fills become a muted olive so they never look like the change colour.
      const yellow = h >= 40 && h <= 70 && s > 0.4;
      const tint = yellow ? fromHsl(65, 0.25, 0.22) : fromHsl(h, Math.min(0.45, s), 0.2);
      outFill = toHex(tint.map((v, i) => v * 0.85 + DARK_SURFACE[i] * 0.15) as Rgb);
    }
    if (textRgb) {
      const lum = luminance(textRgb);
      const [h, s] = hsl(textRgb);
      if (s < 0.15) outText = lum < 0.5 ? DARK_TEXT : toHex(textRgb);
      else outText = toHex(fromHsl(h, Math.min(0.9, s), Math.max(0.68, hsl(textRgb)[2])));
    }
  }
  const out = { fill: outFill, text: outText };
  cache.set(key, out);
  return out;
}
