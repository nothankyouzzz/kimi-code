import { resetCapabilitiesCache, setCapabilities } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it } from 'vitest';

import { latexToUnicode, renderMathBlockImage } from '#/tui/utils/math-image';

describe('latexToUnicode', () => {
  it('maps Greek letters and common symbols', () => {
    expect(latexToUnicode('\\alpha + \\beta \\times \\gamma')).toBe('α + β × γ');
    expect(latexToUnicode('x \\in \\mathbb{R}')).toBe('x ∈ ℝ');
    expect(latexToUnicode('a \\leq b \\neq c \\Rightarrow d \\in \\Omega')).toBe(
      'a ≤ b ≠ c ⇒ d ∈ Ω',
    );
  });

  it('flattens fractions and roots, including nesting', () => {
    expect(latexToUnicode('\\frac{a}{b}')).toBe('(a)/(b)');
    expect(latexToUnicode('\\frac{\\frac{a}{b}}{c}')).toBe('((a)/(b))/(c)');
    expect(latexToUnicode('\\sqrt{x^2+1}')).toBe('√(x² + 1)');
    expect(latexToUnicode('\\sqrt[3]{x}')).toBe('³√(x)');
  });

  it('converts sub- and superscripts', () => {
    expect(latexToUnicode('x^{2} + y_1')).toBe('x² + y₁');
    expect(latexToUnicode('e^{i\\pi} + 1 = 0')).toBe('e^(iπ) + 1 = 0');
    expect(latexToUnicode('\\sum_{i=1}^{n} i')).toBe('∑ᵢ₌₁ⁿi');
    // Parentheses have no superscript glyph (CJK fallback renders U+207D/E
    // full-width), so the script falls back to the ASCII form.
    expect(latexToUnicode('x^{(i)} \\in S')).toBe('x^(i) ∈ S');
  });

  it('pads punctuation and keeps function application readable', () => {
    expect(latexToUnicode('\\sin\\alpha')).toBe('sin α');
    expect(latexToUnicode('\\sin(\\theta) + \\log\\beta')).toBe('sin(θ) + log β');
    expect(latexToUnicode('f(x),g(\\alpha)')).toBe('f(x), g(α)');
    // Quantifiers stay tight by design: print sets a thin space after them,
    // and a full terminal cell reads too loose by comparison.
    expect(latexToUnicode('\\forall x \\in \\mathbb{R}, \\exists y')).toBe('∀x ∈ ℝ, ∃y');
  });

  it('drops braces and command backslashes from otherwise plain source', () => {
    expect(latexToUnicode('{x}')).toBe('x');
    expect(latexToUnicode('\\lim')).toBe('lim');
    expect(latexToUnicode('f^{(n)}(a)')).toBe('f^(n)(a)');
  });

  it('maps mathvariant letterforms from font commands', () => {
    expect(latexToUnicode('\\mathbb{R} \\ni x \\in \\mathcal{H}')).toBe('ℝ ∋ x ∈ ℋ');
    expect(latexToUnicode('\\mathfrak{g} \\otimes \\mathbf{r}')).toBe('𝔤 ⊗ 𝐫');
    expect(latexToUnicode('\\lim_{x \\to 0} f(x)')).toBe('lim_(x→0)f(x)');
  });

  it('unwraps diacritics, text wrappers and sized delimiters', () => {
    expect(latexToUnicode('\\vec{v}')).toBe('v\u20D7');
    expect(latexToUnicode('\\hat{x} + \\bar{y}')).toBe('x\u0302 + y\u0304');
    expect(latexToUnicode('\\left( \\frac{a}{b} \\right)')).toBe('((a)/(b))');
    expect(latexToUnicode('f(x) \\text{ for } x > 0')).toBe('f(x) for x > 0');
  });

  it('returns undefined for input it cannot approximate', () => {
    expect(latexToUnicode('\\begin{matrix} a & b \\end{matrix}')).toBeUndefined();
    expect(latexToUnicode('\\notarealcommand{x}')).toBeUndefined();
    expect(latexToUnicode('x')).toBeUndefined();
  });
});

describe('renderMathBlockImage', () => {
  afterEach(() => {
    resetCapabilitiesCache();
  });

  it('returns undefined when the terminal cannot display images', () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    expect(renderMathBlockImage('E = mc^2', 80)).toBeUndefined();
  });

  it('renders a kitty image sequence for display math', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const lines = renderMathBlockImage('E = mc^2', 80);
    expect(lines).toBeDefined();
    expect(lines?.[0]).toContain('\u001B_G');
    // The TUI accounts for image height via trailing empty lines.
    expect(lines!.length).toBeGreaterThan(1);
    for (const line of lines!.slice(1)) {
      expect(line).toBe('');
    }
  });

  it('renders through the iTerm2 protocol too', () => {
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: true });
    const lines = renderMathBlockImage('\\int_0^1 x^2 dx = \\frac{1}{3}', 80);
    expect(lines).toBeDefined();
    expect(lines?.some((line) => line.includes('\u001B]1337;File='))).toBe(true);
  });

  it('reuses the cached image across re-renders', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const first = renderMathBlockImage('a^2 + b^2 = c^2', 80);
    const second = renderMathBlockImage('a^2 + b^2 = c^2', 80);
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('returns undefined for invalid TeX', () => {
    setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    expect(renderMathBlockImage('x^2^3', 80)).toBeUndefined();
  });
});
