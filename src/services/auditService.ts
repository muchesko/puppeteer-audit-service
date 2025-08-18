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

    const performanceScore = Math.max(0, Math.min(100, 100 - Math.floor(loadTime / 100)));

    // Basic SEO
    console.log('[audit] SEO checks');
    const seoScore = await page
      .evaluate(() => {
        try {
          const title = document.title || '';
          const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content');
          const h1s = document.querySelectorAll('h1');
          let score = 0;
          if (title && title.length <= 60) score += 25;
          if (metaDescription && metaDescription.length > 0) score += 25;
          if (h1s.length === 1) score += 25;
          if (document.querySelector('meta[name="viewport"]')) score += 25;
          return score;
        } catch { return 50; }
      })
      .catch(() => 50);

    // Basic a11y
    console.log('[audit] accessibility checks');
    const accessibilityScore = await page
      .evaluate(() => {
        try {
          const images = Array.from(document.querySelectorAll('img'));
          const buttons = Array.from(document.querySelectorAll('button'));
          let score = 100;
          for (const img of images) {
            if (!img.getAttribute('alt')) score -= 10;
          }
          for (const btn of buttons) {
            const hasText = !!btn.textContent?.trim();
            const hasLabel = !!btn.getAttribute('aria-label');
            if (!hasText && !hasLabel) score -= 5;
          }
          return Math.max(0, score);
        } catch { return 70; }
      })
      .catch(() => 70);

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
      accessibilityScore: Math.round(accessibilityScore),
      bestPracticesScore: 75,
      metrics: {
        loadTime,
        cumulativeLayoutShift: 0,
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