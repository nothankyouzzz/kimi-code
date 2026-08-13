/**
 * Math rendering hooks for the markdown theme.
 *
 * Display math ($$...$$) goes TeX → MathJax SVG → resvg PNG and is drawn
 * as an inline image on terminals that speak the Kitty or iTerm2
 * graphics protocol. Inline math ($...$) gets a best-effort Unicode
 * approximation instead of an image so it can flow inside a text line.
 *
 * Every path degrades to `undefined` — unsupported terminal, missing
 * rasterizer, TeX parse error, unmapped construct — so the markdown
 * renderer falls back to showing the raw LaTeX source.
 */

import { createRequire } from 'node:module';

import {
  getCapabilities,
  getCellDimensions,
  Image,
  type ImageTheme,
} from '@moonshot-ai/pi-tui';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html';
import { TeX } from 'mathjax-full/js/input/tex';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages';
import { mathjax } from 'mathjax-full/js/mathjax';
import { SVG } from 'mathjax-full/js/output/svg';
import type { MmlNode } from 'mathjax-full/js/core/MmlTree/MmlNode';

import { loadNativePackage } from '#/native/native-require';
import { currentTheme } from '#/tui/theme';

declare const __KIMI_CODE_NATIVE_BUNDLE__: boolean | undefined;

// ---------------------------------------------------------------------------
// resvg (native) — same loading pattern as the clipboard binding: the SEA
// binary resolves it from the native asset tree, dev falls back to
// node_modules. Never statically imported: it must stay out of main.cjs.
// ---------------------------------------------------------------------------

type ResvgModule = typeof import('@resvg/resvg-js');

const nodeRequire = createRequire(import.meta.url);
const isNativeBundle =
  typeof __KIMI_CODE_NATIVE_BUNDLE__ === 'boolean' && __KIMI_CODE_NATIVE_BUNDLE__;

let resvgModule: ResvgModule | null | undefined;

function getResvg(): ResvgModule | null {
  if (resvgModule !== undefined) return resvgModule;
  try {
    const bundled = loadNativePackage<ResvgModule>('@resvg/resvg-js');
    if (bundled !== null) {
      resvgModule = bundled;
      return bundled;
    }
  } catch {
    resvgModule = null;
    return null;
  }
  if (isNativeBundle) {
    resvgModule = null;
    return null;
  }
  try {
    resvgModule = nodeRequire('@resvg/resvg-js') as ResvgModule;
  } catch {
    resvgModule = null;
  }
  return resvgModule;
}

// ---------------------------------------------------------------------------
// MathJax — pure JS, statically bundled. Document construction is deferred
// to the first formula so sessions without math don't pay the init cost.
// ---------------------------------------------------------------------------

interface MathContext {
  adaptor: ReturnType<typeof liteAdaptor>;
  doc: ReturnType<typeof mathjax.document>;
}

let mathContext: MathContext | null | undefined;

function getMathContext(): MathContext | null {
  if (mathContext !== undefined) return mathContext;
  try {
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const doc = mathjax.document('', {
      InputJax: new TeX({ packages: AllPackages }),
      // "local" embeds glyph outlines as paths (no font dependency) with
      // fill=currentColor, so recolouring is a CSS `color` injection away.
      OutputJax: new SVG({ fontCache: 'local' }),
    });
    mathContext = { adaptor, doc };
  } catch {
    mathContext = null;
  }
  return mathContext;
}

function texToSvg(tex: string): string | undefined {
  const ctx = getMathContext();
  if (ctx === null) return undefined;
  try {
    const node = ctx.doc.convert(tex, { display: true });
    const html = ctx.adaptor.outerHTML(node);
    // TeX errors surface as a data-mjx-error attribute rather than a throw.
    if (html.includes('data-mjx-error')) return undefined;
    const match = html.match(/<svg[\s\S]*<\/svg>/);
    return match?.[0];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// SVG → PNG rasterization.
// ---------------------------------------------------------------------------

/**
 * 1ex is the math font's x-height (≈0.43em). Scaling 1ex to ~50% of the
 * terminal cell height lands the formula at ≈1.2× the text font's visual
 * size — the classic display-math comfort zone: slightly larger than the
 * surrounding text without towering over it. (Cell height ≈ 1.2 × text em
 * and text x-height ≈ 0.5em for typical monospace fonts, so ~0.42 would be
 * exactly text size.) Cell pixel dimensions already carry the DPI, so
 * HiDPI tracks itself.
 */
const PX_PER_EX_PER_CELL_HEIGHT = 0.5;
const MIN_PX_PER_EX = 6;

interface Raster {
  png: Buffer;
  widthPx: number;
  heightPx: number;
}

function svgToPng(svg: string, colorHex: string): Raster | undefined {
  const resvg = getResvg();
  if (resvg === null) return undefined;

  // resvg doesn't reliably resolve `ex` units — rewrite the root extent
  // to explicit pixels; the viewBox handles the scaling.
  const dims = /<svg[^>]*\bwidth="([\d.]+)ex"[^>]*\bheight="([\d.]+)ex"/.exec(svg);
  if (dims === null || dims[1] === undefined || dims[2] === undefined) return undefined;
  const widthEx = Number(dims[1]);
  const heightEx = Number(dims[2]);
  if (!(widthEx > 0) || !(heightEx > 0)) return undefined;

  const cell = getCellDimensions();
  const pxPerEx = Math.max(MIN_PX_PER_EX, cell.heightPx * PX_PER_EX_PER_CELL_HEIGHT);
  const widthPx = Math.ceil(widthEx * pxPerEx);
  const heightPx = Math.ceil(heightEx * pxPerEx);

  // Snap the canvas to whole terminal cells: image protocols place
  // graphics on cell boundaries, so transparent padding to an exact
  // multiple keeps the formula flush with the text grid.
  const paddedWidthPx = Math.ceil(widthPx / cell.widthPx) * cell.widthPx;
  const paddedHeightPx = Math.ceil(heightPx / cell.heightPx) * cell.heightPx;

  let sized = svg
    .replace(/(<svg[^>]*?)\bwidth="[\d.]+ex"/, `$1width="${String(widthPx)}"`)
    .replace(/(<svg[^>]*?)\bheight="[\d.]+ex"/, `$1height="${String(heightPx)}"`);
  // Glyphs are fill=currentColor — colour them via CSS on the root.
  sized = sized.includes('<svg style="')
    ? sized.replace('<svg style="', `<svg style="color:${colorHex};`)
    : sized.replace('<svg ', `<svg style="color:${colorHex}" `);

  const padded =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(paddedWidthPx)}" ` +
    `height="${String(paddedHeightPx)}" viewBox="0 0 ${String(paddedWidthPx)} ${String(paddedHeightPx)}">` +
    sized +
    '</svg>';

  try {
    return {
      png: new resvg.Resvg(padded).render().asPng(),
      widthPx: paddedWidthPx,
      heightPx: paddedHeightPx,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Display-math hook. Images are cached per (colour, cell size, source) so
// the markdown component's full re-renders reuse the same Image instance
// (and the same Kitty image id) instead of re-transmitting every flush.
// ---------------------------------------------------------------------------

const MAX_CACHE_ENTRIES = 128;
const MAX_IMAGE_ROWS = 16;

const imageCache = new Map<string, Image>();

function cacheSet(key: string, image: Image): void {
  if (imageCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  imageCache.set(key, image);
}

export function renderMathBlockImage(tex: string, width: number): string[] | undefined {
  const caps = getCapabilities();
  if (caps.images === null) return undefined;

  const color = currentTheme.color('text');
  const cell = getCellDimensions();
  const key = `${color}|${String(cell.widthPx)}x${String(cell.heightPx)}|${tex}`;

  let image = imageCache.get(key);
  if (image === undefined) {
    const svg = texToSvg(tex);
    if (svg === undefined) return undefined;
    const raster = svgToPng(svg, color);
    if (raster === undefined) return undefined;

    // Cap the cell bounds at the PNG's natural size so pi-tui draws it 1:1
    // instead of upscaling to fill the width (its default for small images).
    const naturalCols = Math.max(1, Math.round(raster.widthPx / cell.widthPx));
    const naturalRows = Math.max(1, Math.round(raster.heightPx / cell.heightPx));

    const theme: ImageTheme = { fallbackColor: (s) => currentTheme.fg('textDim', s) };
    image = new Image(raster.png.toString('base64'), 'image/png', theme, {
      maxWidthCells: Math.max(1, Math.min(width, naturalCols)),
      maxHeightCells: Math.min(MAX_IMAGE_ROWS, naturalRows),
      filename: 'math',
    });
    cacheSet(key, image);
  } else {
    // LRU refresh.
    imageCache.delete(key);
    imageCache.set(key, image);
  }

  try {
    return image.render(Math.max(1, width));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Inline-math Unicode approximation.
// ---------------------------------------------------------------------------

// No parentheses in either script table: CJK font fallback renders U+207D/E
// and U+208D/E full-width, so a script containing parens falls back to the
// ASCII ^(...) / _(...) form, which reads better than misaligned glyphs.
const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
  '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼',
  'a': 'ᵃ', 'b': 'ᵇ', 'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ', 'f': 'ᶠ',
  'g': 'ᵍ', 'h': 'ʰ', 'i': 'ⁱ', 'j': 'ʲ', 'k': 'ᵏ', 'l': 'ˡ', 'm': 'ᵐ',
  'n': 'ⁿ', 'o': 'ᵒ', 'p': 'ᵖ', 'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'u': 'ᵘ',
  'v': 'ᵛ', 'w': 'ʷ', 'x': 'ˣ', 'y': 'ʸ', 'z': 'ᶻ',
};

const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
  '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌',
  'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ', 'k': 'ₖ',
  'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ',
  't': 'ₜ', 'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ',
};

function toScript(text: string, table: Record<string, string>): string | undefined {
  let out = '';
  for (const ch of text) {
    const mapped = table[ch];
    if (mapped === undefined) return undefined;
    out += mapped;
  }
  return out;
}

// The MathJax tree resolves every symbol entity to its Unicode codepoint for
// free; the walker below only has to handle structure (scripts, fractions,
// roots, accents) and mathvariant letterforms. A second, output-less document
// is used so convert() returns the internal MathML tree instead of SVG —
// bussproofs requires an output jax, so it stays out of the package list.
// Sharing the display-math document is not possible: its SVG output jax
// consumes the tree it typesets.

let inlineMathContext: { doc: ReturnType<typeof mathjax.document> } | null | undefined;

function getInlineMathContext(): { doc: ReturnType<typeof mathjax.document> } | null {
  if (inlineMathContext !== undefined) return inlineMathContext;
  try {
    const adaptor = liteAdaptor();
    RegisterHTMLHandler(adaptor);
    const doc = mathjax.document('', {
      InputJax: new TeX({ packages: AllPackages.filter((p) => p !== 'bussproofs') }),
    });
    inlineMathContext = { doc };
  } catch {
    inlineMathContext = null;
  }
  return inlineMathContext;
}

// Unicode Mathematical Alphanumeric Symbols: each variant is a contiguous
// A-Z / a-z / 0-9 range, minus a handful of letters that predate the block
// and live in Letterlike Symbols instead (the holes).
const VARIANT_BASE: Record<string, readonly [number, number, number?]> = {
  bold: [0x1d400, 0x1d41a, 0x1d7ce],
  italic: [0x1d434, 0x1d44e],
  'bold-italic': [0x1d468, 0x1d482],
  script: [0x1d49c, 0x1d4b6],
  'bold-script': [0x1d4d0, 0x1d4ea],
  fraktur: [0x1d504, 0x1d51e],
  'double-struck': [0x1d538, 0x1d552, 0x1d7d8],
  'bold-fraktur': [0x1d56c, 0x1d586],
  'sans-serif': [0x1d5a0, 0x1d5ba, 0x1d7e2],
  'sans-serif-bold': [0x1d5d4, 0x1d5ee, 0x1d7ec],
  'sans-serif-italic': [0x1d608, 0x1d622],
  'sans-serif-bold-italic': [0x1d63c, 0x1d656],
  monospace: [0x1d670, 0x1d68a, 0x1d7f6],
};

const VARIANT_ALIASES: Record<string, string> = {
  '-tex-calligraphic': 'script',
  '-tex-bold-calligraphic': 'bold-script',
  'bold-sans-serif': 'sans-serif-bold',
};

const VARIANT_HOLES: Record<string, Record<string, string>> = {
  italic: { h: 'ℎ' },
  script: {
    B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ',
    e: 'ℯ', g: 'ℊ', o: 'ℴ',
  },
  fraktur: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' },
  'double-struck': { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' },
};

function applyVariant(text: string, variant: string): string {
  const name = VARIANT_ALIASES[variant] ?? variant;
  const base = VARIANT_BASE[name];
  if (base === undefined) return text;
  const holes = VARIANT_HOLES[name] ?? {};
  let out = '';
  for (const ch of text) {
    const hole = holes[ch];
    if (hole !== undefined) {
      out += hole;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    let mapped: number | undefined;
    if (code >= 0x41 && code <= 0x5a) mapped = base[0] + code - 0x41;
    else if (code >= 0x61 && code <= 0x7a) mapped = base[1] + code - 0x61;
    else if (base[2] !== undefined && code >= 0x30 && code <= 0x39) mapped = base[2] + code - 0x30;
    // Letters outside the mapped ranges (Greek in bold, etc.) degrade to
    // their plain form rather than sinking the whole formula.
    out += mapped === undefined ? ch : String.fromCodePoint(mapped);
  }
  return out;
}

// Combining diacritics for \vec / \hat / \bar / ... — MathJax expresses them
// as mover/munder with one of these accent glyphs over the base.
const ACCENT_MARKS: Record<string, string> = {
  '→': '⃗',
  '^': '̂',
  '~': '̃',
  '¯': '̄',
  '\u203E': '\u0305',
  '˙': '̇',
  '¨': '̈',
};

// Binary operators and relations that read badly when cramped; padded with
// spaces at walk time (suppressed inside scripts and after an opening
// delimiter/operator so "f(-x)" and "a = -b" stay tight). Quantifiers are
// deliberately excluded: print sets them with a thin space, and a full
// terminal cell reads too loose by comparison.
const PADDED_OPERATORS = new Set([
  '=', '+', '-', '−', '×', '÷', '·', '±', '∓', '<', '>', '≤', '≥', '≠', '≈',
  '≃', '≅', '≡', '∼', '∝', '≪', '≫', '≺', '≻', '∈', '∉', '∋', '⊂', '⊃',
  '⊆', '⊇', '⊊', '∪', '∩', '∧', '∨', '⊕', '⊖', '⊗', '⊙', '→', '←', '↔',
  '↦', '⇒', '⇐', '⇔', '↑', '↓', '⟶', '⟸', '⊢', '⊨', '∴', '∵', '∣', '∥',
]);

// Invisible times/comma operators carry no visible glyph in plain text.
// Function application (U+2061) is the exception: it still needs a word
// break ("\sin x" → "sin x"), so tokenText keeps it as a space and
// walkChildren decides whether the gap survives.
const INVISIBLE_OPERATORS = new Set(['⁢', '⁣', '⁤']);

// Punctuation that wants a gap after it but not before: "f(x, y)", never
// "f(x ,y)". Suppressed at the end of a group and inside scripts.
const TRAILING_SPACE_OPERATORS = new Set([',', ';']);

type TokenMmlNode = MmlNode & { getText(): string };

function tokenText(node: MmlNode): string {
  // MathJax preserves \text{...} spaces as no-break spaces; the terminal
  // renders both identically, but plain output should stay plain.
  const text = (node as TokenMmlNode).getText().replaceAll('\u00A0', ' ');
  if (text === '⁡') return ' ';
  if (INVISIBLE_OPERATORS.has(text)) return '';
  const variant = node.attributes.get('mathvariant') as string | undefined;
  // Default letterforms (italic single-letter mi) stay plain; only explicit
  // font commands like \mathbb / \mathcal / \mathbf transform.
  if (variant === undefined || variant === 'normal' || variant === 'italic' || variant === '-tex-mathit') {
    return text;
  }
  return applyVariant(text, variant);
}

function isPaddedOperator(node: MmlNode): boolean {
  return node.isToken && node.kind === 'mo' && PADDED_OPERATORS.has((node as TokenMmlNode).getText());
}

function isFunctionApplication(node: MmlNode): boolean {
  return node.isToken && node.kind === 'mo' && (node as TokenMmlNode).getText() === '⁡';
}

function isTrailingSpaceOperator(node: MmlNode): boolean {
  return node.isToken && node.kind === 'mo' && TRAILING_SPACE_OPERATORS.has((node as TokenMmlNode).getText());
}

function walkChildren(node: MmlNode, pad: boolean): string | undefined {
  const entries: { child: MmlNode; rendered: string }[] = [];
  for (const child of node.childNodes as MmlNode[]) {
    const rendered = walkMathml(child, pad);
    if (rendered === undefined) return undefined;
    entries.push({ child, rendered });
  }
  let out = '';
  for (const [i, entry] of entries.entries()) {
    let rendered = entry.rendered;
    const next = entries[i + 1]?.rendered;
    // A function-application gap before an opening delimiter reads as a
    // typo — "sin (x)" — so the call attaches directly: "sin(x)".
    if (isFunctionApplication(entry.child) && next !== undefined && /^[([{]/.test(next)) continue;
    if (pad && rendered !== '' && isPaddedOperator(entry.child)) {
      if (out !== '' && !/[\s([{,;=+−×÷·±<>≤≥≠∈|-]$/.test(out)) rendered = ' ' + rendered;
      rendered += ' ';
    } else if (pad && rendered !== '' && next !== undefined && next !== '' && isTrailingSpaceOperator(entry.child)) {
      rendered += ' ';
    }
    out += rendered;
  }
  return out.trimEnd();
}

// A script that is already one balanced parenthesized group keeps its own
// parens in the ASCII fallback — "^((i))" would read as a typo.
function isWrappedInParens(text: string): boolean {
  const chars = Array.from(text);
  if (chars[0] !== '(' || chars.at(-1) !== ')') return false;
  let depth = 0;
  for (const [i, ch] of chars.entries()) {
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth < 0 || (depth === 0 && i < chars.length - 1)) return false;
    }
  }
  return depth === 0;
}

function sup(text: string): string {
  const mapped = toScript(text, SUPERSCRIPT);
  if (mapped !== undefined) return mapped;
  return isWrappedInParens(text) ? `^${text}` : `^(${text})`;
}

function sub(text: string): string {
  const mapped = toScript(text, SUBSCRIPT);
  if (mapped !== undefined) return mapped;
  return isWrappedInParens(text) ? `_${text}` : `_(${text})`;
}

function walkParts(node: MmlNode, pad: boolean): string[] | undefined {
  const parts: string[] = [];
  for (const child of node.childNodes as MmlNode[]) {
    const rendered = walkMathml(child, pad);
    if (rendered === undefined) return undefined;
    parts.push(rendered);
  }
  return parts;
}

function walkMathml(node: MmlNode, pad: boolean): string | undefined {
  if (node.isToken) {
    // Undefined control sequences surface as an mtext holding the literal
    // command (e.g. "\notacommand") rather than an merror — treat a
    // backslash inside text as a parse artifact and bail.
    if (node.kind === 'mtext' && (node as TokenMmlNode).getText().includes('\\')) return undefined;
    return tokenText(node);
  }
  switch (node.kind) {
    case 'math':
    case 'mrow':
    case 'inferredMrow':
    case 'TeXAtom':
    case 'mstyle':
    case 'mpadded':
      return walkChildren(node, pad);
    case 'mphantom':
      return '';
    case 'mspace':
      return ' ';
    case 'msup':
    case 'msub':
    case 'msubsup':
    case 'munderover': {
      const parts = walkParts(node, false);
      const [base = '', first = '', second = ''] = parts ?? [];
      if (parts === undefined) return undefined;
      if (node.kind === 'msup') return base + sup(first);
      if (node.kind === 'msub') return base + sub(first);
      return base + sub(first) + sup(second);
    }
    case 'munder':
    case 'mover': {
      const [baseNode, scriptNode] = node.childNodes as MmlNode[];
      if (baseNode === undefined || scriptNode === undefined) return undefined;
      const base = walkMathml(baseNode, pad);
      if (base === undefined) return undefined;
      if (scriptNode.isToken) {
        const mark = ACCENT_MARKS[(scriptNode as TokenMmlNode).getText()];
        if (mark !== undefined) return Array.from(base, (ch) => ch + mark).join('');
      }
      const script = walkMathml(scriptNode, false);
      if (script === undefined) return undefined;
      return node.kind === 'munder' ? base + sub(script) : base + sup(script);
    }
    case 'mfrac': {
      const parts = walkParts(node, pad);
      if (parts === undefined) return undefined;
      const [num = '', den = ''] = parts;
      return `(${num})/(${den})`;
    }
    case 'msqrt': {
      const inner = walkChildren(node, pad);
      return inner === undefined ? undefined : `√(${inner})`;
    }
    case 'mroot': {
      const parts = walkParts(node, false);
      if (parts === undefined) return undefined;
      const [base = '', root = ''] = parts;
      return `${toScript(root, SUPERSCRIPT) ?? root}√(${base})`;
    }
    // merror = TeX parse failure; mtable/menclose/mfenced & friends have no
    // readable one-line form — the caller falls back to the raw source.
    default:
      return undefined;
  }
}

export function latexToUnicode(tex: string): string | undefined {
  const ctx = getInlineMathContext();
  if (ctx === null) return undefined;
  let root: MmlNode;
  try {
    root = ctx.doc.convert(tex, { display: false }) as unknown as MmlNode;
  } catch {
    return undefined;
  }
  const rendered = walkMathml(root, true);
  if (rendered === undefined) return undefined;
  // Only bail when the source itself is just as good a display ("$f(x)$" →
  // "f(x)"): whenever the rendered form differs at all it is the better
  // text — braces and backslashes never belong in the transcript.
  if (rendered.trim() === tex.trim()) return undefined;
  return rendered;
}
