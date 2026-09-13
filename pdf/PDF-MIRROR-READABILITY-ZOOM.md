# PDF 镜像可读性与右栏缩放（PDF-MIRROR-READABILITY-ZOOM）

## Contrast

- `.mirror-page` stays light paper (`#fff`)
- Force dark ink `--oi-mirror-ink: #1a1a1a` on h1/h2/p/authors — NEVER inherit light `--oi-text` from dark chrome theme
- Captions/hints `#4a4a4a`; KaTeX same ink; placeholders dark gray on gray bg

## Right zoom chip (independent)

- `#mirrorZoomChip.zoom-gutter` inside `.pane-translate` — same UI as left FLOAT chip
- Default BR with scrollbar gutter inset; drag follow+persist; 6px click threshold; NO corner snap; NO chip on middle seam
- Independent state: `mirrorZoom` 0.5–5 step 0.25 default 1; keys `pdfMirrorZoom` + `pdfMirrorZoomChipPos` — must NOT share left `zoom` / `pdfZoomChipPos`
- Scale mirror-pages (or readout in 通读); left pdf.js zoom unchanged
- Page sync §4.4 still works after right zoom

## Acceptance

Dark theme + readable mirror ink; left 200% right 100% independent; 50–500%; no regress left chip/split/export/mode toggle.
