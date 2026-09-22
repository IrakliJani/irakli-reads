---
name: irakli-reads
description: Use when making web articles printable, extracting an article to Markdown, preserving prose word-for-word, rendering print HTML with Astro/Shiki, or printing links as cleaned `{url}` annotations.
---

# Irakli Reads

Goal: deterministic article print. The article body is evidence, not prose to improve.

## Steps

1. **Run.** From the repository root, generate a PDF with the skill script:
   ```sh
   node skills/irakli-reads/scripts/print-article.ts '<URL>' --slug '<slug>'
   ```
   Add `--smaller-body-font` only when requested to reduce article prose from 11pt to 10pt. Add `--image-scale <1-100>` when requested to cap images at a percentage of article width. If Chromium is missing, run `pnpm article:install-browser` once and retry. Done when `articles/<slug>.md`, `dist/read/<slug>/index.html`, and `pdfs/<slug>.pdf` exist after a passing fidelity verifier run.

2. **Inspect.** Read the Markdown for extraction artifacts: nav text, ads, broken code fences, missing headings, or malformed links. Done when every artifact is either fixed in deterministic extraction code or accepted as source content.

3. **Print.** Open:
   ```sh
   open dist/read/<slug>/index.html
   ```
   Done when the browser print preview shows black-on-white body text using the detected serif/sans-serif stack, Shiki GitHub Light code, and printed links as `label {clean-url}`.

## Rules

- No LLM rewriting of article prose. Manual edits are for deterministic cleanup only.
- Keep scripts TypeScript-only. Node runs `.ts` directly; TypeScript 7 checks them with `pnpm article:check`.
- Keep code highlighting light; never reintroduce dark syntax backgrounds.
- Capture large interactive article sections as screenshots rather than flattening or dropping them; extract panel explainers into styled captions.
- Clean links before render: absolutize relative URLs and strip tracking/referral params.
- Preserve Markdown as the readable archive, but trust the verifier over visual similarity.
- See `README.md` for project commands.
