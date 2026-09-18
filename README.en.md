# Open Immerse / 沉浸译

[中文](README.md) · **English**

Open-source Chrome **bilingual webpage translation** extension (Manifest V3).

Translate foreign-language webpages and plain-text documents into a side-by-side reading view. You bring the API keys; you pick the engine.

Repo: https://github.com/wisdom-km/open-immerse

Current version **0.3.0**. V1 ships webpage bilingual first. The learning center and document translator work. **PDF reading is a lab feature: off by default.** It only appears after you opt in under **Settings → Advanced**. When enabled, the path is text-layer extract → Markdown reading-flow → translate (not a bbox mirror). YouTube / X captions, hover translate, and selection cards still exist in code; they are **off by default and hidden from the main UI**.

Not affiliated with the commercial “Immersive Translate” product.

---

## What works

| Module | Status |
| --- | --- |
| Page FAB | Glass capsule, bottom-right: Translate / Stop, Original, ‹ collapse. Draggable; position is saved. **Stop** appears only while a job (including polish) is running. Stop aborts inflight requests and **keeps inserted translations**. **Original** is what clears them. |
| Webpage | Default scope is **article body** (`main` / `article` column — no sidebar or nav). Switch to **full page** if needed (includes short sidebar/TOC labels). The primary H1 is translated when possible: source above, gloss below; heading gloss font-size tracks the body translation (not the oversized H1); the optical gap between heading source and gloss is tightened in article scope. Top nav chains, breadcrumbs, cookie bars, and footer link piles are still skipped. |
| Per-page quota | `all` or `title + lead` (H1 + first body block; the lead is capped at about 3 lines / 220 characters). **Batch size** only controls how many segments go in one API request, not how many segments the page may translate. |
| Learning center | Save words / phrases / sentences. All items or due-today review (simplified SM-2). Export Markdown / PDF / Word. |
| Documents | Read TXT / MD / HTML, translate by segment, edit the target, retry failures, export HTML. |
| PDF reader (lab) | **Off by default** (Settings → Advanced, opt-in). When enabled: text-layer extract → Markdown reading-flow → translate. Content can misalign; **formulas may be dropped or garbled**; **English formulas/math may be wrongly translated into Chinese**. No OCR; no text layer → empty right pane. Future (not shipped): an **OCR API** → PDF→Markdown → then translate that Markdown (better for scans and formula-heavy papers). **Webpage bilingual remains the primary product.** |
| Shortcut | `Alt+T`: start translation / restore original (restore clears translations). |

Suggested regression page (article-scope scan and title handling were tuned on posts like this):  
https://claude.com/blog/what-1-000-small-business-owners-taught-us-about-ai

---

## Install

Chrome 114+ (or another Chromium browser with MV3 module service workers).

```bash
git clone https://github.com/wisdom-km/open-immerse.git
```

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** and pick the repo root (the folder that contains `manifest.json`)

Already installed: `git pull`, then click **Reload** on the extensions page. Do **not** Remove and re-add — that wipes keys in `chrome.storage.sync`. Export settings first if you must reinstall.

**Zero build.** Edit JS / CSS / HTML and reload. There is no bundle step.

---

## Usage

The default UI language is Simplified Chinese. Button labels below are the ones on screen.

### 1. Configure an engine

Toolbar icon → **设置** (Settings), or right-click the icon → Options.

1. Pick the default engine
2. Fill API key / base URL / model (depends on the engine)
3. Click **测试连接** (Test connection)
4. Save

Default engine is **MyMemory (free trial)** — no key required, quality and quota are limited. For real reading, switch to DeepL or any LLM channel.

Keys live in `chrome.storage.sync`. Settings export includes keys; keep that file private.

### 2. Translate a page

Open a foreign-language page and click **翻译** on the FAB.

| Action | Effect |
| --- | --- |
| 翻译 (Translate) | Scan nodes for the current scope and quota; send batches to the background |
| 停止 (Stop) | Abort unfinished requests; keep translations already inserted |
| 原文 (Original) | Remove every `.oi-translation` on the page; FAB returns to Translate |
| Uncheck “翻译此页” in the popup | Same as Original (clears translations) |
| `Alt+T` | Start; press again to restore original |

The popup can also change page scope, per-page quota, source/target language, and per-site auto-translate. PDF entries are hidden by default. Only after you enable **PDF 阅读（实验室）** under **Settings → Advanced** does the popup footer show **PDF**, and a PDF tab show **在沉浸译中打开** (Open in Open Immerse).

Translation style (dashed / solid / boxed / dim dashed / left-bar card under the source) and font scale live in Settings.

Spacing (Settings → 语言与通用, number inputs; **body paragraphs only — not headings or sidebars**):

- **正文译文间距** (`bodyGlossGap`): gap between each source block and its gloss underneath; typically ~0.10–0.70 (em-ish)
- **译文段间距** (`bodyGlossStackGap`): extra space between consecutive body gloss blocks; range **0–2.5**. Values 0 / 1 / 2 are visibly different

### 3. Save and review

- Select text → right-click **收藏** (Save). The selection is translated, then stored.
- Double-click an inserted translation to save it.
- Learning center: full list, or due-today review with three grades (Forgot / Fuzzy / Remembered).

Items live in `chrome.storage.local` (`oiLearning`), separate from synced settings.

### 4. Documents

Popup → **文档**, or the link at the top of Settings. Paste or load TXT / MD / HTML, translate by segment, edit the target on the right, export `open-immerse-bilingual.html`.

No layout-preserving Office or scanned files here. Convert to plain text first. Scans wait on the lab OCR path, or convert to Markdown yourself.

### 5. PDF (lab, off by default)

**Not a default entry.** Enable **PDF 阅读（实验室）** under **Settings → Advanced** before the popup footer **PDF** button or a PDF tab’s **在沉浸译中打开** appear.

Current path when enabled: text-layer extract → Markdown reading-flow → translate.

- Left pane: pdf.js continuous scroll; zoom applies only to the original page
- Top bar: Open PDF → `当前页 | 全文` (current page / full document; switching does **not** start a job) → Translate / Stop → Original → export MD / PDF
- Full document walks pages with `OI_TRANSLATE_BATCH`. Progress is `翻译中 · k/n`. Jobs can be stopped. After stop or completion the primary button returns to **翻译**; Chinese already produced stays
- **Original clears the current page only**, not other translated pages
- Right pane is a **Markdown reading-flow**: extract title + body in reading order, translate, scroll as a document — **not** a bbox layout mirror
- Separate right-pane zoom chip (0.5–5, step 0.25); not in the top bar
- Drag the split to resize columns
- MD export uses `$...$` / `$$...$$` when LaTeX was recovered; otherwise Unicode or `[公式]`
- **Known limits:** content can misalign; **formulas may be dropped or garbled**; **English formulas/math may be wrongly translated into Chinese**
- **No OCR**, and the extension does not inject into Chrome’s built-in PDF viewer. No text layer → empty right pane
- **Future (not shipped):** integrate an **OCR API** → turn the PDF into Markdown → then translate that Markdown (better for scans and formula-heavy papers)
- Webpage bilingual remains the primary product and the regression target

---

## Engines

The **service worker** owns every outbound request. Content scripts do not call translation APIs.

| id | Name | Kind | Defaults |
| --- | --- | --- | --- |
| `mymemory` | MyMemory (free trial) | MT | Optional email for a higher quota |
| `microsoft` | Microsoft Translator | MT | Region default `eastasia` |
| `deepl` | DeepL | MT | Free / Pro host switch |
| `google` | Google Cloud Translation | MT | Cloud Translation v2 |
| `openai` | OpenAI / compatible | LLM | `https://api.openai.com/v1` · `gpt-4o-mini` |
| `kimi` | Kimi / Moonshot | LLM | CN `api.moonshot.cn` / global `api.moonshot.ai` · `kimi-k2.5` |
| `minimax` | MiniMax | LLM | CN `api.minimax.cn` / global `api.minimax.io` · `MiniMax-M2.5` |
| `grok` | xAI Grok | LLM | `https://api.x.ai/v1` · `grok-4-fast` |
| `openrouter` | OpenRouter | LLM | Optional HTTP-Referer / X-Title |
| `gemini` | Google Gemini | LLM | `gemini-2.0-flash` |
| `claude` | Anthropic Claude | LLM | `claude-3-5-haiku-latest` |
| `azure` | Azure OpenAI | LLM | endpoint + deployment + apiVersion |
| `custom` | Custom HTTP | any | URL / method / headers JSON / body template / responsePath |

**Ollama and other local OpenAI-compatible servers:** there is no separate vendor row. Choose `openai`, set Base URL to something like `http://127.0.0.1:11434/v1`, and put the local model name in Model. Or assemble the request with `custom`.

Language list comes from `lib/languages.js` (auto-detect, Simplified/Traditional Chinese, EN/JA/KO, and common European and Asian languages). Machine-translation engines remap those codes to each vendor’s API.

### LLM quality

Every LLM adapter shares one Skill: `lib/translate-skill.js`.

- Default is a **single** pass (saves tokens)
- Settings → Advanced **先信后润** (`twoStepPolish`, off by default): faithful draft first. The page inserts the draft and toasts “润色中”, then replaces it with the polished text. If polish fails, the draft stays and a short “润色失败” toast appears
- This is ordinary language conversion (e.g. English → modern Chinese). **Not classical Chinese**
- A non-empty custom system prompt skips the second pass
- Chinese targets get a glossary hint, then two safety nets after parse: `guardZhBusinessSense` (so “business owners” does not fuse into 主教 / “bishop”) and `guardZhTitleCalques` (strips hollow title wrappers)

### Deep thinking

Settings → Advanced **深度思考** (`deepThink`, off by default).

`thinking` / `reasoning_effort` are attached **only** when the base URL or model looks like **Ark (Volcengine) or DeepSeek**:

- Off: `thinking.type=disabled` plus `reasoning_effort=minimal`
- On: `thinking.type=enabled`

Other engines omit those fields so they do not 400. Webpage, PDF, and documents share both flags.

---

## Permissions and data

`manifest.json` requests:

- `storage` — settings (`sync`) + learning items (`local`)
- `activeTab` / `scripting` — start/stop on the current tab
- `contextMenus` — right-click save
- `alarms` — reserved
- `host_permissions: <all_urls>` — inject content scripts on any page; the background calls vendor APIs

Content scripts inject at `document_idle`: `lib/fab.js`, `lib/bilingual-layout.js`, `content/content.js`, `content/toolbar.js`, `content/subtitles.js`.

Translations are cached in service-worker memory, cap 2000 entries, gone on restart. The cache key includes engine, languages, two-step vs single, and think vs fast so those modes do not mix.

---

## Layout

```
open-immerse/
├── manifest.json              # MV3, version 0.3.0
├── background/service-worker.js
├── content/                   # DOM scan, insert translations, subtitle stubs
├── popup/
├── options/
├── learning/
├── documents/
├── pdf/                       # in-extension viewer + design notes
│   ├── viewer.html|js|css
│   └── vendor/                # pdf.js 4.10.38 · KaTeX 0.18.7
├── lib/
│   ├── providers.js           # all engine adapters
│   ├── translate-skill.js     # shared Skill / two-step prompts
│   ├── storage.js             # defaults + migration (settingsVersion = 7)
│   ├── page-scan.js           # node collection (keep in sync with content.js)
│   ├── site-presets.js        # site presets (claude.com today)
│   ├── bilingual-layout.js
│   ├── pdf-readout.js         # PDF right-pane Markdown reading-flow (product path)
│   ├── pdf-mirror.js          # extract helpers; bbox mirror is not the product path
│   ├── pdf-viewer.js
│   ├── pdf-latex.js           # recover LaTeX from the text layer
│   ├── learning.js
│   ├── export.js              # MD / simple PDF / docx
│   ├── translate-limit.js     # title + lead quota
│   └── features.js
├── ui/tokens.css
├── tests/*.test.mjs
├── _locales/zh_CN|en
├── README.md                  # Chinese
├── README.en.md               # this file
└── CONTRIBUTING.md
```

Data flow:

```
page / PDF / document
    → chrome.runtime.sendMessage({ type: "OI_TRANSLATE_BATCH" })
        → service worker: cache hit or providers[id].translate()
            → (optional) OI_TRANSLATE_PROGRESS phase=draft
        ← translations[]
    → insert .oi-translation or PDF readout blocks
```

Content scripts do **not** `fetch` translation APIs. Adding an engine means `lib/providers.js` plus `DEFAULT_SETTINGS.providers`.

---

## Develop

```bash
# Pure-function tests (Node 18+, no package dependencies)
node --test tests/*.test.mjs
```

Conventions: [CONTRIBUTING.md](CONTRIBUTING.md) (Chinese). Short version:

- One intent per PR. Do not commit keys, `.env`, or zip artifacts
- `content/` owns the DOM. Network and cache stay in `background/`
- Popup “翻译此页” follows this tab’s `OI_PING` (existing translations / `html.oi-active`). Do not use the global `enabled` flag as page state
- Do not mix PDF scope (current page / full document) with webpage scan rules
- Webpage scan: `article` takes the main column only; `page` also takes readable sidebar blocks and short TOC/nav labels, and uses a heuristic for an article H1 in the header. Do not ban every `closest('header')`

### Add an engine

1. Add `{ id, name, kind, fields, translate }` to `providers`
2. `translate(texts, ctx)` must return a `string[]` the same length as the input
3. Read secrets only from `ctx.settings`
4. LLMs go through `resolveTranslatorPrompt` + `translateWithSkill`; the model comes from `ctx.settings.model`
5. Add a default block in `DEFAULT_SETTINGS.providers` and a row in both READMEs

---

## Status and limits (0.3)

Ready for daily use: webpage article bilingual, per-site auto rules, learning review, plain-text documents.

Not built, not guaranteed, or still experimental:

| Item | Notes |
| --- | --- |
| **PDF reader (lab, default off)** | `features.pdf` defaults to `false`. When on: text layer → Markdown reading-flow → translate. Content can misalign; formulas may drop/garble or be wrongly translated into Chinese. No OCR; no text layer → empty right pane. Later: OCR API → PDF→Markdown → translate. Webpage bilingual remains the primary product |
| Sidebar en/zh pairing | Shelved; product focus is body/main-text bilingual |
| Chrome Web Store | Unpacked load only |
| OCR | Scanned PDFs with no text layer leave the right pane empty |
| DOCX / complex layouts | Documents page accepts plain-text-like files only |
| Hover / selection / captions | `features.js` `group: "later"`, off by default |
| Dedicated Ollama row | Use the OpenAI-compatible channel |
| Persistent translation cache | Service-worker memory only |
| Isolated secrets | Keys sit in the same sync blob as other settings; exported JSON is plaintext |
| Pixel-perfect page restyle | Webpage mode is “translation under each block”, not a CSS rebuild |

---

## License

MIT © 2026 wisdom-km

Third party:

- [pdf.js](https://github.com/mozilla/pdf.js) 4.10.38 (Apache-2.0) in `pdf/vendor/`
- [KaTeX](https://github.com/KaTeX/KaTeX) 0.18.7 (MIT) in `pdf/vendor/katex/`
