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
 * Plain-text reports are often a single long line in which parts are
 * separated by runs of spaces ("A. UTERUS…:  - LEIOMYOMA.    B. OVARY…").
 * Reflow turns those runs into line breaks; it changes only whitespace, so
 * snippets still match.
 */
export function shouldReflow(text: string): boolean {
  const lines = text.split('\n');
  const longest = Math.max(...lines.map((l) => l.length));
  return longest > 160 && /\S {2,}\S/.test(text);
}

export function reflow(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]{2,}(?=[-•*] )/g, '\n')
        .replace(/[ \t]{3,}/g, '\n\n')
        .replace(/[ \t]{2}/g, '\n'),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
