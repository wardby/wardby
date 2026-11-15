/**
 * Board format v1: the agent contract. The one home of these rules: the send-to-agent task
 * (agent-formats.ts) includes them and help/design-boards-format.md must contain each line
 * (format.test.ts / docs test). Spec "Board format v1", rule 6 included.
 */
export const BOARD_FORMAT_RULES: readonly string[] = [
  "Files: `manifest.json` (`title`, `boards: [{ id, name, file, width }]`, the first board is the start screen) and `boards/<id>.html`; `id` is lowercase letters, digits and `-`, and `file` is `boards/<id>.html`.",
  "No JavaScript: no `<script>`, no `on*=` attributes, no `javascript:` URLs.",
  "All CSS in the file. No external stylesheets, images, fonts or scripts; system fonts; pictures as CSS, emoji, inline SVG or `data:` images.",
  "Responsive: designed at 1280 px wide and must work at 768 and 390 (stack columns, `flex-wrap`, `grid auto-fit/minmax`, media queries).",
  'Links between boards use `href="#board:<id>"`. Every board shows the same header/navigation; the logo links to the first board. Other links may use `https://` or `#`.',
  "CSS variables on `body`, not `:root`; longhand properties when a value uses `var()` (`background-color`, `border-color`, not `background: var(--x)` or `border: 2px solid var(--x)`).",
  "Under 40 KB per board (512 KB is the hard limit).",
];

export function boardFormatRulesText(): string {
  return BOARD_FORMAT_RULES.map((r, i) => `${i + 1}. ${r}`).join("\n");
}
