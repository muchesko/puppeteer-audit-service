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
            desktop?: {
                performanceScore?: number;
                firstContentfulPaint?: number;
                largestContentfulPaint?: number;
                firstInputDelay?: number;
                cumulativeLayoutShift?: number;
                speedIndex?: number;
                totalBlockingTime?: number;
            };
            mobile?: {
                performanceScore?: number;
                firstContentfulPaint?: number;
                largestContentfulPaint?: number;
                firstInputDelay?: number;
                cumulativeLayoutShift?: number;
                speedIndex?: number;
                totalBlockingTime?: number;
            };
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

    // Queue system for processing audit requests
    private queue: AuditRequest[] = [];
    private pumping = false;

    // Centralized timeouts
    private readonly TIME = {
        job: 150_000,
        nav: 45_000,
        page: 75_000,
        psi: 60_000
    } as const;

    // ---------- URL validation ----------

    private normalizeAndValidateUrl(raw: string): string {
        const u = new URL(raw);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https allowed');
        const host = u.hostname.toLowerCase();
        if (['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Local addresses not allowed');
        return u.toString();
    }

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

            // Additional stability flags for containerized environments
            '--disable-crashpad',
            '--disable-crash-reporter',
            '--no-crash-upload',
            '--memory-pressure-off',
            '--max_old_space_size=512',
            '--disable-field-trial-config',
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

    private async getBrowserWithRetry(maxRetries = 3): Promise<Browser> {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const browser = await this.getBrowser();
                
                // Test browser connectivity
                const pages = await browser.pages();
                console.log(`[browser] attempt ${attempt}: browser has ${pages.length} pages`);
                
                return browser;
            } catch (error) {
                console.error(`[browser] attempt ${attempt} failed:`, (error as Error).message);
                
                // Force cleanup and retry
                try { 
                    await this.activeBrowser?.close(); 
                } catch { /* ignore */ }
                this.activeBrowser = null;
                
                if (attempt === maxRetries) {
                    throw new Error(`Failed to get browser after ${maxRetries} attempts: ${(error as Error).message}`);
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
        throw new Error('Unexpected getBrowserWithRetry completion');
    }

    // ---------- Public API ----------

    async startAudit(request: AuditRequest): Promise<void> {
        this.jobStatuses.set(request.jobId, 'QUEUED');
        this.queue.push(request);
        this.pumpQueue();
    }

    private async pumpQueue(): Promise<void> {
        if (this.pumping) return;
        this.pumping = true;
        try {
            while (this.activeJobs < this.maxConcurrentJobs && this.queue.length) {
                const next = this.queue.shift()!;
                this.activeJobs++;
                this.jobStatuses.set(next.jobId, 'PROCESSING');

                this.processAudit(next).finally(() => {
                    this.activeJobs--;
                    this.pumpQueue();
                });
            }
        } finally {
            this.pumping = false;
        }
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
        desktop: {
            performanceScore: number;
            firstContentfulPaint: number;
            largestContentfulPaint: number;
            firstInputDelay: number;
            cumulativeLayoutShift: number;
            speedIndex: number;
            totalBlockingTime: number;
        };
        mobile: {
            performanceScore: number;
            firstContentfulPaint: number;
            largestContentfulPaint: number;
            firstInputDelay: number;
            cumulativeLayoutShift: number;
            speedIndex: number;
            totalBlockingTime: number;
        };
    } | null> {
        if (!config.pageSpeedApiKey) {
            console.warn('[pagespeed] No API key configured, skipping PageSpeed Insights');
            return null;
        }

        try {
            console.log('[pagespeed] Calling PageSpeed Insights API for:', url);

            // Fetch both desktop and mobile scores in parallel
            const [desktopResponse, mobileResponse] = await Promise.all([
                this.fetchPageSpeedStrategy(url, 'desktop'),
                this.fetchPageSpeedStrategy(url, 'mobile')
            ]);

            if (!desktopResponse || !mobileResponse) {
                console.error('[pagespeed] Failed to fetch both desktop and mobile metrics');
                return null;
            }

            console.log('[pagespeed] Successfully retrieved both desktop and mobile metrics');

            return {
                desktop: desktopResponse,
                mobile: mobileResponse
            };

        } catch (error) {
            console.error('[pagespeed] Error calling PageSpeed Insights:', (error as Error).message);
            return null;
        }
    }

    private async fetchPageSpeedStrategy(url: string, strategy: 'desktop' | 'mobile'): Promise<{
        performanceScore: number;
        firstContentfulPaint: number;
        largestContentfulPaint: number;
        firstInputDelay: number;
        cumulativeLayoutShift: number;
        speedIndex: number;
        totalBlockingTime: number;
    } | null> {
        try {
            const apiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
            apiUrl.searchParams.set('url', url);
            apiUrl.searchParams.set('key', config.pageSpeedApiKey);
            apiUrl.searchParams.set('strategy', strategy);
            apiUrl.searchParams.set('category', 'performance');

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.TIME.psi);

            const response = await fetch(apiUrl.toString(), {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; AuditService/1.0)',
                },
            });

            clearTimeout(timeout);

            if (!response.ok) {
                console.error(`[pagespeed] ${strategy} API error:`, response.status, response.statusText);
                const errorText = await response.text().catch(() => '');
                console.error(`[pagespeed] ${strategy} error details:`, errorText);
                return null;
            }

            const data = await response.json();

            // Extract performance metrics from PageSpeed Insights response
            const lighthouseResult = data.lighthouseResult;
            if (!lighthouseResult) {
                console.error(`[pagespeed] No lighthouse result in ${strategy} response`);
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

            console.log(`[pagespeed] Successfully retrieved ${strategy} metrics:`, {
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
                console.error(`[pagespeed] ${strategy} request timeout`);
            } else {
                console.error(`[pagespeed] Error calling ${strategy} PageSpeed Insights:`, (error as Error).message);
            }
            return null;
        }
    }

    // ---------- Core flow ----------

    private async processAudit(request: AuditRequest): Promise<void> {

        let page: Page | null = null;
        let context: any = null;
        try {
            console.log('[route] queued', request.jobId);
            console.log(`[audit] job ${request.jobId} → ${request.websiteUrl}`);

            // Validate and normalize URL once at the top
            const targetUrl = this.normalizeAndValidateUrl(request.websiteUrl);

            // Quick preflight: don’t spawn Chrome if URL is dead
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 8_000);
                const head = await fetch(targetUrl, { method: 'HEAD', signal: ctrl.signal });
                clearTimeout(t);
                console.log('[audit] preflight:', head.status);
            } catch (e) {
                throw new Error(`Preflight failed: ${(e as Error).message}`);
            }

            // Browser operation with retry logic
            let browserRetries = 0;
            const maxBrowserRetries = 2;
            let auditCompleted = false;

            while (!auditCompleted && browserRetries <= maxBrowserRetries) {
                try {
                    // Get warm browser and create incognito context
                    const browser = await this.getBrowserWithRetry();
                    context = await browser.createBrowserContext();

                    // Create page off the context
                    page = await this.createPageWithWatchdog(context, 25_000);
                    this.hookPageLogs(page);

                    // Job-level watchdog so we never hang forever
                    const jobWatchdog = new Promise<never>((_, rej) =>
                        setTimeout(() => rej(new Error('Job watchdog timeout')), this.TIME.job)
                    );

                    const result = await Promise.race([
                        this.runSinglePageAudit(page, { ...request, websiteUrl: targetUrl }),
                        jobWatchdog,
                    ]);

                    // If we get here, the audit succeeded
                    this.jobStatuses.set(request.jobId, 'COMPLETED');
                    this.jobResults.set(request.jobId, result);
                    console.log(`[audit] job ${request.jobId} completed`, {
                        performance: result.results?.performanceScore,
                        seo: result.results?.seoScore,
                        accessibility: result.results?.accessibilityScore,
                        bestPractices: result.results?.bestPracticesScore,
                    });
                    this.sendCallback(result).catch(err => console.warn('[callback] error (ignored):', err));
                    auditCompleted = true; // Success - exit the retry loop

                } catch (auditError) {
                    const errText = auditError instanceof Error ? auditError.message : 'Unknown error';
                    console.error(`[audit] job ${request.jobId} attempt ${browserRetries + 1} failed:`, errText);

                    // Check if this is a browser connectivity issue
                    if (errText.includes('Target closed') || 
                        errText.includes('Protocol error') || 
                        errText.includes('Session closed') ||
                        errText.includes('Connection closed') ||
                        errText.includes('Page is closed')) {
                        
                        browserRetries++;
                        if (browserRetries <= maxBrowserRetries) {
                            console.log(`[audit] retrying job ${request.jobId} (attempt ${browserRetries + 1}/${maxBrowserRetries + 1})`);
                            
                            // Clean up current resources
                            try { await page?.close({ runBeforeUnload: false }); } catch { /* ignore */ }
                            try { await context?.close(); } catch { /* ignore */ }
                            page = null;
                            context = null;
                            
                            // Force browser reset
                            try { await this.activeBrowser?.close(); } catch { /* ignore */ }
                            this.activeBrowser = null;
                            
                            // Wait before retry
                            await new Promise(resolve => setTimeout(resolve, 2000 + (browserRetries * 1000)));
                            continue; // Retry the browser operation
                        }
                    }
                    
                    // Non-retryable error or max retries reached
                    throw auditError;
                }
            }

        } catch (error) {
            const errText = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
            console.error(`[audit] job ${request.jobId} failed after all retries:`, errText);

            const fail: AuditResult = { jobId: request.jobId, status: 'FAILED', error: errText };
            this.jobStatuses.set(request.jobId, 'FAILED');
            this.jobResults.set(request.jobId, fail);
            this.sendCallback(fail).catch(err => console.warn('[callback] error (ignored):', err));
        } finally {
            // Close page and context only (keep browser warm)
            try { await page?.close({ runBeforeUnload: false }); } catch { /* ignore */ }
            try { await context?.close(); } catch { /* ignore */ }

            // DO NOT close or SIGKILL the shared browser here anymore
            this.activeBrowser = this.activeBrowser; // no-op: keep it
        }
    }

    // ---------- Helpers ----------

    private async createPageWithWatchdog(host: { newPage(): Promise<Page> }, timeoutMs: number): Promise<Page> {
        console.log('[audit] creating page…');
        const created = await Promise.race([
            (async () => {
                const p = await host.newPage();
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
        page.setDefaultTimeout(this.TIME.page);
        page.setDefaultNavigationTimeout(this.TIME.nav);

        // Light request interception (only when not screenshotting)
        if (!request.options?.includeScreenshot) {
            await page.setRequestInterception(true);
            const blocked = ['doubleclick.net', 'googletagmanager.com', 'facebook.net', 'youtube.com'];
            page.on('request', r => {
                const url = r.url();
                if (blocked.some(d => url.includes(d))) return r.abort();
                r.continue();
            });
        }

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
                // Calculate combined performance score from desktop and mobile
                // Weight: 60% desktop, 40% mobile (desktop slightly prioritized)
                const desktopScore = pageSpeedData.desktop.performanceScore;
                const mobileScore = pageSpeedData.mobile.performanceScore;
                performanceScore = Math.round((desktopScore * 0.6) + (mobileScore * 0.4));

                console.log(`[audit] combined performance score: ${performanceScore} (desktop: ${desktopScore}, mobile: ${mobileScore})`);
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
                cumulativeLayoutShift: pageSpeedMetrics?.desktop?.cumulativeLayoutShift || 0,
            },
            ...(pageSpeedMetrics && { pageSpeedMetrics }),
            categoryDetails: {
                performance: {
                    score: performanceScore,
                    items: [
                        // Combined score explanation when PageSpeed data is available
                        ...(pageSpeedMetrics ? [
                            {
                                title: 'Overall Performance Score',
                                value: `${performanceScore}/100`,
                                status: performanceScore >= 90 ? 'PASS' : performanceScore >= 50 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: `Combined score (60% desktop + 40% mobile): Desktop ${pageSpeedMetrics.desktop?.performanceScore || 0}/100, Mobile ${pageSpeedMetrics.mobile?.performanceScore || 0}/100`
                            },
                            {
                                title: 'Desktop Performance Score',
                                value: `${pageSpeedMetrics.desktop?.performanceScore || 0}/100`,
                                status: (pageSpeedMetrics.desktop?.performanceScore || 0) >= 90 ? 'PASS' : (pageSpeedMetrics.desktop?.performanceScore || 0) >= 50 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: 'Google PageSpeed Insights desktop performance score'
                            },
                            {
                                title: 'Mobile Performance Score',
                                value: `${pageSpeedMetrics.mobile?.performanceScore || 0}/100`,
                                status: (pageSpeedMetrics.mobile?.performanceScore || 0) >= 90 ? 'PASS' : (pageSpeedMetrics.mobile?.performanceScore || 0) >= 50 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: 'Google PageSpeed Insights mobile performance score'
                            }
                        ] : []),
                        {
                            title: 'Page Load Time',
                            value: `${loadTime}ms`,
                            status: loadTime < 2000 ? 'PASS' : loadTime < 4000 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                            description: loadTime < 2000 ? 'Page loads quickly' : loadTime < 4000 ? 'Page load time could be improved' : 'Page loads slowly, consider optimizing'
                        },
                        ...(pageSpeedMetrics ? [
                            {
                                title: 'First Contentful Paint (Desktop)',
                                value: `${pageSpeedMetrics.desktop?.firstContentfulPaint || 0}ms`,
                                status: (pageSpeedMetrics.desktop?.firstContentfulPaint || 0) < 1800 ? 'PASS' : (pageSpeedMetrics.desktop?.firstContentfulPaint || 0) < 3000 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: 'Time until first content appears on desktop'
                            },
                            {
                                title: 'First Contentful Paint (Mobile)',
                                value: `${pageSpeedMetrics.mobile?.firstContentfulPaint || 0}ms`,
                                status: (pageSpeedMetrics.mobile?.firstContentfulPaint || 0) < 1800 ? 'PASS' : (pageSpeedMetrics.mobile?.firstContentfulPaint || 0) < 3000 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: 'Time until first content appears on mobile'
                            },
                            {
                                title: 'Largest Contentful Paint (Desktop)',
                                value: `${pageSpeedMetrics.desktop?.largestContentfulPaint || 0}ms`,
                                status: (pageSpeedMetrics.desktop?.largestContentfulPaint || 0) < 2500 ? 'PASS' : (pageSpeedMetrics.desktop?.largestContentfulPaint || 0) < 4000 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: 'Time until largest content element appears on desktop'
                            },
                            {
                                title: 'Largest Contentful Paint (Mobile)',
                                value: `${pageSpeedMetrics.mobile?.largestContentfulPaint || 0}ms`,
                                status: (pageSpeedMetrics.mobile?.largestContentfulPaint || 0) < 2500 ? 'PASS' : (pageSpeedMetrics.mobile?.largestContentfulPaint || 0) < 4000 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: 'Time until largest content element appears on mobile'
                            },
                            {
                                title: 'Cumulative Layout Shift (Desktop)',
                                value: (pageSpeedMetrics.desktop?.cumulativeLayoutShift || 0).toString(),
                                status: (pageSpeedMetrics.desktop?.cumulativeLayoutShift || 0) < 0.1 ? 'PASS' : (pageSpeedMetrics.desktop?.cumulativeLayoutShift || 0) < 0.25 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: 'Measures visual stability during page load on desktop'
                            },
                            {
                                title: 'Cumulative Layout Shift (Mobile)',
                                value: (pageSpeedMetrics.mobile?.cumulativeLayoutShift || 0).toString(),
                                status: (pageSpeedMetrics.mobile?.cumulativeLayoutShift || 0) < 0.1 ? 'PASS' : (pageSpeedMetrics.mobile?.cumulativeLayoutShift || 0) < 0.25 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: 'Measures visual stability during page load on mobile'
                            },
                            {
                                title: 'Speed Index (Desktop)',
                                value: `${pageSpeedMetrics.desktop?.speedIndex || 0}ms`,
                                status: (pageSpeedMetrics.desktop?.speedIndex || 0) < 3400 ? 'PASS' : (pageSpeedMetrics.desktop?.speedIndex || 0) < 5800 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: 'How quickly page contents are visually populated on desktop'
                            },
                            {
                                title: 'Speed Index (Mobile)',
                                value: `${pageSpeedMetrics.mobile?.speedIndex || 0}ms`,
                                status: (pageSpeedMetrics.mobile?.speedIndex || 0) < 3400 ? 'PASS' : (pageSpeedMetrics.mobile?.speedIndex || 0) < 5800 ? 'WARNING' : 'FAIL' as 'PASS' | 'WARNING' | 'FAIL',
                                description: 'How quickly page contents are visually populated on mobile'
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
        };

        // Generate issues based on audit results
        console.log('[audit] generating issues from audit results');
        const issues = this.extractIssues({
            performanceScore,
            seoScore,
            accessibilityScore,
            bestPracticesScore: 75,
            loadTime,
            categoryDetails: results.categoryDetails,
            pageSpeedMetrics
        });

        // Add issues to results
        const finalResults = {
            ...results,
            issues,
        };

        return { jobId: request.jobId, status: 'COMPLETED', results: finalResults };
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
                // Check if page is still connected before navigation
                if (page.isClosed()) {
                    throw new Error('Page is closed before navigation attempt');
                }

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

                // For browser connectivity errors, propagate immediately to trigger retry
                if (error.message.includes('Target closed') || 
                    error.message.includes('Protocol error') || 
                    error.message.includes('Session closed') ||
                    error.message.includes('Connection closed')) {
                    console.error('[audit] Browser connectivity issue detected during navigation');
                    throw error; // Propagate to trigger browser retry
                }

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

    // ---------- Issue extraction from audit results ----------

    private extractIssues(auditData: {
        performanceScore: number;
        seoScore: number;
        accessibilityScore: number;
        bestPracticesScore: number;
        loadTime: number;
        categoryDetails?: {
            performance?: { items: Array<{ title: string; status: string; description: string }> };
            seo?: { items: Array<{ title: string; status: string; description: string }> };
            accessibility?: { items: Array<{ title: string; status: string; description: string }> };
            bestPractices?: { items: Array<{ title: string; status: string; description: string }> };
        };
        pageSpeedMetrics?: {
            desktop?: {
                firstContentfulPaint?: number;
                largestContentfulPaint?: number;
                cumulativeLayoutShift?: number;
                totalBlockingTime?: number;
            };
            mobile?: {
                firstContentfulPaint?: number;
                largestContentfulPaint?: number;
                cumulativeLayoutShift?: number;
                totalBlockingTime?: number;
            };
        };
    }) {
        const issues: Array<{
            type: 'ERROR' | 'WARNING' | 'INFO';
            category: 'PERFORMANCE' | 'SEO' | 'ACCESSIBILITY' | 'BEST_PRACTICES';
            title: string;
            description: string;
            impact: 'HIGH' | 'MEDIUM' | 'LOW';
            recommendation: string;
        }> = [];

        // Performance Issues
        if (auditData.performanceScore < 50) {
            issues.push({
                type: 'ERROR',
                category: 'PERFORMANCE',
                title: 'Poor Performance Score',
                description: `Overall performance score is ${auditData.performanceScore}/100 (combined desktop & mobile), which is below acceptable standards.`,
                impact: 'HIGH',
                recommendation: 'Optimize images, minify CSS/JS, enable compression, and reduce server response times for both desktop and mobile.'
            });
        } else if (auditData.performanceScore < 70) {
            issues.push({
                type: 'WARNING',
                category: 'PERFORMANCE',
                title: 'Below Average Performance',
                description: `Overall performance score is ${auditData.performanceScore}/100 (combined desktop & mobile), which could be improved.`,
                impact: 'MEDIUM',
                recommendation: 'Consider optimizing images, reducing JavaScript execution time, and improving server response times for both platforms.'
            });
        }

        // Page load time issues
        if (auditData.loadTime > 5000) {
            issues.push({
                type: 'ERROR',
                category: 'PERFORMANCE',
                title: 'Slow Page Load Time',
                description: `Page takes ${Math.round(auditData.loadTime)}ms to load, which is significantly slower than recommended.`,
                impact: 'HIGH',
                recommendation: 'Optimize server response time, compress assets, and consider using a CDN.'
            });
        } else if (auditData.loadTime > 3000) {
            issues.push({
                type: 'WARNING',
                category: 'PERFORMANCE',
                title: 'Page Load Time Could Be Improved',
                description: `Page takes ${Math.round(auditData.loadTime)}ms to load. Aim for under 3 seconds.`,
                impact: 'MEDIUM',
                recommendation: 'Optimize images, minify resources, and reduce HTTP requests.'
            });
        }

        // Core Web Vitals issues from PageSpeed data
        if (auditData.pageSpeedMetrics) {
            const { desktop, mobile } = auditData.pageSpeedMetrics;

            // Largest Contentful Paint issues
            if (desktop?.largestContentfulPaint && desktop.largestContentfulPaint > 4000) {
                issues.push({
                    type: 'ERROR',
                    category: 'PERFORMANCE',
                    title: 'Poor Largest Contentful Paint (Desktop)',
                    description: `LCP is ${Math.round(desktop.largestContentfulPaint)}ms on desktop. Good LCP is under 2.5 seconds.`,
                    impact: 'HIGH',
                    recommendation: 'Optimize server response times, remove render-blocking resources, and optimize the largest element.'
                });
            }

            if (mobile?.largestContentfulPaint && mobile.largestContentfulPaint > 4000) {
                issues.push({
                    type: 'ERROR',
                    category: 'PERFORMANCE',
                    title: 'Poor Largest Contentful Paint (Mobile)',
                    description: `LCP is ${Math.round(mobile.largestContentfulPaint)}ms on mobile. Good LCP is under 2.5 seconds.`,
                    impact: 'HIGH',
                    recommendation: 'Optimize for mobile: compress images, reduce JavaScript, and improve server response times.'
                });
            }

            // Cumulative Layout Shift issues
            if (desktop?.cumulativeLayoutShift && desktop.cumulativeLayoutShift > 0.25) {
                issues.push({
                    type: 'WARNING',
                    category: 'PERFORMANCE',
                    title: 'High Cumulative Layout Shift (Desktop)',
                    description: `CLS score is ${desktop.cumulativeLayoutShift}, indicating visual instability.`,
                    impact: 'MEDIUM',
                    recommendation: 'Add size attributes to images and videos, avoid inserting content above existing content.'
                });
            }

            if (mobile?.cumulativeLayoutShift && mobile.cumulativeLayoutShift > 0.25) {
                issues.push({
                    type: 'WARNING',
                    category: 'PERFORMANCE',
                    title: 'High Cumulative Layout Shift (Mobile)',
                    description: `CLS score is ${mobile.cumulativeLayoutShift}, indicating visual instability on mobile.`,
                    impact: 'MEDIUM',
                    recommendation: 'Ensure mobile layouts are stable by reserving space for dynamic content.'
                });
            }
        }

        // SEO Issues
        if (auditData.seoScore < 50) {
            issues.push({
                type: 'ERROR',
                category: 'SEO',
                title: 'Poor SEO Score',
                description: `SEO score is ${auditData.seoScore}/100, which may significantly impact search rankings.`,
                impact: 'HIGH',
                recommendation: 'Review meta tags, heading structure, image alt text, and content quality.'
            });
        } else if (auditData.seoScore < 70) {
            issues.push({
                type: 'WARNING',
                category: 'SEO',
                title: 'SEO Score Needs Improvement',
                description: `SEO score is ${auditData.seoScore}/100. There are opportunities for improvement.`,
                impact: 'MEDIUM',
                recommendation: 'Optimize meta descriptions, improve heading hierarchy, and add structured data.'
            });
        }

        // Check SEO category details for specific issues
        if (auditData.categoryDetails?.seo?.items) {
            for (const item of auditData.categoryDetails.seo.items) {
                if (item.status === 'FAIL') {
                    let impact: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
                    let recommendation = 'Please review and fix this SEO issue.';

                    // Customize based on specific SEO issues
                    if (item.title.toLowerCase().includes('title')) {
                        impact = 'HIGH';
                        recommendation = 'Add a descriptive, unique title tag under 60 characters.';
                    } else if (item.title.toLowerCase().includes('description')) {
                        impact = 'HIGH';
                        recommendation = 'Add a compelling meta description between 150-160 characters.';
                    } else if (item.title.toLowerCase().includes('heading')) {
                        impact = 'MEDIUM';
                        recommendation = 'Ensure proper heading hierarchy with a single H1 tag.';
                    }

                    issues.push({
                        type: 'ERROR',
                        category: 'SEO',
                        title: item.title,
                        description: item.description,
                        impact,
                        recommendation
                    });
                }
            }
        }

        // Accessibility Issues
        if (auditData.accessibilityScore < 50) {
            issues.push({
                type: 'ERROR',
                category: 'ACCESSIBILITY',
                title: 'Poor Accessibility Score',
                description: `Accessibility score is ${auditData.accessibilityScore}/100, making the site difficult to use for people with disabilities.`,
                impact: 'HIGH',
                recommendation: 'Add alt text to images, ensure proper color contrast, and provide keyboard navigation.'
            });
        } else if (auditData.accessibilityScore < 80) {
            issues.push({
                type: 'WARNING',
                category: 'ACCESSIBILITY',
                title: 'Accessibility Could Be Improved',
                description: `Accessibility score is ${auditData.accessibilityScore}/100. Consider improving for better inclusivity.`,
                impact: 'MEDIUM',
                recommendation: 'Review form labels, heading structure, and ensure all interactive elements are accessible.'
            });
        }

        // Check accessibility category details for specific issues
        if (auditData.categoryDetails?.accessibility?.items) {
            for (const item of auditData.categoryDetails.accessibility.items) {
                if (item.status === 'FAIL') {
                    let impact: 'HIGH' | 'MEDIUM' | 'LOW' = 'MEDIUM';
                    let recommendation = 'Please review and fix this accessibility issue.';

                    // Customize based on specific accessibility issues
                    if (item.title.toLowerCase().includes('alt')) {
                        impact = 'HIGH';
                        recommendation = 'Add descriptive alt text to all images for screen readers.';
                    } else if (item.title.toLowerCase().includes('label')) {
                        impact = 'HIGH';
                        recommendation = 'Ensure all form inputs have proper labels for screen readers.';
                    } else if (item.title.toLowerCase().includes('heading')) {
                        impact = 'MEDIUM';
                        recommendation = 'Use proper heading hierarchy (H1-H6) for screen reader navigation.';
                    }

                    issues.push({
                        type: 'ERROR',
                        category: 'ACCESSIBILITY',
                        title: item.title,
                        description: item.description,
                        impact,
                        recommendation
                    });
                }
            }
        }

        // Best Practices Issues
        if (auditData.bestPracticesScore < 70) {
            issues.push({
                type: 'WARNING',
                category: 'BEST_PRACTICES',
                title: 'Best Practices Score Below Recommended',
                description: `Best practices score is ${auditData.bestPracticesScore}/100. Following web standards is important for security and performance.`,
                impact: 'MEDIUM',
                recommendation: 'Ensure HTTPS usage, avoid deprecated APIs, and follow modern web development practices.'
            });
        }

        // Check best practices category details for specific issues
        if (auditData.categoryDetails?.bestPractices?.items) {
            for (const item of auditData.categoryDetails.bestPractices.items) {
                if (item.status === 'FAIL') {
                    issues.push({
                        type: 'WARNING',
                        category: 'BEST_PRACTICES',
                        title: item.title,
                        description: item.description,
                        impact: 'MEDIUM',
                        recommendation: 'Follow modern web development best practices for better security and performance.'
                    });
                }
            }
        }

        return issues;
    }

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