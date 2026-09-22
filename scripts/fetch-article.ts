#!/usr/bin/env node
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Readability } from '@mozilla/readability';
import hljs from 'highlight.js';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { chromium, type Browser } from 'playwright';
import { BLOCK_TAGS, errorMessage, normalizeText, sha256, textForHash } from './shared.ts';

const TRACKING_PARAMS = new Set([
  'ascsubtag',
  'camp',
  'creative',
  'fbclid',
  'gclid',
  'igshid',
  'linkcode',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'spm',
  'tag',
]);

const AUTO_DETECT_LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'diff',
  'haskell',
  'javascript',
  'json',
  'python',
  'rust',
  'sql',
  'typescript',
  'xml',
];

const DROP_SELECTORS = [
  'script',
  'style',
  'iframe',
  'noscript',
  'form',
  'button',
  'svg',
  'canvas',
  'nav',
  'aside',
  '.heading-link',
  '.sr-only',
  '[aria-hidden="true"]',
].join(',');

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
}

interface CleanedArticleContent {
  html: string;
  text: string;
}

interface FontFamilySample {
  fontFamily: string;
  textLength: number;
}

interface ArticleContentCandidate {
  html: string;
  textLength: number;
}

interface InteractiveElement {
  elementId: string;
  caption: string;
}

interface InteractiveScreenshot extends InteractiveElement {
  imageSource: string;
  alt: string;
}

type MetadataValue = string | number | boolean | null | undefined;
type SourceFontStyle = 'serif' | 'sans-serif';

function usage(): void {
  console.error(
    'Usage: pnpm article:fetch <url> [--slug slug] [--smaller-body-font] [--image-scale 1-100] [--out articles] [--save-html sources/name.html] [--save-clean-html sources/name.clean.html] [--save-text sources/name.txt]\n\nFetches a web article, extracts readable content, cleans links, and writes Markdown without LLM rewriting. --smaller-body-font reduces article prose from 11pt to 10pt. --image-scale caps images at the given percentage of article width without enlarging smaller images.',
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags.set(key, 'true');
      continue;
    }

    flags.set(key, next);
    index += 1;
  }

  return { positional, flags };
}

function parseImageScale(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const percentage = Number(value);
  if (value === 'true' || !Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
    throw new Error('--image-scale must be an integer from 1 to 100');
  }

  return percentage;
}

function meta(document: Document, selector: string): string {
  const element = document.querySelector(selector);
  const content = element?.getAttribute('content');
  return content?.trim() ?? '';
}

function isoDate(value: string): string {
  const match = normalizeText(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (!match) {
    return '';
  }

  const candidate = `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(`${candidate}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== candidate
    ? ''
    : candidate;
}

function publishedDate(document: Document): string {
  const selectors = [
    'meta[property="article:published_time"]',
    'meta[itemprop="datePublished"]',
    'meta[name="date"]',
    'meta[name="pubdate"]',
    'meta[name="publish-date"]',
  ];
  for (const selector of selectors) {
    const date = isoDate(meta(document, selector));
    if (date) {
      return date;
    }
  }

  const article = document.querySelector('article, [role="article"], main');
  const candidates = article ? [...article.querySelectorAll('time, p')].slice(0, 8) : [];
  for (const candidate of candidates) {
    const date = isoDate(candidate.getAttribute('datetime') ?? candidate.textContent ?? '');
    if (date) {
      return date;
    }
  }

  return '';
}

function identityKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function siteIdentityAuthor(document: Document, sourceUrl: string): string {
  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return '';
  }

  const hostKey = identityKey(source.hostname.replace(/^www\./i, '').split('.')[0]);
  for (const link of [...document.querySelectorAll('a[href]')]) {
    let target: URL;
    try {
      target = new URL(link.getAttribute('href') ?? '', source);
    } catch {
      continue;
    }

    if (target.origin !== source.origin || target.pathname !== '/') {
      continue;
    }

    const heading = link.querySelector('h1, h2, h3');
    const name = normalizeText(heading?.textContent ?? '')
      .replace(/^[{[(<]+\s*/, '')
      .replace(/\s*[}\])>]+$/, '');
    if (name.length <= 80 && identityKey(name) === hostKey) {
      return name;
    }
  }

  return '';
}

function canonicalUrl(document: Document, inputUrl: string): string {
  const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  return cleanUrl(canonical ?? inputUrl, inputUrl) || inputUrl;
}

function cleanUrl(value: string, baseUrl: string): string {
  if (!value) {
    return '';
  }

  if (value.startsWith('#')) {
    return value;
  }

  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return '';
  }

  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
    return '';
  }

  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith('utm_') || TRACKING_PARAMS.has(normalized)) {
      url.searchParams.delete(key);
    }
  }

  if (url.hash.toLowerCase().startsWith('#:~:text=')) {
    url.hash = '';
  }

  return url.toString();
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

  return slug || 'article';
}

function yamlScalar(value: MetadataValue): string {
  return JSON.stringify(value);
}

function getLanguage(element: Element): string {
  const dataLang = element.getAttribute('data-lang');
  if (dataLang) {
    return dataLang;
  }

  const classValue = element.getAttribute('class') ?? element.className;
  for (const className of String(classValue).split(/\s+/)) {
    if (className.startsWith('language-')) {
      return className.slice('language-'.length);
    }
  }

  return '';
}

function inferCodeLanguage(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return '';
  }

  if (
    /^warning:\s|^error:\s|^\s*Pattern match\(es\)/m.test(trimmed) ||
    (/^bun test\b/m.test(trimmed) && /\berror:/i.test(trimmed))
  ) {
    return 'text';
  }

  if (/^\s*(?:\$\s*)?(?:bun|npm|npx|pnpm|yarn|cargo|git)\s+[\w-]+(?:\s|$)/.test(trimmed)) {
    return 'bash';
  }

  if (
    /(^|\n)\s*(SELECT|WITH|CREATE|ALTER|INSERT|UPDATE|DELETE)\b/im.test(trimmed) &&
    /\b(FROM|TABLE|INDEX|WHERE|ORDER BY|GROUP BY|JOIN|LIMIT)\b/i.test(trimmed)
  ) {
    return 'sql';
  }

  const hasZigLabel = /^\s*\/\/\s*Zig\s*:/im.test(trimmed);
  const hasRustLabel = /^\s*\/\/\s*Rust\s*:/im.test(trimmed);
  if (hasZigLabel && hasRustLabel) {
    return 'text';
  }

  if (
    /(?:\bawait\b|\bPromise\.|\bBun\.)/.test(trimmed) &&
    /\b(?:const|let|var|for|while)\b/.test(trimmed)
  ) {
    return 'javascript';
  }

  const zigScore =
    (/\b(?:comptime|anytype|errdefer|orelse)\b/.test(trimmed) ? 4 : 0) +
    (/@[A-Za-z_]\w*\s*\(/.test(trimmed) ? 4 : 0) +
    (/\b(?:defer|try|catch)\b/.test(trimmed) ? 3 : 0) +
    (/\b(?:const|var)\s+\w+\s*:\s*(?:\?|\*|\[|[A-Za-z_])/.test(trimmed) ? 2 : 0) +
    (/\)\s*!\s*[A-Za-z_]\w*\s*\{/.test(trimmed) ? 4 : 0) +
    (/\|\w+\|\s*\{/.test(trimmed) ? 2 : 0) +
    (/\bpub\s+(?:inline\s+)?fn\b/.test(trimmed) ? 1 : 0);
  const rustScore =
    (/\bimpl(?:<[^>]+>)?\s+\w+\s+for\b/.test(trimmed) ? 5 : 0) +
    (/\b(?:Some|None|Ok|Err)\b/.test(trimmed) ? 3 : 0) +
    (/#\[[^\]]+\]/.test(trimmed) ? 4 : 0) +
    (/\buse\s+(?:std|crate|super)::/.test(trimmed) ? 4 : 0) +
    (/&(?:'\w+\s+)?mut\b/.test(trimmed) ? 3 : 0) +
    (/\b(?:let\s+(?:mut\s+)?\w+|pub\s+fn|fn\s+\w+\s*\()/.test(trimmed) ? 1 : 0) +
    (/->\s*(?:Result|Option|Self|impl|[A-Za-z_]\w*::)/.test(trimmed) ? 2 : 0);

  if (zigScore >= 4 && zigScore > rustScore) {
    return 'zig';
  }
  if (rustScore >= 4 && rustScore > zigScore) {
    return 'rust';
  }

  const detected = hljs.highlightAuto(trimmed, AUTO_DETECT_LANGUAGES);
  return detected.language && detected.relevance >= 2 ? detected.language : '';
}

function normalizeInlineFormatting(document: Document): void {
  const tagNames = ['strong', 'b', 'em', 'i'];

  for (const element of [...document.querySelectorAll(tagNames.join(','))]) {
    if (!/[\p{L}\p{N}]/u.test(element.textContent ?? '')) {
      element.replaceWith(...element.childNodes);
    }
  }

  for (const tagName of tagNames) {
    for (const element of [...document.querySelectorAll(tagName)]) {
      while (true) {
        let sibling = element.nextSibling;
        const whitespace: Text[] = [];

        while (sibling?.nodeType === 3 && !(sibling.nodeValue ?? '').trim()) {
          whitespace.push(sibling as Text);
          sibling = sibling.nextSibling;
        }

        if (!sibling || sibling.nodeType !== 1) {
          break;
        }

        const siblingElement = sibling as Element;
        if (siblingElement.tagName.toLowerCase() !== tagName) {
          break;
        }

        element.append(...whitespace, ...siblingElement.childNodes);
        siblingElement.remove();
      }
    }
  }
}

function normalizeTables(document: Document): void {
  for (const table of [...document.querySelectorAll('table')]) {
    const firstRow = table.querySelector('tr');
    if (!firstRow) {
      continue;
    }

    const cells = [...firstRow.children];
    const isHeaderRow =
      cells.length > 0 &&
      cells.every(
        (cell) =>
          cell.tagName.toLowerCase() === 'td' &&
          normalizeText(cell.textContent ?? '') &&
          cell.querySelector('strong, b'),
      );
    if (!isHeaderRow) {
      continue;
    }

    for (const cell of cells) {
      const header = document.createElement('th');
      header.append(...cell.childNodes);
      cell.replaceWith(header);
    }

    const rowGroup = firstRow.parentElement;
    const tableHead = document.createElement('thead');
    table.insertBefore(tableHead, rowGroup);
    tableHead.append(firstRow);
    if (rowGroup && rowGroup.children.length === 0) {
      rowGroup.remove();
    }
  }
}

function replaceHighlightBlocks(document: Document): void {
  for (const highlight of [...document.querySelectorAll('div.highlight')]) {
    const code = highlight.querySelector('code');
    if (!code) {
      continue;
    }

    const pre = document.createElement('pre');
    const cleanCode = document.createElement('code');
    const language = getLanguage(code);

    if (language) {
      cleanCode.className = `language-${language}`;
    }

    cleanCode.textContent = (code.textContent ?? '').replace(/\n$/, '');
    pre.append(cleanCode);
    highlight.replaceWith(pre);
  }
}

function wrapStandaloneCodeBlocks(document: Document): void {
  for (const code of [...document.querySelectorAll('code')]) {
    if (code.closest('pre')) {
      continue;
    }

    const source = (code.textContent ?? '').replace(/\n$/, '');
    const style = code.getAttribute('style') ?? '';
    if (!source.includes('\n') || !/white-space\s*:\s*pre/i.test(style)) {
      continue;
    }

    const pre = document.createElement('pre');
    const cleanCode = document.createElement('code');
    cleanCode.textContent = source;
    pre.append(cleanCode);
    code.replaceWith(pre);
  }
}

function cleanCodeBlocks(document: Document): void {
  for (const code of [...document.querySelectorAll('pre code')]) {
    const text = (code.textContent ?? '').replace(/\n$/, '');
    const language = getLanguage(code) || inferCodeLanguage(text);
    code.replaceChildren();
    code.textContent = text;
    code.removeAttribute('style');
    code.removeAttribute('data-lang');
    code.removeAttribute('class');
    if (language) {
      code.className = `language-${language}`;
    }
  }
}

function unwrap(element: Element): void {
  element.replaceWith(...element.childNodes);
}

function isBylineText(value: string): boolean {
  const text = normalizeText(value);
  return text.length <= 240 && /^by\s+\p{L}/iu.test(text);
}

function isInternalLinkList(element: Element): boolean {
  const elementTag = element.tagName.toLowerCase();
  const onlyChild = element.children.length === 1 ? element.firstElementChild : null;
  const list = ['ul', 'ol'].includes(elementTag)
    ? element
    : onlyChild && ['ul', 'ol'].includes(onlyChild.tagName.toLowerCase())
      ? onlyChild
      : null;
  if (!list) {
    return false;
  }

  const links = [...list.querySelectorAll('a[href]')];
  if (links.length < 2 || links.some((link) => !(link.getAttribute('href') ?? '').startsWith('#'))) {
    return false;
  }

  const withoutLinks = list.cloneNode(true) as Element;
  for (const link of [...withoutLinks.querySelectorAll('a')]) {
    link.remove();
  }

  return !normalizeText(withoutLinks.textContent ?? '');
}

function removeArticleFurniture(document: Document, published: string): void {
  const article = document.querySelector('#article');
  const firstParagraph = article?.querySelector('p');
  if (firstParagraph) {
    const text = normalizeText(firstParagraph.textContent ?? '');
    if (isBylineText(text) && firstParagraph.querySelector('a[href]')) {
      firstParagraph.remove();
    }
  }

  const metadataDate = isoDate(published);
  if (article && metadataDate) {
    for (const element of [...article.querySelectorAll('time, p')].slice(0, 8)) {
      const value = element.getAttribute('datetime') ?? element.textContent ?? '';
      if (isoDate(value) === metadataDate) {
        element.remove();
        break;
      }
    }
  }

  for (const marker of [...document.querySelectorAll('#article :is(p, h1, h2, h3, h4, h5, h6)')]) {
    const label = comparisonText(marker.textContent ?? '');
    if (!['toc', 'table of contents', 'contents'].includes(label)) {
      continue;
    }

    const list = marker.nextElementSibling;
    if (list && isInternalLinkList(list)) {
      marker.remove();
      list.remove();
    }
  }

  for (const list of [...document.querySelectorAll('#article :is(ul, ol)')]) {
    if (!list.isConnected || !isInternalLinkList(list)) {
      continue;
    }

    const parent = list.parentElement;
    list.remove();
    if (
      parent &&
      parent.id !== 'article' &&
      parent.children.length === 0 &&
      !normalizeText(parent.textContent ?? '')
    ) {
      parent.remove();
    }
  }

  for (const element of [...document.querySelectorAll('#article :is(p, div, footer)')]) {
    const label = comparisonText(element.textContent ?? '');
    if (
      label.length <= 300 &&
      label.startsWith('this page respects your privacy') &&
      label.includes('cookies') &&
      label.includes('personally identifiable information')
    ) {
      element.remove();
    }
  }

  const trailingCandidates = article
    ? [...article.querySelectorAll('p, div, footer')].slice(-8)
    : [];
  for (const element of trailingCandidates) {
    const label = comparisonText(element.textContent ?? '');
    if (
      label.length <= 400 &&
      label.includes('newsletter') &&
      (label.includes('sign up') || label.includes('subscribe'))
    ) {
      const separator = element.previousElementSibling;
      element.remove();
      if (separator?.tagName.toLowerCase() === 'hr') {
        separator.remove();
      }
    }
  }
}

function cleanLinks(document: Document, sourceUrl: string): void {
  for (const link of [...document.querySelectorAll('a')]) {
    const href = link.getAttribute('href') ?? '';
    const label = normalizeText(textForHash(link));

    if (href.startsWith('#') && (!label || label.toLowerCase() === 'link to heading')) {
      link.remove();
      continue;
    }

    const cleaned = cleanUrl(href, sourceUrl);
    if (!cleaned) {
      unwrap(link);
      continue;
    }

    link.setAttribute('href', cleaned);

    const hasBlockContent = [...link.querySelectorAll('*')].some((element) =>
      BLOCK_TAGS.has(element.tagName.toLowerCase()),
    );
    if (label && hasBlockContent) {
      link.replaceChildren(document.createTextNode(label));
    }
  }
}

function removeAlternateThemeImages(document: Document): void {
  const parents = new Set<HTMLElement>();
  for (const image of [...document.querySelectorAll('img')]) {
    if (image.parentElement) {
      parents.add(image.parentElement);
    }
  }

  for (const parent of parents) {
    const variants = new Map<string, { dark?: Element; light?: Element }>();
    for (const image of [...parent.children].filter((child) => child.tagName.toLowerCase() === 'img')) {
      const source = image.getAttribute('src') ?? '';
      const match = /^(.*)([-_.])(dark|light)(\.[a-z0-9]+)(?:[?#].*)?$/i.exec(source);
      if (!match) {
        continue;
      }

      const key = `${match[1]}${match[2]}${match[4]}`;
      const pair = variants.get(key) ?? {};
      pair[match[3].toLowerCase() as 'dark' | 'light'] = image;
      variants.set(key, pair);
    }

    for (const pair of variants.values()) {
      if (pair.dark && pair.light) {
        pair.dark.remove();
      }
    }
  }
}

function cleanImages(document: Document, sourceUrl: string): void {
  for (const image of [...document.querySelectorAll('img')]) {
    const rawSource = image.getAttribute('src') ?? '';
    const isPrintScreenshot = image.hasAttribute('data-print-screenshot');
    const source = isPrintScreenshot ? rawSource : cleanUrl(rawSource, sourceUrl);
    if (!source) {
      image.remove();
      continue;
    }

    const alt = image.getAttribute('alt') ?? '';
    image.replaceChildren();
    image.setAttribute('src', source);
    image.setAttribute('alt', alt);
  }
}

function stripAttributes(document: Document): void {
  for (const element of [...document.querySelectorAll('*')]) {
    const tagName = element.tagName.toLowerCase();
    const allowed = new Set<string>();

    if (element.id === 'article') {
      allowed.add('id');
    }

    if (tagName === 'a') {
      allowed.add('href');
    }

    if (tagName === 'img') {
      allowed.add('src');
      allowed.add('alt');
    }

    if (tagName === 'code') {
      allowed.add('class');
    }

    for (const attribute of [...element.attributes]) {
      if (!allowed.has(attribute.name)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function findInteractiveElements(document: Document): InteractiveElement[] {
  return [...document.querySelectorAll('article section[id]')]
    .filter(
      (element) =>
        element.classList.contains('not-prose') &&
        Boolean(element.querySelector('button, canvas, svg, video, [data-interactive]')),
    )
    .map((element) => {
      const captionElement = [...element.children].reverse().find((child) => {
        const tagName = child.tagName.toLowerCase();
        const className = String(child.getAttribute('class') ?? '');
        const text = normalizeText(child.textContent ?? '');
        return (
          text.length >= 30 &&
          text.length <= 1_000 &&
          !child.querySelector('button, canvas, svg, video, [data-interactive]') &&
          (tagName === 'figcaption' || /caption|border-t|text-(?:gray|grey|muted|slate|neutral|zinc)/i.test(className))
        );
      });

      return {
        elementId: element.id,
        caption: captionElement ? normalizeText(captionElement.textContent ?? '') : '',
      };
    });
}

function replaceInteractiveElements(
  contentHtml: string,
  screenshots: InteractiveScreenshot[],
): string {
  if (screenshots.length === 0) {
    return contentHtml;
  }

  const dom = new JSDOM(`<!doctype html><main id="article">${contentHtml}</main>`);
  const { document } = dom.window;
  for (const screenshot of screenshots) {
    const element = document.getElementById(screenshot.elementId);
    if (!element) {
      continue;
    }

    const image = document.createElement('img');
    image.setAttribute('src', screenshot.imageSource);
    image.setAttribute('alt', screenshot.alt);
    image.setAttribute('data-print-screenshot', 'true');

    if (!screenshot.caption) {
      element.replaceWith(image);
      continue;
    }

    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption');
    caption.textContent = screenshot.caption;
    figure.append(image, caption);
    element.replaceWith(figure);
  }

  return document.querySelector('#article')?.innerHTML ?? contentHtml;
}

function findArticleContentCandidate(document: Document): ArticleContentCandidate | null {
  const selectors = [
    '[itemprop="articleBody"]',
    '[data-article-body]',
    '#article-body',
    '#html-blog',
    '.article-body',
    '.article-content',
    '.blog-post-content',
    '.entry-content',
    '.post-content',
    'article',
    'main',
  ];
  const candidates = new Set<Element>();

  for (const selector of selectors) {
    for (const element of [...document.querySelectorAll(selector)]) {
      candidates.add(element);
    }
  }

  let best: ArticleContentCandidate | null = null;
  for (const element of candidates) {
    const clone = element.cloneNode(true) as Element;
    for (const dropped of [...clone.querySelectorAll(DROP_SELECTORS)]) {
      dropped.remove();
    }

    const textLength = normalizeText(textForHash(clone)).length;
    const paragraphCount = clone.querySelectorAll('p').length;
    if (textLength < 500 || paragraphCount < 3 || (best && textLength <= best.textLength)) {
      continue;
    }

    best = { html: element.innerHTML, textLength };
  }

  return best;
}

function cleanArticleContent(
  contentHtml: string,
  sourceUrl: string,
  published: string,
): CleanedArticleContent {
  const dom = new JSDOM(`<!doctype html><main id="article">${contentHtml}</main>`, { url: sourceUrl });
  const { document } = dom.window;

  replaceHighlightBlocks(document);
  normalizeInlineFormatting(document);
  normalizeTables(document);

  for (const element of [...document.querySelectorAll(DROP_SELECTORS)]) {
    element.remove();
  }

  removeArticleFurniture(document, published);
  wrapStandaloneCodeBlocks(document);
  cleanCodeBlocks(document);
  cleanLinks(document, sourceUrl);
  removeAlternateThemeImages(document);
  cleanImages(document, sourceUrl);
  stripAttributes(document);

  const article = document.querySelector('#article');
  if (!article) {
    throw new Error('Could not build article DOM');
  }

  return { html: article.innerHTML.trim(), text: normalizeText(textForHash(article)) };
}

function fenceFor(source: string): string {
  const runs = source.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function htmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function htmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function createTurndown(): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    bulletListMarker: '-',
  });

  turndown.use(gfm);

  turndown.addRule('preservePrintScreenshotsAsHtml', {
    filter(node) {
      return node.nodeName === 'IMG' && (node.getAttribute('src') ?? '').startsWith('../../screenshots/');
    },
    replacement(_content, node) {
      const source = htmlAttribute(node.getAttribute('src') ?? '');
      const alt = htmlAttribute(node.getAttribute('alt') ?? 'Interactive figure');
      return `\n\n<img class="interactive-screenshot" src="${source}" alt="${alt}">\n\n`;
    },
  });

  turndown.addRule('preserveInteractiveFiguresAsHtml', {
    filter(node) {
      const image = node.querySelector('img');
      return (
        node.nodeName === 'FIGURE' &&
        Boolean(image && (image.getAttribute('src') ?? '').startsWith('../../screenshots/'))
      );
    },
    replacement(_content, node) {
      const image = node.querySelector('img');
      if (!image) {
        return '';
      }

      const source = htmlAttribute(image.getAttribute('src') ?? '');
      const alt = htmlAttribute(image.getAttribute('alt') ?? 'Interactive figure');
      const caption = htmlText(normalizeText(node.querySelector('figcaption')?.textContent ?? ''));
      return `\n\n<figure class="interactive-figure"><img class="interactive-screenshot" src="${source}" alt="${alt}"><figcaption>${caption}</figcaption></figure>\n\n`;
    },
  });

  turndown.addRule('preserveImageFiguresAsHtml', {
    filter(node) {
      const image = node.querySelector('img');
      const caption = node.querySelector('figcaption');
      return (
        node.nodeName === 'FIGURE' &&
        Boolean(image && caption) &&
        !(image?.getAttribute('src') ?? '').startsWith('../../screenshots/')
      );
    },
    replacement(_content, node) {
      const figure = node.cloneNode(true) as Element;
      figure.className = 'article-figure';
      return `\n\n${figure.outerHTML}\n\n`;
    },
  });

  turndown.addRule('preserveTablesAsHtml', {
    filter: 'table',
    replacement(_content, node) {
      return `\n\n${(node as Element).outerHTML}\n\n`;
    },
  });

  turndown.addRule('fencedCodeBlocksWithLanguage', {
    filter(node) {
      return node.nodeName === 'PRE' && node.firstElementChild?.nodeName === 'CODE';
    },
    replacement(_content, node) {
      const code = node.firstElementChild;
      if (!code) {
        return '';
      }

      const source = (code.textContent ?? '').replace(/\n$/, '');
      const language = getLanguage(code);
      const fence = fenceFor(source);
      return `\n\n${fence}${language}\n${source}\n${fence}\n\n`;
    },
  });

  return turndown;
}

function markdownFromHtml(contentHtml: string): string {
  return createTurndown()
    .turndown(contentHtml)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function comparisonText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function descriptionRepeatsOpening(description: string, contentHtml: string): boolean {
  const dom = new JSDOM(`<!doctype html><main>${contentHtml}</main>`);
  const opening = [...dom.window.document.querySelectorAll('p')]
    .map((paragraph) => normalizeText(paragraph.textContent ?? ''))
    .filter(Boolean)
    .slice(0, 3)
    .join(' ');
  const comparableDescription = comparisonText(description);
  const comparableOpening = comparisonText(opening);

  return Boolean(
    comparableDescription &&
      (comparableOpening === comparableDescription || comparableOpening.startsWith(`${comparableDescription} `)),
  );
}

function frontmatter(metadata: Record<string, MetadataValue>): string {
  return [
    '---',
    ...Object.entries(metadata)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `${key}: ${yamlScalar(value)}`),
    '---',
    '',
  ].join('\n');
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'irakli-reads/0.1',
      accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function captureInteractiveScreenshots(
  url: string,
  slug: string,
  interactiveElements: InteractiveElement[],
): Promise<InteractiveScreenshot[]> {
  if (interactiveElements.length === 0) {
    return [];
  }

  const outputDir = path.join('public', 'screenshots', slug);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  let browser: Browser | undefined;
  const screenshots: InteractiveScreenshot[] = [];
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: 1_200, height: 1_400 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    for (const [index, interactive] of interactiveElements.entries()) {
      const { elementId, caption } = interactive;
      const element = page.locator(`[id="${elementId}"]`).first();
      if ((await element.count()) === 0) {
        continue;
      }

      await element.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);

      const playback = element.getByRole('button', { name: /play|replay/i }).first();
      if ((await playback.count()) > 0 && (await playback.isVisible())) {
        await playback.click();
      }

      let previousText = '';
      let stableSamples = 0;
      for (let elapsed = 0; elapsed < 35_000; elapsed += 1_000) {
        await page.waitForTimeout(1_000);
        const currentText = normalizeText(await element.innerText());
        stableSamples = currentText === previousText ? stableSamples + 1 : 0;
        previousText = currentText;
        if (elapsed >= 4_000 && stableSamples >= 3) {
          break;
        }
      }

      if (caption) {
        await element.evaluate((root, expectedCaption) => {
          const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
          const captionElement = [...root.children]
            .reverse()
            .find((child) => normalize(child.textContent ?? '') === expectedCaption);
          if (captionElement instanceof HTMLElement) {
            captionElement.style.display = 'none';
          }
        }, caption);
      }

      const bounds = await element.boundingBox();
      if (!bounds || bounds.width < 300 || bounds.height < 120) {
        continue;
      }

      const label = normalizeText(await element.innerText()).slice(0, 120);
      const fileName = `interactive-${String(index + 1).padStart(2, '0')}.png`;
      await element.screenshot({
        path: path.join(outputDir, fileName),
        animations: 'disabled',
      });
      screenshots.push({
        elementId,
        caption,
        imageSource: `../../screenshots/${slug}/${fileName}`,
        alt: label ? `Interactive figure: ${label}` : `Interactive figure ${index + 1}`,
      });
    }

    await page.close();
  } catch (error: unknown) {
    console.warn(`Could not capture interactive elements: ${errorMessage(error)}`);
  } finally {
    await browser?.close();
  }

  return screenshots;
}

function articleParagraphSamples(contentHtml: string): string[] {
  const dom = new JSDOM(`<!doctype html><main>${contentHtml}</main>`);

  return [...dom.window.document.querySelectorAll('p')]
    .map((paragraph) => normalizeText(paragraph.textContent ?? ''))
    .filter((text) => text.length >= 80)
    .sort((left, right) => right.length - left.length)
    .slice(0, 12);
}

function classifyFontFamily(fontFamily: string): SourceFontStyle | null {
  const families = fontFamily
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean);

  for (const family of families) {
    if (
      family === 'sans-serif' ||
      family === 'ui-sans-serif' ||
      family === 'system-ui' ||
      /(^|[\s-])(sans|grotesk|grotesque)([\s-]|$)/.test(family) ||
      /sans$/.test(family) ||
      /^(arial|helvetica|inter|roboto|verdana|tahoma|trebuchet ms|segoe ui|calibri|avenir|futura)$/.test(family)
    ) {
      return 'sans-serif';
    }

    if (
      family === 'serif' ||
      family === 'ui-serif' ||
      /(^|[\s-])serif([\s-]|$)/.test(family) ||
      /serif$/.test(family) ||
      /^(georgia|cambria|charter|garamond|baskerville|palatino|times|times new roman|merriweather|literata|lora)$/.test(family)
    ) {
      return 'serif';
    }
  }

  return null;
}

function chooseSourceFontStyle(samples: FontFamilySample[]): SourceFontStyle {
  const weights: Record<SourceFontStyle, number> = { serif: 0, 'sans-serif': 0 };

  for (const sample of samples) {
    const style = classifyFontFamily(sample.fontFamily);
    if (style) {
      weights[style] += Math.min(sample.textLength, 1_000);
    }
  }

  return weights['sans-serif'] > weights.serif ? 'sans-serif' : 'serif';
}

async function collectFontFamilySamples(browser: Browser, url: string, articleSamples: string[]): Promise<FontFamilySample[]> {
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);

    return await page.evaluate((expectedParagraphs) => {
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      const expectedPrefixes = expectedParagraphs.map((text) => text.slice(0, 160));
      const visibleParagraphs = [...document.querySelectorAll('p')].filter((paragraph) => {
        const style = getComputedStyle(paragraph);
        const text = normalize(paragraph.textContent ?? '');
        return text.length >= 40 && style.display !== 'none' && style.visibility !== 'hidden';
      });

      let candidates = visibleParagraphs.filter((paragraph) => {
        const text = normalize(paragraph.textContent ?? '');
        return expectedPrefixes.some((prefix) => text.includes(prefix));
      });

      if (candidates.length === 0) {
        const selectors = ['article p', '[role="article"] p', 'main p', '[role="main"] p', 'body p'];
        for (const selector of selectors) {
          candidates = visibleParagraphs.filter((paragraph) => paragraph.matches(selector));
          if (candidates.length > 0) {
            break;
          }
        }
      }

      return candidates
        .map((paragraph) => ({
          fontFamily: getComputedStyle(paragraph).fontFamily,
          textLength: normalize(paragraph.textContent ?? '').length,
        }))
        .sort((left, right) => right.textLength - left.textLength)
        .slice(0, 20);
    }, articleSamples);
  } finally {
    await page.close();
  }
}

async function detectSourceFontStyle(url: string, contentHtml: string): Promise<SourceFontStyle> {
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch();
    const samples = await collectFontFamilySamples(browser, url, articleParagraphSamples(contentHtml));
    return chooseSourceFontStyle(samples);
  } catch (error: unknown) {
    console.warn(`Could not detect source font style; using serif: ${errorMessage(error)}`);
    return 'serif';
  } finally {
    await browser?.close();
  }
}

async function saveOptionalFile(filePath: string | undefined, contents: string): Promise<void> {
  if (!filePath || filePath === 'true') {
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const inputUrl = positional[0];

  if (!inputUrl || flags.has('help')) {
    usage();
    process.exit(inputUrl ? 0 : 1);
  }

  const imageScalePercent = parseImageScale(flags.get('image-scale'));
  const rawHtml = await fetchHtml(inputUrl);
  const sourceDom = new JSDOM(rawHtml, { url: inputUrl });
  const { document } = sourceDom.window;
  const sourceUrl = canonicalUrl(document, inputUrl);
  const fallbackTitle = meta(document, 'meta[property="og:title"]') || document.title;
  const fallbackAuthor = meta(document, 'meta[name="author"]') || siteIdentityAuthor(document, sourceUrl);
  const metadataDescription =
    meta(document, 'meta[name="description"]') ||
    meta(document, 'meta[property="og:description"]') ||
    meta(document, 'meta[name="twitter:description"]');
  const fallbackDate = publishedDate(document);

  const contentCandidate = findArticleContentCandidate(document);
  const interactiveElements = findInteractiveElements(document);
  const reader = new Readability(document, { keepClasses: true });
  const article = reader.parse();
  if (!article?.content) {
    throw new Error('Readability could not extract article content');
  }

  const title = article.title || fallbackTitle || 'Untitled article';
  const slug = flags.get('slug') ?? slugify(title);
  const date = fallbackDate || isoDate(article.publishedTime ?? '');
  let contentHtml = article.content;
  let cleaned = cleanArticleContent(contentHtml, sourceUrl, date);
  if (contentCandidate) {
    const candidateCleaned = cleanArticleContent(contentCandidate.html, sourceUrl, date);
    if (candidateCleaned.text.length >= 1_200 && candidateCleaned.text.length > cleaned.text.length * 2) {
      contentHtml = contentCandidate.html;
      cleaned = candidateCleaned;
    }
  }

  const screenshots = await captureInteractiveScreenshots(inputUrl, slug, interactiveElements);
  if (screenshots.length > 0) {
    contentHtml = replaceInteractiveElements(contentHtml, screenshots);
    cleaned = cleanArticleContent(contentHtml, sourceUrl, date);
  }

  const sourceFontStyle = await detectSourceFontStyle(inputUrl, contentHtml);
  const outputDir = flags.get('out') ?? 'articles';
  const outputPath = path.join(outputDir, `${slug}.md`);
  const author = article.byline || fallbackAuthor;
  const candidateDescription = metadataDescription || article.excerpt || '';
  const descriptionIsByline = isBylineText(candidateDescription);
  const descriptionMatchesTitle = comparisonText(candidateDescription) === comparisonText(title);
  const description =
    descriptionIsByline ||
    descriptionMatchesTitle ||
    descriptionRepeatsOpening(candidateDescription, cleaned.html)
      ? ''
      : candidateDescription;
  const body = markdownFromHtml(cleaned.html);
  const bodyFontSizeAdjustment = flags.has('smaller-body-font') ? -1 : undefined;

  const metadata = {
    title,
    slug,
    source: sourceUrl,
    author,
    date: date.slice(0, 10) || date,
    description,
    sourceFontStyle,
    bodyFontSizeAdjustment,
    imageScalePercent,
    pageNumbers: true,
    sourceTextHash: sha256(cleaned.text),
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, `${frontmatter(metadata)}${body}\n`, 'utf8');

  await saveOptionalFile(flags.get('save-html'), rawHtml);
  await saveOptionalFile(flags.get('save-clean-html'), cleaned.html);
  await saveOptionalFile(flags.get('save-text'), cleaned.text);

  console.log(`Wrote ${outputPath}`);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
