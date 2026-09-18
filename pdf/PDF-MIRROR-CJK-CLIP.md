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
5. **No clip ∩ no overlap.** Growing a box must push later siblings on the same X band (`relayoutMirrorPageBoxes`). Adjacent text ink rects must not intersect (author cells, abstract ↔ margin meta, footnotes). Same-row author cells (no X overlap) stay put. A clip-only fix that leaves stacked ink is a reject.
6. Do **NOT** shrink font to dodge clip.

### §3.2 碰撞下推

CJK 长高后，对同一 `.mirror-page` 跑 `relayoutMirrorPageBoxes`：同 X 带后行下推；作者同行（无 X 重叠）不互推；`reserveMarginMeta` 保证 arXiv / 页边与摘要墨迹不相交。禁止 `overflow:visible` 盖住下一层。

## Acceptance (Attention full paper)

- Title translation (e.g. 「注意力即一切所需」) top+bottom fully visible — no flat-head / flat-foot crop
- Author name / affiliation / email cells readable and not stacked
- Abstract not covered by the arXiv / margin strip
- Attention-figure token rows stay readable (crop original ticks; do not force CJK into ~1em source columns)
- Dark theme: white paper + `--oi-mirror-ink: #1a1a1a` still no crop
- Image / formula crops still clip in box
- No regression: KaTeX, right zoom chip, page scroll sync, reading-order export
- `node --test` pass
