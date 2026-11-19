/**
 * The Markdown block and inline parser, shared by both halves of the plugin.
 *
 * This module is deliberately React-free and DOM-free: the Client renders what
 * it produces, and the Host's `estimateHeight` (src/layout.ts) walks the same
 * structure to predict a card's rendered height. Keeping ONE parser is what
 * makes the estimate and the render agree — a second, string-based guess is
 * exactly how a tidied wall ends up with overlapping cards.
 *
 * The supported subset is a sticky note's, not a document's: ATX headings,
 * paragraphs, emphasis/code/strike, fenced and indented code, nested ordered and
 * unordered lists with `- [ ]` checkboxes, nested block quotes, rules, pipe
 * tables with column alignment, and http(s)/mailto links.
 *
 * ## The two invariants that keep this parser honest
 *
 * 1. **Indentation is structure, never noise.** Every block marker is matched
 *    against the line with its leading whitespace removed, so `  > quote` and
 *    `> quote` are the same construct. Matching the raw line for one and the
 *    trimmed line for the other is what used to make this parser loop forever on
 *    an indented quote.
 * 2. **Every step advances.** {@link parseOne} returns the index to resume at,
 *    and {@link parseRange} forces `index + 1` if a step ever returns a
 *    non-advancing index. A render loop that stops advancing is not a visible
 *    bug on a sticky note: it is a frozen sidebar.
 */
/** Column width of one nesting level. The editor's Tab inserts exactly this. */
export declare const INDENT_WIDTH = 2;
/** One table cell's horizontal alignment, as declared by the divider row. */
export type TableAlign = 'left' | 'center' | 'right' | null;
/** One list item: its own text plus any blocks nested under it. */
export interface ListItem {
    /** The item's text, without its marker. May contain `\n` for continuation lines. */
    text: string;
    /** Nested blocks: a deeper list, a paragraph, a code block, another quote. */
    children: Block[];
}
/** One parsed block of a note body. */
export type Block = {
    kind: 'heading';
    level: 1 | 2 | 3 | 4 | 5 | 6;
    text: string;
} | {
    kind: 'paragraph';
    text: string;
} | {
    kind: 'code';
    text: string;
    language: string;
} | {
    kind: 'indentedCode';
    text: string;
} | {
    kind: 'quote';
    children: Block[];
} | {
    kind: 'list';
    ordered: boolean;
    start: number;
    items: ListItem[];
} | {
    kind: 'rule';
} | {
    kind: 'table';
    header: string[];
    rows: string[][];
    align: TableAlign[];
};
/**
 * Parse a note body into blocks.
 *
 * Exported so the parser is unit-testable without a DOM, and so a future
 * "copy as plain text" action can reuse the same structure.
 */
export declare function parseBlocks(source: string): Block[];
/**
 * One plain-text digest of a note, for lists, aria-labels and search.
 * Strips Markdown syntax: no `##`, no `**`, no `- [ ]`, no ``` fences, no pipes.
 *
 * The FIRST block that yields visible text wins, because a digest is one line:
 * a rule carries none, and an empty heading or paragraph is what a half-typed
 * note looks like. Picking the first *visible* block means a note that opens
 * with `---` still summarises its actual first line instead of returning ''.
 */
export declare function plainTextSummary(source: string, max?: number): string;
/**
 * Normalize a link target.
 *
 * Only http(s) and mailto survive. A `javascript:` or `data:` URL degrades to
 * plain text, so a note pasted from somewhere hostile cannot become a live
 * script URL in the shell's DOM.
 */
export declare function safeHref(raw: string): string | undefined;
