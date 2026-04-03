import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface ScrapedModelData {
  url: string;
  title: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  siteName: string | null;
}

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
          'User-Agent': 'Mozilla/5.0 (compatible; PrintForge/1.0)',
          'Accept': 'text/html',
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

    // Get title from og:title, then <title> tag as fallback
    let title = getMeta('og:title');
    if (!title) {
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) title = this.decodeHtmlEntities(titleMatch[1].trim());
    }

    const description = getMeta('og:description') || getMeta('description');
    const thumbnailUrl = getMeta('og:image') || getMeta('twitter:image');
    const siteName = getMeta('og:site_name') || this.detectSiteName(new URL(url).hostname);

    return { url, title, description, thumbnailUrl, siteName };
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
      .replace(/&#x27;/g, "'");
  }
}
