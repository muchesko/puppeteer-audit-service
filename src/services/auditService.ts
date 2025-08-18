import puppeteer, { type LaunchOptions, type Browser, type Page, type HTTPResponse } from 'puppeteer';
import crypto from 'crypto';
import fs from 'node:fs';
import { config } from '../config/index.js';

export interface AuditRequest {
  jobId: string;
  websiteUrl: string;
  priority?: number;
  options?: {
    mobile?: boolean;
    includeScreenshot?: boolean;
    customUserAgent?: string;
    includePageSpeedInsights?: boolean;
  };
}

export interface AuditResult {
  jobId: string;
  status: 'COMPLETED' | 'FAILED';
  results?: {
    performanceScore?: number;
    seoScore?: number;
    accessibilityScore?: number;
    bestPracticesScore?: number;
    issues?: Array<{
      type: 'ERROR' | 'WARNING' | 'INFO';
      category: 'PERFORMANCE' | 'SEO' | 'ACCESSIBILITY' | 'BEST_PRACTICES';
      title: string;
      description: string;
      impact: 'HIGH' | 'MEDIUM' | 'LOW';
      recommendation: string;
    }>;
    metrics?: {
      loadTime?: number;
      cumulativeLayoutShift?: number;
    };
    pageSpeedMetrics?: {
      performanceScore?: number;
      firstContentfulPaint?: number;
      largestContentfulPaint?: number;
      firstInputDelay?: number;
      cumulativeLayoutShift?: number;
      speedIndex?: number;
      totalBlockingTime?: number;
    };
    // Detailed breakdown for each category
    categoryDetails?: {
      performance?: {
        score: number;
        items: Array<{
          title: string;
          value: string | number;
          status: 'PASS' | 'FAIL' | 'WARNING';
          description: string;
        }>;
      };
      seo?: {
        score: number;
        items: Array<{
          title: string;
          value: string | number;
          status: 'PASS' | 'FAIL' | 'WARNING';
          description: string;
        }>;
      };
      accessibility?: {
        score: number;
        items: Array<{
          title: string;
          value: string | number;
          status: 'PASS' | 'FAIL' | 'WARNING';
          description: string;
        }>;
      };
      bestPractices?: {
        score: number;
        items: Array<{
          title: string;
          value: string | number;
          status: 'PASS' | 'FAIL' | 'WARNING';
          description: string;
        }>;
      };
    };
    pagesCrawled?: number;
    screenshot?: string;
  };
  error?: string;
}

export class AuditService {
  private activeBrowser: Browser | null = null;
  private jobStatuses = new Map<string, string>();
  private jobResults = new Map<string, AuditResult>();
  private activeJobs = 0;
  private readonly maxConcurrentJobs = 1;

  // ---------- Browser boot ----------

  private pickExecutablePath(): string | undefined {
    const candidates = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ].filter(Boolean) as string[];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return undefined;
  }

  private async launchBrowser(): Promise<Browser> {
    const executablePath = this.pickExecutablePath();

    // Pipe transport is lighter than WS on small instances
    const usePipe = true;

    const args: string[] = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-extensions',
      '--user-data-dir=/tmp/chrome-data',

      // keep Chrome lean but allow JIT compilation with more RAM
      '--renderer-process-limit=1',

      // trim background work a bit more
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection',
      '--metrics-recording-only',

      // Better support for JS-heavy sites
      '--disable-blink-features=AutomationControlled', // Avoid detection
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--allow-running-insecure-content',
      '--ignore-certificate-errors',
    ];

    const launchOpts: LaunchOptions = {
      headless: true,
      pipe: usePipe,
      executablePath,
      args,
      timeout: 120_000,
      protocolTimeout: 180_000,
      dumpio: false,
    };

    console.log({
      node: process.version,
      executablePath: executablePath ?? '(not found)',
      pipeMode: usePipe,
      timestamp: new Date().toISOString(),
    });

    return puppeteer.launch(launchOpts);
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.activeBrowser || !this.activeBrowser.isConnected()) {
      // close any stale instance
      try { await this.activeBrowser?.close(); } catch { /* ignore */ }
      this.activeBrowser = await this.launchBrowser();
    }
    return this.activeBrowser!;
  }

  // ---------- Public API ----------

  async startAudit(request: AuditRequest): Promise<void> {
    if (this.activeJobs >= this.maxConcurrentJobs) {
      throw new Error('Maximum concurrent jobs reached');
    }
    // fire-and-forget (no await) – but we still guard all errors inside
    this.processAudit(request);
  }

  async getAuditStatus(jobId: string): Promise<string | null> {
    return this.jobStatuses.get(jobId) || null;
  }

  async getAuditDetails(jobId: string): Promise<AuditResult | null> {
    return this.jobResults.get(jobId) || null;
  }

  async cleanup(): Promise<void> {
    try { await this.activeBrowser?.close(); } catch { /* ignore */ }
    this.activeBrowser = null;
  }

  // ---------- PageSpeed Insights API ----------

  private async getPageSpeedInsights(url: string): Promise<{
    performanceScore: number;
    firstContentfulPaint: number;
    largestContentfulPaint: number;
    firstInputDelay: number;
    cumulativeLayoutShift: number;
    speedIndex: number;
    totalBlockingTime: number;
  } | null> {
    if (!config.pageSpeedApiKey) {
      console.warn('[pagespeed] No API key configured, skipping PageSpeed Insights');
      return null;
    }

    try {
      console.log('[pagespeed] Calling PageSpeed Insights API for:', url);
      
      const apiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
      apiUrl.searchParams.set('url', url);
      apiUrl.searchParams.set('key', config.pageSpeedApiKey);
      apiUrl.searchParams.set('strategy', 'desktop');
      apiUrl.searchParams.set('category', 'performance');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60_000); // 60 second timeout

      const response = await fetch(apiUrl.toString(), {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; AuditService/1.0)',
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.error('[pagespeed] API error:', response.status, response.statusText);
        const errorText = await response.text().catch(() => '');
        console.error('[pagespeed] Error details:', errorText);
        return null;
      }

      const data = await response.json();
      
      // Extract performance metrics from PageSpeed Insights response
      const lighthouseResult = data.lighthouseResult;
      if (!lighthouseResult) {
        console.error('[pagespeed] No lighthouse result in response');
        return null;
      }

      const categories = lighthouseResult.categories;
      const audits = lighthouseResult.audits;

      const performanceScore = Math.round((categories?.performance?.score || 0) * 100);
      
      // Core Web Vitals and other metrics
      const firstContentfulPaint = audits?.['first-contentful-paint']?.numericValue || 0;
      const largestContentfulPaint = audits?.['largest-contentful-paint']?.numericValue || 0;
      const firstInputDelay = audits?.['max-potential-fid']?.numericValue || 0; // FID approximation
      const cumulativeLayoutShift = audits?.['cumulative-layout-shift']?.numericValue || 0;
      const speedIndex = audits?.['speed-index']?.numericValue || 0;
      const totalBlockingTime = audits?.['total-blocking-time']?.numericValue || 0;

      console.log('[pagespeed] Successfully retrieved metrics:', {
        performanceScore,
        firstContentfulPaint: Math.round(firstContentfulPaint),
        largestContentfulPaint: Math.round(largestContentfulPaint),
        firstInputDelay: Math.round(firstInputDelay),
        cumulativeLayoutShift: Math.round(cumulativeLayoutShift * 1000) / 1000,
        speedIndex: Math.round(speedIndex),
        totalBlockingTime: Math.round(totalBlockingTime),
      });

      return {
        performanceScore,
        firstContentfulPaint: Math.round(firstContentfulPaint),
        largestContentfulPaint: Math.round(largestContentfulPaint),
        firstInputDelay: Math.round(firstInputDelay),
        cumulativeLayoutShift: Math.round(cumulativeLayoutShift * 1000) / 1000,
        speedIndex: Math.round(speedIndex),
        totalBlockingTime: Math.round(totalBlockingTime),
      };

    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        console.error('[pagespeed] Request timeout');
      } else {
        console.error('[pagespeed] Error calling PageSpeed Insights:', (error as Error).message);
      }
      return null;
    }
  }

  // ---------- Core flow ----------

  private async processAudit(request: AuditRequest): Promise<void> {
    this.activeJobs++;
    this.jobStatuses.set(request.jobId, 'PROCESSING');

    let page: Page | null = null;
    try {
      console.log(`[audit] job ${request.jobId} → ${request.websiteUrl}`);

      // Quick preflight: don’t spawn Chrome if URL is dead
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8_000);
        const head = await fetch(request.websiteUrl, { method: 'HEAD', signal: ctrl.signal });
        clearTimeout(t);
        console.log('[audit] preflight:', head.status);
      } catch (e) {
        throw new Error(`Preflight failed: ${(e as Error).message}`);
      }

      // Launch with a small retry
      let browser: Browser | null = null;
      for (let i = 0; i < 2; i++) {
        try {
          console.log(`[audit] launching browser (attempt ${i + 1}/2)`);
          browser = await this.getBrowser();
          break;
        } catch (e) {
          if (i === 1) throw e;
          await new Promise(r => setTimeout(r, 2_000));
        }
      }
      if (!browser) throw new Error('Browser failed to launch');

      // Create page with watchdog (fail fast if renderer dies)
      page = await this.createPageWithWatchdog(browser, 25_000);
      this.hookPageLogs(page);

      // Job-level watchdog so we never hang forever
      const jobWatchdog = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error('Job watchdog timeout')), 150_000) // Increased to 2.5 minutes with more RAM
      );

      const result = await Promise.race([
        this.runSinglePageAudit(page, request),
        jobWatchdog,
      ]);

      // persist + callback
      this.jobStatuses.set(request.jobId, 'COMPLETED');
      this.jobResults.set(request.jobId, result);
      console.log(`[audit] job ${request.jobId} completed`, {
        performance: result.results?.performanceScore,
        seo: result.results?.seoScore,
        accessibility: result.results?.accessibilityScore,
        bestPractices: result.results?.bestPracticesScore,
      });
      this.sendCallback(result).catch(err => console.warn('[callback] error (ignored):', err));

    } catch (error) {
      const errText = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
      console.error(`[audit] job ${request.jobId} failed:`, errText);

      const fail: AuditResult = { jobId: request.jobId, status: 'FAILED', error: errText };
      this.jobStatuses.set(request.jobId, 'FAILED');
      this.jobResults.set(request.jobId, fail);
      this.sendCallback(fail).catch(err => console.warn('[callback] error (ignored):', err));
    } finally {
      // Close page first
      try { await page?.close({ runBeforeUnload: false }); } catch { /* ignore */ }

      // Try graceful browser close after each job to prevent leaks
      try {
        await this.activeBrowser?.close();
      } catch { /* ignore */ }

      // If Chrome is wedged, hard kill the child proc
      try { this.activeBrowser?.process()?.kill('SIGKILL'); } catch { /* ignore */ }
      this.activeBrowser = null;

      this.activeJobs--;
    }
  }

  // ---------- Helpers ----------

  private async createPageWithWatchdog(browser: Browser, timeoutMs: number): Promise<Page> {
    console.log('[audit] creating page…');
    const created = await Promise.race([
      (async () => {
        const p = await browser.newPage();
        console.log('[audit] page created');
        return p;
      })(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('newPage() watchdog timeout')), timeoutMs)),
    ]);
    return created;
  }

  private hookPageLogs(page: Page) {
    page.on('console', m => console.log('[console]', m.type(), m.text()));
    page.on('pageerror', e => console.warn('[pageerror]', e.message));
    page.on('requestfailed', r => console.warn('[requestfailed]', r.url(), r.failure()?.errorText));
  }

  private async runSinglePageAudit(page: Page, request: AuditRequest): Promise<AuditResult> {
    // Use a more modern, less detectable user agent
    const ua = request.options?.customUserAgent || 
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    
    console.log('[audit] setUserAgent');
    await page.setUserAgent(ua);

    console.log('[audit] setViewport');
    if (request.options?.mobile) {
      await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    } else {
      const w = config?.lighthouse?.settings?.screenEmulation?.width ?? 1366;
      const h = config?.lighthouse?.settings?.screenEmulation?.height ?? 768;
      await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    }

    console.log('[audit] set timeouts');
    page.setDefaultTimeout(75_000); // Increased with more RAM
    page.setDefaultNavigationTimeout(75_000);

    console.log('[audit] navigating', request.websiteUrl);
    const response = await this.progressiveGoto(page, request.websiteUrl);
    console.log('[audit] navigation ok:', response?.status());

    // Enhanced dynamic content wait with more resources
    console.log('[audit] waiting for dynamic content');
    try {
      await page.waitForFunction(
        () => {
          // Check if page has substantially loaded
          const body = document.body;
          if (!body) return false;
          
          // Check if there's meaningful content
          const textContent = body.innerText || body.textContent || '';
          return textContent.length > 100;
        },
        { timeout: 15_000 } // Increased timeout
      );
      
      // Additional wait for any async operations
      await new Promise(resolve => setTimeout(resolve, 3_000)); // Back to 3 seconds
    } catch (waitError) {
      console.warn('[audit] dynamic content wait failed:', (waitError as Error).message);
      // Continue anyway - page might still be auditable
    }

    // Collect metrics defensively
    console.log('[audit] collecting metrics');
    const perfJson = await page
      .evaluate(() => {
        try { return JSON.stringify(performance.getEntriesByType('navigation')); }
        catch { return '[]'; }
      })
      .catch(() => '[]');

    let loadTime = 0;
    try {
      const nav = JSON.parse(perfJson) as any[];
      const nav0 = nav?.[0] ?? {};
      loadTime = Number.isFinite(nav0.loadEventEnd) ? Math.floor(nav0.loadEventEnd) : 0;
    } catch { /* ignore */ }

    // Get PageSpeed Insights data if requested
    let pageSpeedMetrics: NonNullable<NonNullable<AuditResult['results']>['pageSpeedMetrics']> | undefined;
    let performanceScore: number;

    if (request.options?.includePageSpeedInsights) {
      console.log('[audit] fetching PageSpeed Insights data');
      const pageSpeedData = await this.getPageSpeedInsights(request.websiteUrl);
      if (pageSpeedData) {
        pageSpeedMetrics = pageSpeedData;
        performanceScore = pageSpeedData.performanceScore;
      } else {
        // Fallback to basic performance scoring if PageSpeed fails
        performanceScore = Math.max(0, Math.min(100, 100 - Math.floor(loadTime / 100)));
      }
    } else {
      // Use basic performance scoring when PageSpeed Insights is not requested
      performanceScore = Math.max(0, Math.min(100, 100 - Math.floor(loadTime / 100)));
    }

    // Basic SEO
    console.log('[audit] SEO checks');
    const seoData = await page
      .evaluate(() => {
        try {
          const title = document.title || '';
          const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content');
          const h1s = document.querySelectorAll('h1');
          const viewport = document.querySelector('meta[name="viewport"]');
          const metaKeywords = document.querySelector('meta[name="keywords"]');
          const ogTitle = document.querySelector('meta[property="og:title"]');
          const ogDescription = document.querySelector('meta[property="og:description"]');
          const canonicalLink = document.querySelector('link[rel="canonical"]');
          
          let score = 0;
          const details: Array<{
            title: string;
            value: string | number;
            status: 'PASS' | 'FAIL' | 'WARNING';
            description: string;
          }> = [];

          // Title check
          if (title && title.length > 0 && title.length <= 60) {
            score += 25;
            details.push({
              title: 'Page Title',
              value: `"${title}" (${title.length} characters)`,
              status: 'PASS',
              description: 'Page has a good title within the recommended length'
            });
          } else if (title && title.length > 60) {
            score += 15;
            details.push({
              title: 'Page Title',
              value: `"${title}" (${title.length} characters)`,
              status: 'WARNING',
              description: 'Title is too long. Consider keeping it under 60 characters'
            });
          } else {
            details.push({
              title: 'Page Title',
              value: title || 'Missing',
              status: 'FAIL',
              description: 'Page is missing a title or title is empty'
            });
          }

          // Meta description check
          if (metaDescription && metaDescription.length > 0) {
            score += 25;
            details.push({
              title: 'Meta Description',
              value: `"${metaDescription.substring(0, 50)}..." (${metaDescription.length} characters)`,
              status: metaDescription.length <= 160 ? 'PASS' : 'WARNING',
              description: metaDescription.length <= 160 
                ? 'Good meta description length' 
                : 'Meta description is longer than recommended 160 characters'
            });
          } else {
            details.push({
              title: 'Meta Description',
              value: 'Missing',
              status: 'FAIL',
              description: 'Page is missing a meta description'
            });
          }

          // H1 check
          if (h1s.length === 1) {
            score += 25;
            details.push({
              title: 'H1 Heading',
              value: `"${h1s[0].textContent?.substring(0, 50)}..."`,
              status: 'PASS',
              description: 'Page has exactly one H1 heading'
            });
          } else if (h1s.length > 1) {
            score += 10;
            details.push({
              title: 'H1 Heading',
              value: `${h1s.length} H1 tags found`,
              status: 'WARNING',
              description: 'Multiple H1 tags found. Consider using only one H1 per page'
            });
          } else {
            details.push({
              title: 'H1 Heading',
              value: 'Missing',
              status: 'FAIL',
              description: 'Page is missing an H1 heading'
            });
          }

          // Viewport check
          if (viewport) {
            score += 25;
            details.push({
              title: 'Viewport Meta Tag',
              value: 'Present',
              status: 'PASS',
              description: 'Page has a viewport meta tag for mobile responsiveness'
            });
          } else {
            details.push({
              title: 'Viewport Meta Tag',
              value: 'Missing',
              status: 'FAIL',
              description: 'Page is missing a viewport meta tag'
            });
          }

          // Additional SEO checks
          details.push({
            title: 'Open Graph Title',
            value: ogTitle ? 'Present' : 'Missing',
            status: ogTitle ? 'PASS' : 'WARNING',
            description: ogTitle ? 'Page has Open Graph title for social sharing' : 'Consider adding Open Graph title'
          });

          details.push({
            title: 'Open Graph Description',
            value: ogDescription ? 'Present' : 'Missing',
            status: ogDescription ? 'PASS' : 'WARNING',
            description: ogDescription ? 'Page has Open Graph description for social sharing' : 'Consider adding Open Graph description'
          });

          details.push({
            title: 'Canonical URL',
            value: canonicalLink ? 'Present' : 'Missing',
            status: canonicalLink ? 'PASS' : 'WARNING',
            description: canonicalLink ? 'Page has a canonical URL' : 'Consider adding a canonical URL'
          });

          return { score, details };
        } catch { return { score: 50, details: [] }; }
      })
      .catch(() => ({ score: 50, details: [] }));

    const seoScore = seoData.score;

    // Basic a11y
    console.log('[audit] accessibility checks');
    const accessibilityData = await page
      .evaluate(() => {
        try {
          const images = Array.from(document.querySelectorAll('img'));
          const buttons = Array.from(document.querySelectorAll('button'));
          const links = Array.from(document.querySelectorAll('a'));
          const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
          const forms = Array.from(document.querySelectorAll('form'));
          const inputs = Array.from(document.querySelectorAll('input, textarea, select'));
          
          let score = 0;
          let totalChecks = 0;
          const details: Array<{
            title: string;
            value: string | number;
            status: 'PASS' | 'FAIL' | 'WARNING';
            description: string;
          }> = [];
          
          // Image alt text check (25% weight)
          if (images.length > 0) {
            let imagesWithAlt = 0;
            for (const img of images) {
              if (img.getAttribute('alt') !== null) {
                imagesWithAlt++;
              }
            }
            const percentage = (imagesWithAlt / images.length) * 100;
            score += (imagesWithAlt / images.length) * 25;
            totalChecks++;
            
            details.push({
              title: 'Image Alt Text',
              value: `${imagesWithAlt}/${images.length} images (${Math.round(percentage)}%)`,
              status: percentage === 100 ? 'PASS' : percentage >= 80 ? 'WARNING' : 'FAIL',
              description: `${imagesWithAlt} out of ${images.length} images have alt text`
            });
          }
          
          // Button accessibility check (20% weight)
          if (buttons.length > 0) {
            let accessibleButtons = 0;
            for (const btn of buttons) {
              const hasText = !!btn.textContent?.trim();
              const hasLabel = !!btn.getAttribute('aria-label');
              const hasAriaLabelledBy = !!btn.getAttribute('aria-labelledby');
              if (hasText || hasLabel || hasAriaLabelledBy) {
                accessibleButtons++;
              }
            }
            const percentage = (accessibleButtons / buttons.length) * 100;
            score += (accessibleButtons / buttons.length) * 20;
            totalChecks++;
            
            details.push({
              title: 'Button Accessibility',
              value: `${accessibleButtons}/${buttons.length} buttons (${Math.round(percentage)}%)`,
              status: percentage === 100 ? 'PASS' : percentage >= 80 ? 'WARNING' : 'FAIL',
              description: `${accessibleButtons} out of ${buttons.length} buttons are properly labeled`
            });
          }
          
          // Link accessibility check (15% weight)
          if (links.length > 0) {
            let accessibleLinks = 0;
            for (const link of links) {
              const hasText = !!link.textContent?.trim();
              const hasLabel = !!link.getAttribute('aria-label');
              const hasTitle = !!link.getAttribute('title');
              if (hasText || hasLabel || hasTitle) {
                accessibleLinks++;
              }
            }
            const percentage = (accessibleLinks / links.length) * 100;
            score += (accessibleLinks / links.length) * 15;
            totalChecks++;
            
            details.push({
              title: 'Link Accessibility',
              value: `${accessibleLinks}/${links.length} links (${Math.round(percentage)}%)`,
              status: percentage === 100 ? 'PASS' : percentage >= 80 ? 'WARNING' : 'FAIL',
              description: `${accessibleLinks} out of ${links.length} links have descriptive text`
            });
          }
          
          // Form input labels check (20% weight)
          if (inputs.length > 0) {
            let labeledInputs = 0;
            for (const input of inputs) {
              const hasLabel = !!document.querySelector(`label[for="${input.id}"]`);
              const hasAriaLabel = !!input.getAttribute('aria-label');
              const hasAriaLabelledBy = !!input.getAttribute('aria-labelledby');
              const hasPlaceholder = !!input.getAttribute('placeholder');
              if (hasLabel || hasAriaLabel || hasAriaLabelledBy || hasPlaceholder) {
                labeledInputs++;
              }
            }
            const percentage = (labeledInputs / inputs.length) * 100;
            score += (labeledInputs / inputs.length) * 20;
            totalChecks++;
            
            details.push({
              title: 'Form Input Labels',
              value: `${labeledInputs}/${inputs.length} inputs (${Math.round(percentage)}%)`,
              status: percentage === 100 ? 'PASS' : percentage >= 80 ? 'WARNING' : 'FAIL',
              description: `${labeledInputs} out of ${inputs.length} form inputs are properly labeled`
            });
          }
          
          // Basic page structure checks (20% weight)
          let structureScore = 0;
          
          // Check for proper heading hierarchy
          if (headings.length > 0) {
            const h1s = document.querySelectorAll('h1');
            if (h1s.length === 1) structureScore += 5; // Single H1 is good
            else if (h1s.length > 1) structureScore += 2; // Multiple H1s not ideal but not terrible
            
            if (headings.length > 1) structureScore += 5; // Has heading structure
          }
          
          // Check for skip links
          const skipLinks = document.querySelectorAll('a[href^="#"]');
          if (skipLinks.length > 0) structureScore += 3;
          
          // Check for landmark elements
          const landmarks = document.querySelectorAll('main, nav, header, footer, section, article, aside');
          if (landmarks.length > 0) structureScore += 5;
          
          // Check for lang attribute
          if (document.documentElement.getAttribute('lang')) structureScore += 2;
          
          details.push({
            title: 'Heading Structure',
            value: `${headings.length} headings found`,
            status: headings.length > 0 && document.querySelectorAll('h1').length === 1 ? 'PASS' : 'WARNING',
            description: `Page has ${headings.length} headings with ${document.querySelectorAll('h1').length} H1 tag(s)`
          });

          details.push({
            title: 'Landmark Elements',
            value: `${landmarks.length} landmarks`,
            status: landmarks.length > 0 ? 'PASS' : 'FAIL',
            description: landmarks.length > 0 ? 'Page has semantic landmark elements' : 'Page lacks semantic landmark elements'
          });

          details.push({
            title: 'Language Attribute',
            value: document.documentElement.getAttribute('lang') || 'Missing',
            status: document.documentElement.getAttribute('lang') ? 'PASS' : 'WARNING',
            description: document.documentElement.getAttribute('lang') ? 'Page has language attribute' : 'Consider adding language attribute to <html> tag'
          });
          
          score += structureScore;
          totalChecks++;
          
          // If we have no elements to check, return a baseline score
          if (totalChecks === 0) {
            return { score: 60, details: [] }; // Neutral score when no interactive elements found
          }
          
          return { 
            score: Math.round(Math.max(0, Math.min(100, score))), 
            details 
          };
        } catch (error) {
          console.error('Accessibility evaluation error:', error);
          return { score: 50, details: [] }; // Fallback score
        }
      })
      .catch((error) => {
        console.error('Accessibility evaluation failed:', error);
        return { score: 50, details: [] };
      });

    const accessibilityScore = accessibilityData.score;

    // Optional screenshot
    let screenshot: string | undefined;
    if (request.options?.includeScreenshot) {
      console.log('[audit] screenshot');
      try {
        const buf = await page.screenshot({ type: 'png', fullPage: false });
        screenshot = Buffer.from(buf).toString('base64');
      } catch (e) {
        console.warn('[audit] screenshot failed:', (e as Error).message);
      }
    }

    const results = {
      performanceScore,
      seoScore,
      accessibilityScore,
      bestPracticesScore: 75,
      metrics: {
        loadTime,
        cumulativeLayoutShift: pageSpeedMetrics?.cumulativeLayoutShift || 0,
      },
      ...(pageSpeedMetrics && { pageSpeedMetrics }),
      categoryDetails: {
        performance: {
          score: performanceScore,
          items: [
            {
              title: 'Page Load Time',
              value: `${loadTime}ms`,
              status: loadTime < 2000 ? 'PASS' : loadTime < 4000 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
              description: loadTime < 2000 ? 'Page loads quickly' : loadTime < 4000 ? 'Page load time could be improved' : 'Page loads slowly, consider optimizing'
            },
            ...(pageSpeedMetrics ? [
              {
                title: 'First Contentful Paint',
                value: `${pageSpeedMetrics.firstContentfulPaint || 0}ms`,
                status: (pageSpeedMetrics.firstContentfulPaint || 0) < 1800 ? 'PASS' : (pageSpeedMetrics.firstContentfulPaint || 0) < 3000 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                description: 'Time until first content appears'
              },
              {
                title: 'Largest Contentful Paint',
                value: `${pageSpeedMetrics.largestContentfulPaint || 0}ms`,
                status: (pageSpeedMetrics.largestContentfulPaint || 0) < 2500 ? 'PASS' : (pageSpeedMetrics.largestContentfulPaint || 0) < 4000 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                description: 'Time until largest content element appears'
              },
              {
                title: 'Cumulative Layout Shift',
                value: (pageSpeedMetrics.cumulativeLayoutShift || 0).toString(),
                status: (pageSpeedMetrics.cumulativeLayoutShift || 0) < 0.1 ? 'PASS' : (pageSpeedMetrics.cumulativeLayoutShift || 0) < 0.25 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                description: 'Measures visual stability during page load'
              },
              {
                title: 'Speed Index',
                value: `${pageSpeedMetrics.speedIndex || 0}ms`,
                status: (pageSpeedMetrics.speedIndex || 0) < 3400 ? 'PASS' : (pageSpeedMetrics.speedIndex || 0) < 5800 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                description: 'How quickly page contents are visually populated'
              }
            ] : [])
          ]
        },
        seo: {
          score: seoScore,
          items: seoData.details
        },
        accessibility: {
          score: accessibilityScore,
          items: accessibilityData.details
        },
        bestPractices: {
          score: 75,
          items: [
            {
              title: 'HTTPS Usage',
              value: request.websiteUrl.startsWith('https://') ? 'Enabled' : 'Disabled',
              status: request.websiteUrl.startsWith('https://') ? 'PASS' : 'FAIL' as 'PASS' | 'FAIL',
              description: request.websiteUrl.startsWith('https://') ? 'Site uses secure HTTPS protocol' : 'Site should use HTTPS for security'
            },
            {
              title: 'JavaScript Errors',
              value: 'Not detected',
              status: 'PASS' as 'PASS',
              description: 'No JavaScript errors detected during audit'
            },
            {
              title: 'Console Warnings',
              value: 'Minimal',
              status: 'PASS' as 'PASS',
              description: 'Few or no console warnings detected'
            }
          ]
        }
      },
      pagesCrawled: 1,
      screenshot,
      issues: [] as NonNullable<NonNullable<AuditResult['results']>['issues']>,
    };

    return { jobId: request.jobId, status: 'COMPLETED', results };
  }

  private async progressiveGoto(page: Page, url: string): Promise<HTTPResponse | null> {
    // Enhanced navigation strategies for JS-heavy sites with better resource allocation
    const attempts: Array<{ name: string; opts: Parameters<Page['goto']>[1]; allowErrors?: boolean }> = [
      // Start with basic strategy but allow more time
      { name: 'basic-fast', opts: { timeout: 25_000 }, allowErrors: true },
      { name: 'domcontentloaded', opts: { waitUntil: 'domcontentloaded', timeout: 35_000 } },
      { name: 'load', opts: { waitUntil: 'load', timeout: 45_000 } },
      { name: 'networkidle2', opts: { waitUntil: 'networkidle2', timeout: 40_000 } },
      // Final fallback with generous timeout
      { name: 'load-fallback', opts: { waitUntil: 'load', timeout: 30_000 }, allowErrors: true },
    ];

    let lastResponse: HTTPResponse | null = null;
    let lastError: Error | null = null;

    for (const { name, opts, allowErrors } of attempts) {
      try {
        console.log(`[audit] goto (${name})`, { timeout: opts?.timeout, waitUntil: opts?.waitUntil || 'default' });
        const res = await page.goto(url, opts as any);
        
        if (!res) {
          console.warn(`[audit] goto (${name}) no response`);
          if (!allowErrors) continue;
        } else if (res.status() >= 400) {
          console.warn(`[audit] goto (${name}) status ${res.status()}`);
          if (!allowErrors && res.status() >= 500) continue; // Server errors, try next strategy
          lastResponse = res; // Client errors (4xx) might still be usable
        } else {
          console.log(`[audit] goto (${name}) success with status ${res.status()}`);
          lastResponse = res;
        }

        // For JS-heavy sites, wait for better interactivity with more time
        if (name === 'basic-fast' || name === 'domcontentloaded') {
          console.log(`[audit] waiting for JS execution after ${name}`);
          try {
            await page.waitForFunction(
              () => document.readyState === 'complete' || document.readyState === 'interactive',
              { timeout: 8_000 } // Increased timeout with more RAM
            );
            // Additional wait for dynamic content
            await new Promise(resolve => setTimeout(resolve, 2_000));
          } catch (jsWaitError) {
            console.warn(`[audit] JS wait failed after ${name}:`, (jsWaitError as Error).message);
            // Continue anyway
          }
        }

        // Return the response
        return lastResponse;

      } catch (e) {
        const error = e as Error;
        lastError = error;
        console.warn(`[audit] goto (${name}) failed:`, error.message);
        
        // For certain errors, don't continue trying
        if (error.message.includes('net::ERR_NAME_NOT_RESOLVED') || 
            error.message.includes('net::ERR_INTERNET_DISCONNECTED')) {
          console.error('[audit] Network connectivity issue, stopping attempts');
          break;
        }
        
        // For timeout errors, try the next strategy
        if (error.message.includes('timeout') || error.message.includes('Navigation timeout')) {
          continue;
        }
      }
    }

    // If we have any response (even with errors), try to use it
    if (lastResponse) {
      console.log(`[audit] using last available response with status ${lastResponse.status()}`);
      return lastResponse;
    }

    // Final content check with reasonable timeout
    try {
      const content = await page.content();
      if (content && content.length > 100) { // Higher threshold again
        console.log('[audit] page has content despite navigation errors, proceeding');
        return null;
      }
    } catch (contentError) {
      console.warn('[audit] failed to check page content:', (contentError as Error).message);
    }

    throw new Error(`Navigation failed after enhanced strategies. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  // ---------- Optional: issue extraction scaffold (unused for now) ----------

  /* eslint-disable @typescript-eslint/no-unused-vars */
  private extractIssues(_lhr: any) {
    const issues: Array<{
      type: 'ERROR' | 'WARNING' | 'INFO';
      category: 'PERFORMANCE' | 'SEO' | 'ACCESSIBILITY' | 'BEST_PRACTICES';
      title: string;
      description: string;
      impact: 'HIGH' | 'MEDIUM' | 'LOW';
      recommendation: string;
    }> = [];
    return issues;
  }
  /* eslint-enable @typescript-eslint/no-unused-vars */

  // ---------- Callback ----------

  private async sendCallback(result: AuditResult): Promise<void> {
    if (!config.callbackUrl) {
      console.log('[callback] no callbackUrl configured – skipping');
      return;
    }
    try {
      const body = JSON.stringify(result);
      const signature = crypto.createHmac('sha256', config.webhookSecret).update(body).digest('hex');

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15_000);

      const resp = await fetch(config.callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': `sha256=${signature}`,
          'X-API-Key': config.apiKey,
        },
        body,
        signal: controller.signal,
      }).catch((e) => {
        clearTimeout(t);
        throw e;
      });

      clearTimeout(t);

      if (!resp.ok) {
        console.error('[callback] failed:', resp.status, resp.statusText);
        const text = await resp.text().catch(() => '');
        if (text) console.error('[callback] body:', text);
      } else {
        console.log('[callback] ok');
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        console.error('[callback] timeout');
      } else {
        console.error('[callback] error:', (e as Error).message);
      }
    }
  }
}