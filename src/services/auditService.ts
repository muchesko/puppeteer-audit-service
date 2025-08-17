import puppeteer, {
    type LaunchOptions,
    type Browser,
    type Page,
    type HTTPResponse
} from 'puppeteer';
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
    private readonly maxConcurrentJobs = 1; // Limit to 1 job for nano instance

    // --- Blocking + stealth config ---
    private readonly BLOCKED_RESOURCE_TYPES = new Set([
        'image', 'media', 'font', 'stylesheet', 'websocket'
    ]);
    private readonly BLOCKED_URL_SUBSTRINGS = [
        'doubleclick', 'googletagmanager', 'googletagservices', 'google-analytics',
        'facebook.com/tr', 'hotjar', 'segment.com', 'amplitude', 'mixpanel',
        'optimizely', 'newrelic', 'adservice', 'adsystem', 'taboola', 'outbrain'
    ];

    private pickExecutablePath(): string | undefined {
        const candidates = [
            process.env.PUPPETEER_EXECUTABLE_PATH,
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
        ].filter(Boolean) as string[];

        for (const p of candidates) {
            try {
                if (fs.existsSync(p)) return p;
            } catch { }
        }
        return undefined; // falls back to puppeteer default if present
    }

    async getBrowser(): Promise<Browser> {
        if (!this.activeBrowser || !this.activeBrowser.isConnected()) {
            // Clean up any existing browser first
            if (this.activeBrowser) {
                try {
                    await this.activeBrowser.close();
                } catch (error) {
                    console.warn('Failed to close existing browser:', error);
                }
                this.activeBrowser = null;
            }

            const executablePath = this.pickExecutablePath();

            const usePipe = false;
            console.log({
                node: process.version,
                executablePath: executablePath ?? '(not found)',
                pipeMode: usePipe,
                timestamp: new Date().toISOString()
            });

            // Ensure user-data-dir exists
            try { fs.mkdirSync('/tmp/chrome-data', { recursive: true }); } catch { }

            // IMPORTANT: make this a mutable string[]
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
                '--window-size=1366,768',
                '--force-color-profile=srgb',
                '--allow-pre-commit-input',
            ];

            // Also: DO NOT use `as const` on launchOpts
            const launchOpts: LaunchOptions = {
                headless: true,
                pipe: usePipe,         // false => WebSocket transport
                executablePath,
                args,
                timeout: 120_000,          // Increased for nano instances
                protocolTimeout: 180_000,  // Significantly increased for nano instances
                dumpio: true               // Enable dumpio to log
            };

            this.activeBrowser = await puppeteer.launch(launchOpts);
        }
        return this.activeBrowser!;
    }

    async startAudit(request: AuditRequest): Promise<void> {
        // Check concurrency limit
        if (this.activeJobs >= this.maxConcurrentJobs) {
            throw new Error('Maximum concurrent jobs reached');
        }

        // Start processing the audit asynchronously
        this.processAudit(request);
    }

    async processAudit(request: AuditRequest): Promise<void> {
        this.activeJobs++;
        this.jobStatuses.set(request.jobId, 'PROCESSING');

        try {
            console.log(`Processing audit for ${request.websiteUrl} (Job: ${request.jobId})`);

            // Fast DNS/egress preflight so we don't spin up Chrome if the URL is unreachable
            try {
                const pre = await fetch(request.websiteUrl, { method: 'HEAD' });
                console.log('[audit] preflight HEAD status:', pre.status);
            } catch (e) {
                throw new Error(`Preflight failed (network/DNS): ${(e as Error).message}`);
            }

            // Single retry attempt only to avoid resource exhaustion
            let browser: Browser;
            let retryCount = 0;
            const maxRetries = 2; // Reduced retries

            while (retryCount < maxRetries) {
                try {
                    console.log(`Browser launch attempt ${retryCount + 1}/${maxRetries}`);
                    browser = await this.getBrowser();
                    console.log(`Browser launch successful on attempt ${retryCount + 1}`);
                    break;
                } catch (error) {
                    retryCount++;
                    console.error(`Browser launch attempt ${retryCount} failed:`, error);

                    if (retryCount >= maxRetries) {
                        throw new Error(`Failed to launch browser after ${maxRetries} attempts`);
                    }

                    // Don't close the shared browser - just wait and retry
                    const backoffTime = 2000 * retryCount;
                    console.log(`Waiting ${backoffTime}ms before retry ${retryCount + 1}`);
                    await new Promise(resolve => setTimeout(resolve, backoffTime));
                }
            }

            // Use single page for entire audit process
            const page = await browser!.newPage();
            console.log('[audit] page created');

            page.on('console', m => console.log('[console]', m.type(), m.text()));
            page.on('pageerror', e => console.warn('[pageerror]', e.message));
            page.on('requestfailed', r => console.warn('[requestfailed]', r.url(), r.failure()?.errorText));

            // Page hardening for JS-heavy sites
            await this.applyStealthShims(page);
            await this.enableRequestInterception(page);

            try {
                const jobDeadlineMs = 180_000; // 3 minute job watchdog for heavy sites
                const watchdog = new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error('Job watchdog timeout')), jobDeadlineMs)
                );

                const resultPayload = await Promise.race([
                    (async () => {
                        // Configure page once with error handling
                        const userAgent = request.options?.customUserAgent ||
                            config.lighthouse.settings.emulatedUserAgent;

                        console.log('[audit] setUserAgent');
                        await page.setUserAgent(userAgent);
                        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

                        console.log('[audit] setViewport');
                        if (request.options?.mobile) {
                            await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
                        } else {
                            await page.setViewport({ width: 1366, height: 768, deviceScaleFactor: 1 });
                        }

                        console.log('[audit] set timeouts');
                        await page.setDefaultTimeout(60_000);
                        await page.setDefaultNavigationTimeout(60_000);

                        console.log('[audit] running audit on', request.websiteUrl);
                        // Run audit on the same page instance
                        const lighthouseResult = await this.runLighthouseAudit(page, request.websiteUrl);

                        // Take screenshot if requested (on same page)
                        let screenshot: string | undefined;
                        if (request.options?.includeScreenshot) {
                            try {
                                await this.waitForNetworkQuiet(page, 1000, 2, 8000).catch(() => { });
                                const buf = await page.screenshot({ type: 'png', fullPage: false });
                                screenshot = Buffer.from(buf).toString('base64');
                            } catch (error) {
                                console.warn('Screenshot failed:', error);
                            }
                        }

                        const auditResult: AuditResult = {
                            jobId: request.jobId,
                            status: 'COMPLETED',
                            results: {
                                performanceScore: lighthouseResult.performance,
                                seoScore: lighthouseResult.seo,
                                accessibilityScore: lighthouseResult.accessibility,
                                bestPracticesScore: lighthouseResult.bestPractices,
                                issues: lighthouseResult.issues,
                                metrics: lighthouseResult.metrics,
                                pagesCrawled: 1,
                                screenshot
                            }
                        };

                        return auditResult;
                    })(),
                    watchdog
                ]);

                // Persist + callback on success
                this.jobStatuses.set(request.jobId, 'COMPLETED');
                this.jobResults.set(request.jobId, resultPayload);
                console.log(`Audit completed for job ${request.jobId}:`, {
                    performance: resultPayload.results?.performanceScore,
                    seo: resultPayload.results?.seoScore,
                    accessibility: resultPayload.results?.accessibilityScore,
                    bestPractices: resultPayload.results?.bestPracticesScore
                });
                this.sendCallback(resultPayload).catch(err => console.warn('Callback error (ignored):', err));

            } finally {
                // Always close the page
                try {
                    await page.close();
                } catch (error) {
                    console.warn('Page close error (ignored):', error);
                }

                // Close browser after each job to prevent memory leaks
                try {
                    if (this.activeBrowser) {
                        await this.activeBrowser.close();
                        this.activeBrowser = null;
                        console.log('Browser closed after job completion');
                    }
                } catch (error) {
                    console.warn('Browser close error (ignored):', error);
                }
            }

        } catch (error) {
            // Handle errors + callback
            this.jobStatuses.set(request.jobId, 'FAILED');
            const errorResult: AuditResult = {
                jobId: request.jobId,
                status: 'FAILED',
                results: undefined,
                error: error instanceof Error ?
                    `${error.name}: ${error.message}` :
                    'Unknown audit error'
            };
            this.jobResults.set(request.jobId, errorResult);
            console.error(`Audit failed for job ${request.jobId}:`, error);
            this.sendCallback(errorResult).catch(err => console.warn('Callback error (ignored):', err));
        } finally {
            this.activeJobs--;
        }
    }

    // --- Robust navigation + analysis with soft idle and consent handling ---
    private async runLighthouseAudit(page: Page, url: string) {
        try {
            console.log('[audit] starting progressive navigation to', url);

            const navStrategies: Array<{ name: string; waitUntil?: 'domcontentloaded' | 'load' | 'networkidle2'; navTimeout: number; quietTimeout: number; }> = [
                { name: 'domcontentloaded+quiet', waitUntil: 'domcontentloaded', navTimeout: 25_000, quietTimeout: 15_000 },
                { name: 'load+quiet', waitUntil: 'load', navTimeout: 35_000, quietTimeout: 15_000 },
                { name: 'networkidle2+quiet', waitUntil: 'networkidle2', navTimeout: 45_000, quietTimeout: 10_000 },
                { name: 'basic+quiet', waitUntil: undefined, navTimeout: 20_000, quietTimeout: 12_000 },
            ];

            try { await page.setBypassCSP(true); } catch { }

            let response: HTTPResponse | null = null;
            let navOk = false;
            let lastError: unknown = null;

            for (const strat of navStrategies) {
                try {
                    console.log(`[audit] navigating with strategy "${strat.name}"`);
                    const opts: any = { timeout: strat.navTimeout };
                    if (strat.waitUntil) opts.waitUntil = strat.waitUntil;

                    response = await page.goto(url, opts);
                    const status = response?.status() ?? 0;
                    if (!response || status >= 400) {
                        throw new Error(`Bad response status ${status} with ${strat.name}`);
                    }

                    // wait for <body> and then soft network idle
                    await page.waitForSelector('body', { timeout: 8000 }).catch(() => { });
                    await this.waitForNetworkQuiet(page, 1200, 2, strat.quietTimeout).catch(() => { });

                    // Heuristic content check
                    const contentOk = await page.evaluate(() => {
                        const b = document.body;
                        if (!b) return false;
                        const textLen = (b.innerText || '').trim().length;
                        const hasH1 = !!document.querySelector('h1');
                        return textLen > 50 || hasH1;
                    });

                    if (!contentOk) {
                        throw new Error(`Content heuristic failed on "${strat.name}"`);
                    }

                    navOk = true;
                    break;
                } catch (e) {
                    lastError = e;
                    console.warn(`[audit] strategy "${strat.name}" failed:`, (e as Error).message);
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
            }

            if (!navOk) {
                console.warn('[audit] all JS navigation strategies failed, attempting HTML-only fallback');
                return await this.runHtmlOnlyFallback(page, url, lastError);
            }

            // Try to dismiss common consent overlays (best-effort)
            try {
                await page.evaluate(() => {
                    const selectors = [
                        'button[aria-label*="accept"]',
                        'button:where([id*="accept"],[class*="accept"]):not([disabled])',
                        'button:where([id*="agree"],[class*="agree"])',
                        'button:where([id*="allow"],[class*="allow"])',
                        '[role="button"][data-testid*="accept"]'
                    ];
                    for (const sel of selectors) {
                        const btn = document.querySelector(sel) as HTMLButtonElement | null;
                        if (btn) { btn.click(); break; }
                    }
                });
            } catch { }

            // Collect metrics safely
            let loadTime = 0;
            try {
                const perfNav = await page.evaluate(() => {
                    try {
                        const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
                        if (entries && entries[0]) {
                            return { loadEventEnd: entries[0].loadEventEnd };
                        }
                    } catch { }
                    return { loadEventEnd: 0 };
                });
                loadTime = perfNav.loadEventEnd || 0;
            } catch { }

            // crude perf score from load time (ms)
            const performanceScore = Math.max(0, Math.min(100, 100 - Math.floor(loadTime / 100)));

            // SEO checks (guarded)
            const seoScore = await page.evaluate(() => {
                try {
                    const title = document.title || '';
                    const metaDescription = document.querySelector('meta[name="description"]');
                    const h1s = document.querySelectorAll('h1');
                    let score = 0;
                    if (title && title.length > 0 && title.length < 60) score += 25;
                    if (metaDescription && metaDescription.getAttribute('content')) score += 25;
                    if (h1s.length === 1) score += 25;
                    if (document.querySelector('meta[name="viewport"]')) score += 25;
                    return score;
                } catch { return 50; }
            }).catch(() => 50);

            // Accessibility proxy (guarded)
            const accessibilityScore = await page.evaluate(() => {
                try {
                    const imgs = Array.from(document.querySelectorAll('img'));
                    const buttons = Array.from(document.querySelectorAll('button'));
                    let score = 100;
                    imgs.forEach(img => { if (!img.getAttribute('alt')) score -= 10; });
                    buttons.forEach(btn => { if (!(btn.textContent || '').trim() && !btn.getAttribute('aria-label')) score -= 5; });
                    return Math.max(0, score);
                } catch { return 70; }
            }).catch(() => 70);

            return {
                performance: Math.round(performanceScore),
                seo: seoScore,
                accessibility: Math.round(accessibilityScore),
                bestPractices: 75, // Default score
                metrics: {
                    loadTime,
                    cumulativeLayoutShift: 0 // Simplified
                },
                issues: []
            };

        } catch (error) {
            console.error('Audit failed:', error);
            throw error;
        }
    }

    // --- HTML-only fallback when JS rendering fails ---
    private async runHtmlOnlyFallback(page: Page, url: string, reason?: unknown) {
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 15_000);
            const res = await fetch(url, { method: 'GET', signal: controller.signal });
            clearTimeout(t);

            const status = res.status;
            if (!res.ok) throw new Error(`fallback fetch status ${status}`);
            const html = await res.text();

            await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => { });
            // crude proxy for load time based on content size
            const textLen = html.replace(/<[^>]*>/g, '').trim().length;
            const loadTime = Math.min(5000, Math.max(500, Math.floor(textLen / 5)));

            const seo = await page.evaluate(() => {
                try {
                    const title = document.title || '';
                    const metaDescription = document.querySelector('meta[name="description"]');
                    const h1s = document.querySelectorAll('h1');
                    let score = 0;
                    if (title && title.length > 0 && title.length < 60) score += 25;
                    if (metaDescription && metaDescription.getAttribute('content')) score += 25;
                    if (h1s.length === 1) score += 25;
                    if (document.querySelector('meta[name="viewport"]')) score += 25;
                    return score;
                } catch { return 50; }
            }).catch(() => 50);

            const accessibility = await page.evaluate(() => {
                try {
                    const imgs = Array.from(document.querySelectorAll('img'));
                    let score = 100;
                    imgs.forEach(img => { if (!img.getAttribute('alt')) score -= 10; });
                    return Math.max(0, score);
                } catch { return 70; }
            }).catch(() => 70);

            return {
                performance: Math.max(10, 100 - Math.floor(loadTime / 100)),
                seo,
                accessibility: Math.round(accessibility),
                bestPractices: 70,
                metrics: { loadTime, cumulativeLayoutShift: 0 },
                issues: []
            };
        } catch (e) {
            console.error('[audit:fallback] failed:', e, 'original reason:', reason);
            throw (reason instanceof Error ? reason : e);
        }
    }

    // --- Helpers: interception, soft idle, stealth shims ---
    private async enableRequestInterception(page: Page) {
        await page.setRequestInterception(true);
        page.on('request', req => {
            const url = req.url().toLowerCase();
            const type = req.resourceType();
            if (this.BLOCKED_RESOURCE_TYPES.has(type)) return req.abort();
            if (this.BLOCKED_URL_SUBSTRINGS.some(s => url.includes(s))) return req.abort();
            return req.continue();
        });
    }

    // Wait for a quiet network window (soft network idle)
    private async waitForNetworkQuiet(page: Page, idleMs = 1200, maxInflight = 2, overallTimeout = 30000) {
        let inflight = 0;
        let resolveQuiet!: () => void;
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        let quietTimer: ReturnType<typeof setTimeout> | null = null;

        const clean = () => {
            page.off('request', onReq);
            page.off('requestfinished', onDone);
            page.off('requestfailed', onDone);
            if (timeoutId) clearTimeout(timeoutId);
            if (quietTimer) clearTimeout(quietTimer);
        };

        const onReq = () => {
            inflight++;
            if (quietTimer) {
                clearTimeout(quietTimer);
                quietTimer = null;
            }
        };
        const onDone = () => {
            inflight = Math.max(0, inflight - 1);
            if (inflight <= maxInflight) {
                if (quietTimer) clearTimeout(quietTimer);
                quietTimer = setTimeout(() => { clean(); resolveQuiet(); }, idleMs);
            }
        };

        const overall = new Promise<void>((_, rej) => {
            timeoutId = setTimeout(() => {
                clean();
                rej(new Error('waitForNetworkQuiet: overall timeout'));
            }, overallTimeout);
        });

        const quiet = new Promise<void>(res => { resolveQuiet = res; });

        page.on('request', onReq);
        page.on('requestfinished', onDone);
        page.on('requestfailed', onDone);

        // kick the quiet timer if nothing is in flight
        if (inflight <= maxInflight) {
            quietTimer = setTimeout(() => { clean(); resolveQuiet(); }, idleMs);
        }

        await Promise.race([quiet, overall]).finally(clean);
    }

    private async applyStealthShims(page: Page) {
        await page.evaluateOnNewDocument(() => {
            // @ts-ignore
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            // @ts-ignore
            // some sites check for window.chrome
            window.chrome = { runtime: {} };
            // fake languages/plugins
            // @ts-ignore
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            // @ts-ignore
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
        });
    }

    private extractIssues(lhr: any) {
        const issues: Array<{
            type: 'ERROR' | 'WARNING' | 'INFO';
            category: 'PERFORMANCE' | 'SEO' | 'ACCESSIBILITY' | 'BEST_PRACTICES';
            title: string;
            description: string;
            impact: 'HIGH' | 'MEDIUM' | 'LOW';
            recommendation: string;
        }> = [];

        // Extract performance issues
        const performanceAudits = ['largest-contentful-paint', 'first-contentful-paint', 'speed-index'];
        for (const auditId of performanceAudits) {
            const audit = lhr.audits[auditId];
            if (audit && audit.score !== null && audit.score < 0.9) {
                issues.push({
                    type: audit.score < 0.5 ? 'ERROR' : 'WARNING',
                    category: 'PERFORMANCE',
                    title: audit.title,
                    description: audit.description,
                    impact: audit.score < 0.5 ? 'HIGH' : audit.score < 0.75 ? 'MEDIUM' : 'LOW',
                    recommendation: audit.displayValue || 'Optimize this metric'
                });
            }
        }

        return issues;
    }

    private async sendCallback(result: AuditResult): Promise<void> {
        if (!config.callbackUrl) {
            console.log('No callback URL configured, skipping callback');
            return;
        }

        try {
            console.log(`[callback] sending result for job ${result.jobId}`);
            const body = JSON.stringify(result);
            const signature = crypto
                .createHmac('sha256', config.webhookSecret)
                .update(body)
                .digest('hex');

            // Add timeout to prevent hanging
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15_000);

            try {
                const response = await fetch(config.callbackUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Signature': `sha256=${signature}`,
                        'X-API-Key': config.apiKey
                    },
                    body,
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    console.error(`[callback] failed: ${response.status} ${response.statusText}`);
                    const responseText = await response.text().catch(() => 'no response body');
                    console.error(`[callback] response body: ${responseText}`);
                } else {
                    console.log(`[callback] sent successfully for job ${result.jobId}`);
                }
            } catch (fetchError) {
                clearTimeout(timeoutId);
                throw fetchError;
            }

        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                console.error(`[callback] timeout for job ${result.jobId}`);
            } else {
                console.error(`[callback] error for job ${result.jobId}:`, error);
            }
        }
    }

    async getAuditStatus(jobId: string): Promise<string | null> {
        return this.jobStatuses.get(jobId) || null;
    }

    async getAuditDetails(jobId: string): Promise<AuditResult | null> {
        return this.jobResults.get(jobId) || null;
    }

    async cleanup(): Promise<void> {
        if (this.activeBrowser) {
            await this.activeBrowser.close();
            this.activeBrowser = null;
        }
    }
}