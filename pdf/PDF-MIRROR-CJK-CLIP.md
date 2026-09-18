# PDF 镜像 CJK 不裁切（PDF-MIRROR-CJK-CLIP）

Hard gate. Companion to `PDF-READOUT-MIRROR.md` §4.1.1.

## Locked rules

1. Text mirror boxes (`kind=text` / role title · authors · heading · body/paragraph · caption) **MUST NOT** clip CJK with a dead-height PDF bbox + `overflow:hidden`.
2. `.mirror-item` / `.mirror-box` text: `overflow: visible` (at least `overflow-y`). Image/formula **crop** `.mirror-visual` may keep `overflow: hidden`.
3. `.mirror-page`: prefer `overflow: visible`. If clipping decorations, use page padding / decorate clip only — never clip text glyph ink.
4. Box height: title `line-height` ≥ 1.25 (prefer 1.3); used height ≥ content after CJK wrap. Strategies OK:
   - **A** scrollHeight rewrite
   - **B** `max(srcH, fs×lh)` + 2–4px pad
   - **C** top/left/width only + `height: auto` (min-height may keep source bbox)
5. Vertical looseness preferred over glyph clip. After text height fit, **run vertical collision on the same page**: sort by `top`; if A overlaps B in X and A.bottom > B.top, push B (and later overlapping boxes) down by the overlap + a small gap. Overlapping ink is **not** OK.
6. Do **NOT** shrink font to dodge clip.
7. Author grid: merge name / affiliation / email in a column, then push rows so cells do not stack after CJK growth.
8. Abstract must keep horizontal separation from the left arXiv metadata strip — no id/date ink over the paragraph.
9. Footer contribution notes render **once** (dedupe ghost / double DOM). If they grow, push — do not multi-layer.

## Acceptance (Attention homepage)

- Title translation (e.g. 「注意力即一切所需」) top+bottom fully visible — no flat-head / flat-foot crop
- Authors readable: no name / email / affiliation stacking
- Abstract not covered by arXiv meta
- Footer contribution single-layer readable
- Dark theme: white paper + `--oi-mirror-ink: #1a1a1a` still no crop
- Image / formula crops still clip in box
- No regression: KaTeX, right zoom chip, page scroll sync, contrast
- `node --test` pass
