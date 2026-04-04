import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ScrapedModelData } from '@printforge/types';

const ALLOWED_HOSTS = [
  'makerworld.com', 'www.makerworld.com',
  'thangs.com', 'www.thangs.com',
  'thingiverse.com', 'www.thingiverse.com',
  'printables.com', 'www.printables.com',
  'myminifactory.com', 'www.myminifactory.com',
  'cults3d.com', 'www.cults3d.com',
];

@Injectable()
export class UrlScraperService {
  private readonly logger = new Logger(UrlScraperService.name);

  async scrapeModelUrl(url: string): Promise<ScrapedModelData> {
    // Validate URL
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('Invalid URL');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new BadRequestException('Only HTTP/HTTPS URLs are allowed');
    }

    const isAllowed = ALLOWED_HOSTS.some(host => parsed.hostname === host);
    if (!isAllowed) {
      throw new BadRequestException(
        `URL must be from a supported site: ${ALLOWED_HOSTS.filter(h => !h.startsWith('www.')).join(', ')}`,
      );
    }

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      return this.parseOgMeta(url, html);
    } catch (error: any) {
      this.logger.warn(`Failed to scrape ${url}: ${error.message}`);
      // Return partial data even on failure
      return {
        url,
        title: null,
        description: null,
        thumbnailUrl: null,
        siteName: this.detectSiteName(parsed.hostname),
      };
    }
  }

  private parseOgMeta(url: string, html: string): ScrapedModelData {
    const getMeta = (property: string): string | null => {
      // Match og: and twitter: meta tags
      const patterns = [
        new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
        new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, 'i'),
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) return this.decodeHtmlEntities(match[1]);
      }
      return null;
    };

    const hostname = new URL(url).hostname;

    // Get title from og:title, then <title> tag, then <h1> as fallback
    let title = getMeta('og:title');
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) {
        const raw = this.decodeHtmlEntities(titleMatch[1].trim());
        // Skip generic site-only titles (e.g. just "Printables" or "Thangs")
        const generic = ['printables', 'thangs', 'thingiverse', 'makerworld', 'cults3d', 'myminifactory'];
        if (!generic.includes(raw.toLowerCase())) {
          title = raw;
        }
      }
    }
    if (!title) {
      const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (h1Match) title = this.decodeHtmlEntities(h1Match[1].trim());
    }

    const description = getMeta('og:description') || getMeta('description');
    const thumbnailUrl = getMeta('og:image') || getMeta('twitter:image');
    const siteName = getMeta('og:site_name') || this.detectSiteName(hostname);

    // Paywall / paid model detection
    const isPaid = this.detectPaywall(html, hostname);

    return { url, title, description, thumbnailUrl, siteName, isPaid: isPaid || undefined };
  }

  private detectSiteName(hostname: string): string | null {
    if (hostname.includes('makerworld')) return 'MakerWorld';
    if (hostname.includes('thangs')) return 'Thangs';
    if (hostname.includes('thingiverse')) return 'Thingiverse';
    if (hostname.includes('printables')) return 'Printables';
    if (hostname.includes('myminifactory')) return 'MyMiniFactory';
    if (hostname.includes('cults3d')) return 'Cults3D';
    return null;
  }

  private decodeHtmlEntities(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      // Numeric decimal entities: &#NNN;
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      // Hex entities: &#xHHHH;
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
  }

  private detectPaywall(html: string, hostname: string): boolean {
    // Cults3D: JSON-LD price or class="price" patterns
    if (hostname.includes('cults3d')) {
      if (/"price"\s*:\s*"?[1-9]/.test(html)) return true;
      if (/class=["'][^"']*price[^"']*["'][^>]*>[^<]*[1-9]/.test(html)) return true;
    }

    // MyMiniFactory: purchase / premium markers
    if (hostname.includes('myminifactory')) {
      if (/class=["'][^"']*premium[^"']*["']/i.test(html)) return true;
      if (/"purchase"|"buy\s+now"|"add\s+to\s+cart"/i.test(html)) return true;
    }

    // Generic: JSON-LD with non-zero price
    const jsonLdPriceMatch = html.match(/"price"\s*:\s*"?(\d+\.?\d*)"/);
    if (jsonLdPriceMatch && parseFloat(jsonLdPriceMatch[1]) > 0) return true;

    // Generic: currency patterns near download areas ($/EUR/GBP amounts > 0)
    const currencyPattern = /(?:\$|€|£|USD|EUR|GBP)\s*(\d+(?:\.\d{1,2})?)/g;
    let match: RegExpExecArray | null;
    while ((match = currencyPattern.exec(html)) !== null) {
      if (parseFloat(match[1]) > 0) {
        // Check if it's near download-related content (within 500 chars)
        const start = Math.max(0, match.index - 500);
        const context = html.substring(start, match.index + 500).toLowerCase();
        if (/download|buy|purchase|cart|checkout/i.test(context)) return true;
      }
    }

    return false;
  }
}
