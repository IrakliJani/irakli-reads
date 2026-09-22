#!/usr/bin/env node
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { chromium, type Browser, type Page } from 'playwright';
import { articleSlug, errorMessage, parseFrontmatter } from './shared.ts';

interface ArticleRef {
  slug: string;
  articlePath: string;
}

async function findArticles(requestedSlugs: ReadonlySet<string>): Promise<ArticleRef[]> {
  const entries = await readdir('articles', { withFileTypes: true });
  const articles: ArticleRef[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }

    const articlePath = path.join('articles', entry.name);
    const markdown = await readFile(articlePath, 'utf8');
    const metadata = parseFrontmatter(markdown);
    const slug = articleSlug(articlePath, metadata);

    if (requestedSlugs.size > 0 && !requestedSlugs.has(slug)) {
      continue;
    }

    articles.push({ slug, articlePath });
  }

  return articles.sort((left, right) => left.slug.localeCompare(right.slug));
}

async function assertFileExists(filePath: string, hint: string): Promise<void> {
  try {
    await access(filePath);
  } catch {
    throw new Error(`Missing ${filePath}. ${hint}`);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

async function startDistServer(): Promise<{ server: Server; origin: string }> {
  const root = path.resolve('dist');
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const relativePath = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
      const filePath = path.resolve(root, `.${relativePath}`);
      if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }

      const contents = await readFile(filePath);
      response.setHeader('content-type', CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream');
      response.writeHead(200).end(contents);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function renderPdf(page: Page, slug: string, origin: string): Promise<void> {
  const htmlPath = path.join('dist', 'read', slug, 'index.html');
  await assertFileExists(htmlPath, 'Run `pnpm article:render` first.');

  const outputPath = path.join('pdfs', `${slug}.pdf`);
  await mkdir(path.dirname(outputPath), { recursive: true });

  await page.goto(`${origin}/read/${encodeURIComponent(slug)}/`, { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });
  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });

  console.log(`Wrote ${outputPath}`);
}

async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (error: unknown) {
    const message = errorMessage(error);
    if (message.includes("Executable doesn't exist") || message.includes('browserType.launch')) {
      throw new Error(`Chromium is not installed for Playwright. Run:\n  pnpm article:install-browser\n\n${message}`);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const requestedSlugs = new Set(process.argv.slice(2));
  const articles = await findArticles(requestedSlugs);

  if (articles.length === 0) {
    const qualifier = requestedSlugs.size > 0 ? ` matching ${[...requestedSlugs].join(', ')}` : '';
    throw new Error(`No articles${qualifier} found.`);
  }

  const { server, origin } = await startDistServer();
  try {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 1400 } });
      for (const article of articles) {
        await renderPdf(page, article.slug, origin);
      }
      await page.close();
    } finally {
      await browser.close();
    }
  } finally {
    await stopServer(server);
  }
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exit(1);
});
