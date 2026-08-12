import fs from 'node:fs';
import { load } from 'cheerio';

interface PageResult {
  url: string;
  title: string;
  content: string;
  wordCount: number;
}

interface FetchResult {
  html: string;
  title: string;
  content: string;
  wordCount: number;
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    return u.href.replace(/\/$/, '');
  } catch {
    return raw;
  }
}

const SKIP_URL_PATTERNS: RegExp[] = [
  /^#/,
  /^mailto:/,
  /^tel:/,
  /^javascript:/,
  /\/wp-admin\//i,
  /\/wp-json\//i,
  /\/wp-content\//i,
  /\/xmlrpc\.php/i,
  /\/feed\/?$/i,
  /\/feed\//i,
  /\.xml(\?|$)/i,
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|mp4|mp3|zip|css|js)(\?|$)/i,
  /oembed/i,
  /sitemap/i,
  /\/(login|logout|register|signup|cart|checkout|account)\b/i,
];

const SOCIAL_DOMAINS: string[] = [
  'facebook.com',
  'twitter.com',
  'instagram.com',
  'linkedin.com',
  'youtube.com',
  'tiktok.com',
];

const UI_NOISE_STRINGS = new Set<string>([
  'open chat',
  'shopping basket',
  'dejanos tu consulta',
  'whatsapp',
  'ver más',
  'ver mas',
  'contactanos',
  'contáctanos',
  'hablemos',
  'read more',
  'learn more',
  'click here',
  'view more',
  'see more',
  'load more',
  'show more',
  'back to top',
  'scroll to top',
  'accept',
  'accept all',
  'reject',
  'reject all',
  'close',
  'dismiss',
  'ok',
  'okay',
  'cancel',
  'submit',
  'send',
  'subscribe',
  'sign up',
  'log in',
  'login',
  'sign in',
  'register',
  'privacy policy',
  'terms of service',
  'terms and conditions',
  'cookie policy',
  'all rights reserved',
  'follow us',
  'share',
  'like',
  'tweet',
  'pin it',
  'previous',
  'next',
  '«',
  '»',
  '‹',
  '›',
]);

/**
 * Text extraction and website crawling, from the production engine.
 *
 * Four changes, all of them structural:
 *   - CommonJS `require` swapped for dynamic `import` (this package is ESM)
 *   - `fs` imported as `node:fs`
 *   - the crawler User-Agent renamed off the original product's internal name
 *   - three methods marked `@deprecated` in the original were dropped
 *
 * Every extraction, cleaning and deduplication rule is unchanged.
 */
export class TextExtractionUtil {
  /**
   * Extract text from file based on MIME type.
   */
  static async extractText(
    filePath: string,
    mimeType: string,
  ): Promise<string> {
    switch (mimeType) {
      case 'text/plain':
        return TextExtractionUtil.extractFromTxt(filePath);
      case 'application/pdf':
        return TextExtractionUtil.extractFromPdf(filePath);
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return TextExtractionUtil.extractFromDocx(filePath);
      default:
        throw new Error(`Unsupported file type: ${mimeType}`);
    }
  }

  private static async extractFromTxt(filePath: string): Promise<string> {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read text file: ${(error as Error).message}`);
    }
  }

  private static async extractFromPdf(filePath: string): Promise<string> {
    try {
      const { PDFExtract } = await import('pdf.js-extract');
      const pdfExtract = new PDFExtract();
      const data = await pdfExtract.extract(filePath, {});

      interface PdfPage {
        content: Array<{ str: string }>;
      }

      return (data.pages as PdfPage[])
        .map((page) => page.content.map((item) => item.str).join(' '))
        .join('\n\n');
    } catch (error) {
      throw new Error(
        `Failed to extract text from PDF: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private static async extractFromDocx(filePath: string): Promise<string> {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value as string;
    } catch (error) {
      throw new Error(
        `Failed to extract text from DOCX: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Single-page URL extraction (used by legacy callers).
   */
  static async extractFromUrl(url: string): Promise<string> {
    const result = await TextExtractionUtil.fetchAndParse(url);
    return result.content;
  }

  /**
   * Crawl a website using a BFS queue: start URL + all discovered internal links
   * up to maxPages. Uses Cheerio for proper HTML parsing.
   */
  static async crawlWebsite(
    startUrl: string,
    maxPages = 20,
    onProgress?: (current: number, total: number) => void,
  ): Promise<Array<{ url: string; title: string; content: string }>> {
    const visited = new Set<string>([normalizeUrl(startUrl)]);
    const queue: string[] = [startUrl];
    const raw: PageResult[] = [];

    while (queue.length > 0 && raw.length < maxPages) {
      const url = queue.shift() as string;

      try {
        const fetched = await TextExtractionUtil.fetchAndParse(url);

        if (fetched.wordCount >= 20) {
          raw.push({
            url,
            title: fetched.title,
            content: fetched.content,
            wordCount: fetched.wordCount,
          });
        }

        onProgress?.(
          raw.length,
          Math.min(visited.size + queue.length, maxPages),
        );

        // Discover internal links from every page we visit
        const links = TextExtractionUtil.extractLinks(fetched.html, url);
        for (const link of links) {
          const normalized = normalizeUrl(link);
          if (!visited.has(normalized)) {
            visited.add(normalized);
            queue.push(link);
          }
        }
      } catch {
        // Skip failed or non-HTML pages silently
      }
    }

    const deduplicated = TextExtractionUtil.deduplicatePages(raw);
    return deduplicated.map(({ url, title, content }) => ({
      url,
      title,
      content,
    }));
  }

  /**
   * Fetch a URL, parse with Cheerio, strip noise, and return clean text.
   * Throws if the response is JSON/XML (non-HTML).
   */
  static async fetchAndParse(url: string): Promise<FetchResult> {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContextBot/1.0)' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (
      contentType.includes('application/json') ||
      contentType.includes('text/xml') ||
      contentType.includes('application/xml') ||
      contentType.includes('application/rss')
    ) {
      throw new Error(`Skipping non-HTML response (${contentType}) for ${url}`);
    }

    const html = await response.text();

    // Detect JSON body even when content-type header is wrong
    const trimmed = html.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      throw new Error(`Skipping JSON body for ${url}`);
    }

    const $ = load(html);

    // Extract title before stripping
    const title = $('title').first().text().trim().replace(/\s+/g, ' ') || url;

    // ── Step 1: Remove noisy elements by tag (safe, always correct) ──────────
    $('script, style, noscript, iframe').remove();
    $('nav, header, footer').remove();

    // ── Step 2: Remove ONLY specific, safe class patterns ────────────────────
    // Avoid broad patterns like "widget", "ad", "menu" which match page-builder
    // content on Elementor / Divi / Beaver Builder sites.
    const SAFE_NOISY_PATTERNS = [
      'cookie',
      'breadcrumb',
      'pagination',
      'whatsapp',
      'chat-button',
      'chatbot',
    ];
    for (const pattern of SAFE_NOISY_PATTERNS) {
      $(`[class*="${pattern}"], [id*="${pattern}"]`).remove();
    }

    // Remove aria-hidden decorative elements
    $('[aria-hidden="true"]').remove();

    // ── Step 3: Extract text from semantic content elements ───────────────────
    // This works for both traditional HTML and page builders (Elementor, Divi)
    // because actual content always ends up in p / h* / li / td tags regardless
    // of how many wrapper divs surround it.
    const CONTENT_SELECTORS =
      'h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote, figcaption, dt, dd';
    const lines: string[] = [];

    $(CONTENT_SELECTORS).each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      if (text.length >= 10) {
        lines.push(text);
      }
    });

    // Fallback: if semantic extraction yielded nothing, use full body text
    const rawText = lines.length >= 5 ? lines.join('\n') : $('body').text();

    const content = TextExtractionUtil.cleanText(rawText);
    const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;

    return { html, title, content, wordCount };
  }

  /**
   * Extract all internal same-domain links from HTML using Cheerio.
   */
  static extractLinks(html: string, baseUrl: string): string[] {
    const base = new URL(baseUrl);
    const $ = load(html);
    const links: string[] = [];
    const seen = new Set<string>();

    $('a[href]').each((_, el) => {
      const raw = $(el).attr('href');
      if (!raw) return;

      const href = raw.trim();
      if (SKIP_URL_PATTERNS.some((p) => p.test(href))) return;

      let resolved: URL;
      try {
        resolved = new URL(href, baseUrl);
      } catch {
        return;
      }

      if (resolved.hostname !== base.hostname) return;
      if (SOCIAL_DOMAINS.some((d) => resolved.hostname.includes(d))) return;

      // Reject known noisy resolved paths
      if (SKIP_URL_PATTERNS.some((p) => p.test(resolved.pathname))) return;

      resolved.hash = '';
      const normalized = resolved.href.replace(/\/$/, '');

      if (!seen.has(normalized)) {
        seen.add(normalized);
        links.push(normalized);
      }
    });

    return links;
  }

  /**
   * Post-extraction text cleaning:
   * - Remove short lines (<20 chars)
   * - Remove pure punctuation / number-only lines
   * - Remove URL-like lines
   * - Remove known UI noise strings
   * - Normalize weird casing (e.g. "SupERFICIE" → "Superficie")
   * - Deduplicate identical lines
   * - Collapse excess blank lines
   */
  static cleanText(text: string): string {
    const URL_LIKE = /^(https?:\/\/|www\.)\S+$/i;
    const PURE_PUNCT_OR_NUM = /^[\d\s\W]+$/u;
    const seen = new Set<string>();

    const lines = text
      .split(/[\n\r]+/)
      .map((l) => l.trim())
      .map((l) => TextExtractionUtil.normalizeWeirdCasing(l))
      .filter((l) => {
        if (l.length < 10) return false;
        if (PURE_PUNCT_OR_NUM.test(l)) return false;
        if (URL_LIKE.test(l)) return false;
        if (UI_NOISE_STRINGS.has(l.toLowerCase())) return false;
        if (seen.has(l)) return false;
        seen.add(l);
        return true;
      });

    return lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Normalize weirdly-cased words (e.g. "SupERFICIE" → "Superficie").
   * Words with 4+ chars that have both lower and upper letters and contain
   * 2+ uppercase letters after position 0 are converted to title case.
   * Preserves all-caps acronyms (HTML, PDF, API, etc.).
   */
  private static normalizeWeirdCasing(text: string): string {
    return text.replace(/\b[A-Za-záéíóúñüÁÉÍÓÚÑÜ]{4,}\b/g, (word) => {
      const hasLower = /[a-záéíóúñü]/.test(word);
      const upperAfterFirst = (word.slice(1).match(/[A-ZÁÉÍÓÚÑÜ]/g) ?? [])
        .length;
      if (hasLower && upperAfterFirst >= 2) {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }
      return word;
    });
  }

  /**
   * Remove pages with >80% content overlap (Jaccard similarity on word sets).
   */
  private static deduplicatePages(pages: PageResult[]): PageResult[] {
    const wordSet = (text: string): Set<string> =>
      new Set(
        text
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3),
      );

    const kept: PageResult[] = [];

    for (const page of pages) {
      const pageWords = wordSet(page.content);
      let isDuplicate = false;

      for (const existing of kept) {
        const existingWords = wordSet(existing.content);
        const intersection = [...pageWords].filter((w) =>
          existingWords.has(w),
        ).length;
        const union = new Set([...pageWords, ...existingWords]).size;
        const similarity = union > 0 ? intersection / union : 0;

        if (similarity > 0.8) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate) {
        kept.push(page);
      }
    }

    return kept;
  }
}
