/**
 * Markdown reports rendered safely: raw HTML in the source is shown as text,
 * links are inert (reports are evidence, never navigation), and images are
 * not loaded.
 */

import MarkdownIt from 'markdown-it';

function create() {
  const m = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
  // Links render as their text; images as their alt text.
  m.renderer.rules.link_open = () => '<span class="md-link">';
  m.renderer.rules.link_close = () => '</span>';
  m.renderer.rules.image = (tokens: { children: { content: string }[] | null }[], idx: number) => {
    const alt = tokens[idx]!.children?.map((t) => t.content).join('') ?? '';
    return `<span class="md-image">[${m.utils.escapeHtml(alt || 'image')}]</span>`;
  };
  return m;
}

let md: ReturnType<typeof create> | null = null;

function renderer() {
  md ??= create();
  return md;
}

export function renderMarkdown(source: string): string {
  return renderer().render(source);
}

/**
 * Plain-text reports are often a single long line in which the original
 * layout survives only as runs of spaces ("A. UTERUS…:  - LEIOMYOMA.    B.
 * OVARY…"). Reflow rebuilds it, line by line, for lines of 80 characters or
 * more:
 *  - a gap before a part label ("B. ", "2) ") starts a new paragraph;
 *  - a gap before a bullet starts a new line;
 *  - a wide gap after a sentence starts a new paragraph;
 *  - a gap after a label's colon starts a new line;
 *  - any other wide gap was a line wrap and becomes one space.
 * Two spaces between sentences stay. Only whitespace changes, so snippets
 * still match.
 */
export function shouldReflow(text: string): boolean {
  return text.split('\n').some((line) => line.length > 100 && STRUCTURE.test(line));
}

/** Spacing that marks structure: a wide gap, a bullet, or a label's colon. */
const STRUCTURE = /\S[ \t]{3,}\S|\S[ \t]{2,}[-•*] |:[ \t]{2,}\S/;

const LONG_LINE = 80;

function reflowLine(line: string): string {
  return line
    .replace(/[ \t]{2,}(?=(?:[A-Z]|\d{1,2})[.)][ \t])/g, '\n\n')
    .replace(/[ \t]{2,}(?=[-•*][ \t])/g, '\n')
    .replace(/(?<=[.;!?)])(?<!(?:^|\s)[A-Z0-9]{1,2}[.)])[ \t]{3,}/g, '\n\n')
    .replace(/:[ \t]{2,}/g, ':\n')
    .replace(/[ \t]{3,}/g, ' ');
}

export function reflow(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length < LONG_LINE ? line : reflowLine(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
