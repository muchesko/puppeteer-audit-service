// services/pdfService.ts
import puppeteer, { type Browser, type Page, type PDFOptions, type LaunchOptions } from 'puppeteer';
import fs from 'node:fs';
import { config } from '../config/index.js';

export interface PDFRequest {
  jobId: string;
  htmlContent: string;
  options?: {
    format?: 'A4' | 'Letter';
    orientation?: 'portrait' | 'landscape';
    margin?: {
      top?: string;
      right?: string;
      bottom?: string;
      left?: string;
    };
    displayHeaderFooter?: boolean;
    headerTemplate?: string;
    footerTemplate?: string;
    printBackground?: boolean;
    scale?: number; // 0.1–2
  };
}

export class PDFService {
  private activeBrowser: Browser | null = null;

  // --- Browser bootstrap -----------------------------------------------------

  private pickExecutablePath(): string | undefined {
    const candidates = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      config.chromeExecutablePath,                     // allow config to supply a path
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch { /* ignore */ }
    }
    return undefined; // let Puppeteer pick bundled/available one
  }

  private async launchBrowser(): Promise<Browser> {
    const executablePath = this.pickExecutablePath();

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
      '--user-data-dir=/tmp/chrome-pdf-data',
      // Additional stability flags for containerized environments
      '--disable-crashpad',
      '--disable-crash-reporter',
      '--no-crash-upload',
      '--memory-pressure-off',
      '--max_old_space_size=512',
      '--disable-field-trial-config',
      '--single-process',               // For PDF generation in containers
      '--disable-web-security',        // For generating PDFs from HTML content
      // DO NOT set remote debugging flags in prod
    ];

    const launchOpts: LaunchOptions = {
      headless: true,                 // headless 'new' is default in recent Puppeteer
      executablePath,
      args,
      timeout: 45_000,                // launch timeout
      protocolTimeout: 60_000,        // CDP timeout
      dumpio: false,
    };

    return puppeteer.launch(launchOpts);
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.activeBrowser || !this.activeBrowser.isConnected()) {
      // Close any zombie browser
      if (this.activeBrowser) {
        try { await this.activeBrowser.close(); } catch { /* ignore */ }
        this.activeBrowser = null;
      }
      this.activeBrowser = await this.launchBrowser();
    }
    return this.activeBrowser;
  }

  // --- Public API ------------------------------------------------------------

  async generatePDF(request: PDFRequest): Promise<Buffer> {
    const browser = await this.getBrowserWithRetries();
    const page = await browser.newPage();

    // Helpful logs for diagnosing page issues in containers
    page.on('console', m => console.log('[pdf][console]', m.type(), m.text()));
    page.on('pageerror', e => console.warn('[pdf][pageerror]', e.message));
    page.on('requestfailed', r => console.warn('[pdf][requestfailed]', r.url(), r.failure()?.errorText));

    try {
      // Set viewport for consistent rendering
      await page.setViewport({ 
        width: 1024, 
        height: 1400, 
        deviceScaleFactor: 1 
      });

      // Load the HTML string
      await this.setHTMLContent(page, request.htmlContent);

      // Ensure print CSS takes effect and fonts are ready
      await page.emulateMediaType('print');
      await this.waitForFonts(page);
      
      // Wait for any dynamic content to settle
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Additional wait for layout stabilization
      await page.evaluate(() => {
        return new Promise(resolve => {
          // Wait for any pending layout calculations
          if (document.readyState === 'complete') {
            resolve(true);
          } else {
            window.addEventListener('load', () => resolve(true));
          }
        });
      });

      // Build PDF options safely
      const pdfOptions = this.buildPdfOptions(request.options);

      // Generate PDF
      const pdf = await page.pdf(pdfOptions);
      return Buffer.from(pdf);
    } finally {
      try { await page.close(); } catch { /* ignore */ }
      // Intentionally keep the browser alive for reuse; use cleanup() to close
    }
  }

  async generatePDFFromURL(url: string, options?: PDFRequest['options']): Promise<Buffer> {
    // Quick preflight so we don’t waste a Chrome spin-up on dead URLs
    await this.preflightURL(url);

    const browser = await this.getBrowserWithRetries();
    const page = await browser.newPage();

    page.on('console', m => console.log('[pdf-url][console]', m.type(), m.text()));
    page.on('pageerror', e => console.warn('[pdf-url][pageerror]', e.message));
    page.on('requestfailed', r => console.warn('[pdf-url][requestfailed]', r.url(), r.failure()?.errorText));

    try {
      // Progressive navigation strategies for flaky pages/CDN
      await this.progressiveGoto(page, url, config.requestTimeout ?? 60_000);

      await page.emulateMediaType('print');
      await this.waitForFonts(page);

      const pdfOptions = this.buildPdfOptions(options);
      const pdf = await page.pdf(pdfOptions);
      return Buffer.from(pdf);
    } finally {
      try { await page.close(); } catch { /* ignore */ }
    }
  }

  async cleanup(): Promise<void> {
    if (this.activeBrowser) {
      try { await this.activeBrowser.close(); } catch { /* ignore */ }
      this.activeBrowser = null;
    }
  }

  // --- Internals -------------------------------------------------------------

  private async getBrowserWithRetries(maxRetries = 2): Promise<Browser> {
    let attempt = 0;
    let lastErr: unknown;

    while (attempt <= maxRetries) {
      try {
        return await this.getBrowser();
      } catch (err) {
        lastErr = err;
        attempt++;

        // try to close and relaunch on failure
        if (this.activeBrowser) {
          try { await this.activeBrowser.close(); } catch { /* ignore */ }
          this.activeBrowser = null;
        }
        if (attempt > maxRetries) break;

        const backoff = 1000 * attempt;
        console.warn(`[pdf] browser launch attempt ${attempt} failed; retrying in ${backoff}ms`, err);
        await new Promise(res => setTimeout(res, backoff));
      }
    }
    throw new Error(`Failed to launch browser after ${maxRetries + 1} attempts: ${(lastErr as Error)?.message ?? lastErr}`);
  }

  private async setHTMLContent(page: Page, html: string): Promise<void> {
    // Use a watchdog to avoid indefinite hangs in setContent
    const timeout = config.requestTimeout ?? 60_000;

    const watchdog = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error('setContent watchdog timeout')), Math.min(timeout, 90_000))
    );

    await Promise.race([
      page.setContent(html, { waitUntil: 'networkidle0', timeout }),
      watchdog,
    ]);
  }

  private async waitForFonts(page: Page): Promise<void> {
    try {
      // Wait for all fonts (important for correct pagination/widths)
      await page.evaluate(() => (document as any).fonts?.ready?.then(() => true));
    } catch {
      // Not critical if fonts API isn’t available
    }
  }

  private buildPdfOptions(options?: PDFRequest['options']): PDFOptions {
    // Chrome requires non-empty templates when displayHeaderFooter=true
    const wantsHeaderFooter = !!options?.displayHeaderFooter;

    const safeHeader = wantsHeaderFooter
      ? (options?.headerTemplate ?? `<div style="font-size:8px;width:100%;text-align:center;"></div>`)
      : undefined;
    const safeFooter = wantsHeaderFooter
      ? (options?.footerTemplate ?? `<div style="font-size:8px;width:100%;text-align:center;"><span class="pageNumber"></span>/<span class="totalPages"></span></div>`)
      : undefined;

    const pdfOptions: PDFOptions = {
      // Respect CSS @page size when present
      preferCSSPageSize: false, // Disable to avoid layout issues
      format: options?.format ?? 'A4',
      landscape: options?.orientation === 'landscape',
      margin: {
        top: options?.margin?.top ?? '15mm',
        right: options?.margin?.right ?? '15mm', 
        bottom: options?.margin?.bottom ?? (wantsHeaderFooter ? '20mm' : '15mm'),
        left: options?.margin?.left ?? '15mm',
      },
      displayHeaderFooter: wantsHeaderFooter,
      headerTemplate: safeHeader,
      footerTemplate: safeFooter,
      printBackground: options?.printBackground !== false,
      scale: options?.scale ?? 0.8, // Slightly smaller scale for better fit
      timeout: config.requestTimeout ?? 60_000,
      // Additional options for better PDF generation
      omitBackground: false,
      tagged: false, // Disable tagged PDF to avoid layout issues
      width: '210mm', // A4 width
      height: '297mm', // A4 height
    };

    return pdfOptions;
  }

  private async preflightURL(url: string): Promise<void> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) {
        console.warn('[pdf] preflight HEAD not OK:', res.status, res.statusText);
      }
    } catch (e) {
      // Not fatal—some servers block HEAD. We’ll still try to navigate.
      console.warn('[pdf] preflight HEAD failed:', (e as Error)?.message);
    }
  }

  private async progressiveGoto(page: Page, url: string, totalTimeoutMs: number): Promise<void> {
    const strategies: Array<{ name: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle0' | 'networkidle2'; timeout: number }> = [
      { name: 'domcontentloaded', waitUntil: 'domcontentloaded', timeout: Math.min(20_000, totalTimeoutMs) },
      { name: 'load',            waitUntil: 'load',            timeout: Math.min(35_000, totalTimeoutMs) },
      { name: 'networkidle2',    waitUntil: 'networkidle2',    timeout: Math.min(45_000, totalTimeoutMs) },
      { name: 'basic',           waitUntil: undefined,         timeout: Math.min(15_000, totalTimeoutMs) },
    ];

    for (const s of strategies) {
      try {
        const opts: any = { timeout: s.timeout };
        if (s.waitUntil) opts.waitUntil = s.waitUntil;
        const resp = await page.goto(url, opts);
        // Accept non-OK (e.g., 204/pdf, 3xx when content renders) as long as it loaded
        if (resp) return;
      } catch (e) {
        console.warn(`[pdf] goto strategy "${s.name}" failed:`, (e as Error)?.message);
      }
    }
    throw new Error('All navigation strategies failed');
  }
}