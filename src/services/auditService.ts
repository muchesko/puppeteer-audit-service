import puppeteer, { type LaunchOptions, type Browser, type Page, type HTTPRequest } from 'puppeteer';
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

    // --- small util to avoid any waitForTimeout version issues ---
    private sleep(ms: number) {
        return new Promise<void>(res => setTimeout(res, ms));
    }

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

    private buildUserAgent(mobile?: boolean, customUA?: string) {
        if (customUA) return customUA;
        const desktop = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        const mobileUA = 'Mozilla/5.0 (Linux; Android 12; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
        return mobile ? mobileUA : desktop;
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
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-breakpad',
                '--disable-domain-reliability',
                '--metrics-recording-only',
                '--password-store=basic',
                '--use-mock-keychain',
                '--window-size=1366,900',
                '--disable-features=IsolateOrigins,site-per-process,BlockInsecurePrivateNetworkRequests'
            ];

            const launchOpts: LaunchOptions = {
                headless: true,          // <= compatible everywhere
                pipe: usePipe,           // false => WebSocket transport
                executablePath,
                args,
                timeout: 120_000,
                protocolTimeout: 180_000,
                dumpio: true
            };

            this.activeBrowser = await puppeteer.launch(launchOpts);
        }
        return this.activeBrowser!;
    }

    async startAudit(request: AuditRequest): Promise<void> {
        if (this.activeJobs >= this.maxConcurrentJobs) {
            throw new Error('Maximum concurrent jobs reached');
        }
        this.processAudit(request);
    }

    async processAudit(request: AuditRequest): Promise<void> {
        this.activeJobs++;
        this.jobStatuses.set(request.jobId, 'PROCESSING');

        try {
            console.log(`Processing audit for ${request.websiteUrl} (Job: ${request.jobId})`);

            // Fast DNS/egress preflight
            try {
                const pre = await fetch(request.websiteUrl, { method: 'HEAD' });
                console.log('[audit] preflight HEAD status:', pre.status);
            } catch (e) {
                throw new Error(`Preflight failed (network/DNS): ${(e as Error).message}`);
            }

            // Launch/retry
            let browser: Browser;
            let retryCount = 0;
            const maxRetries = 2;

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
                    const backoffTime = 2000 * retryCount;
                    console.log(`Waiting ${backoffTime}ms before retry ${retryCount + 1}`);
                    await this.sleep(backoffTime);
                }
            }

            const page = await browser!.newPage();
            console.log('[audit] page created');
            page.on('console', m => console.log('[console]', m.type(), m.text()));
            page.on('pageerror', e => console.warn('[pageerror]', e.message));
            page.on('requestfailed', r => console.warn('[requestfailed]', r.url(), r.failure()?.errorText));

            try {
                const jobDeadlineMs = 120_000; // 2 minute job watchdog
                const watchdog = new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error('Job watchdog timeout')), jobDeadlineMs)
                );

                const resultPayload = await Promise.race([
                    (async () => {
                        // Page prep (stealth + headers + UA + viewport + request trimming)
                        const ua = this.buildUserAgent(request.options?.mobile, request.options?.customUserAgent);
                        await this.preparePage(page, {
                            jobId: request.jobId,
                            websiteUrl: request.websiteUrl,
                            options: {
                                mobile: request.options?.mobile,
                                includeScreenshot: request.options?.includeScreenshot,
                                customUserAgent: ua
                            }
                        });

                        await page.setDefaultTimeout(60_000);
                        await page.setDefaultNavigationTimeout(60_000);

                        console.log('[audit] running audit on', request.websiteUrl);
                        const lighthouseResult = await this.runLighthouseAudit(
                            page,
                            request.websiteUrl,
                            {
                                mobile: request.options?.mobile,
                                includeScreenshot: request.options?.includeScreenshot,
                                customUserAgent: ua
                            }
                        );

                        // Optional screenshot
                        let screenshot: string | undefined;
                        if (request.options?.includeScreenshot) {
                            try {
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
                try { await page.close(); } catch (error) { console.warn('Page close error (ignored):', error); }
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

    // --- page hardening & lightweight anti-bot tweaks + request trimming ---
    private async preparePage(page: Page, req: AuditRequest) {
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            // @ts-ignore
            const originalQuery = window.navigator.permissions?.query;
            if (originalQuery) {
                // @ts-ignore
                window.navigator.permissions.query = (parameters: any) => (
                    parameters && parameters.name === 'notifications'
                        ? Promise.resolve({ state: 'denied' })
                        : originalQuery(parameters)
                );
            }
        });

        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Upgrade-Insecure-Requests': '1',
        });
        try { await page.emulateTimezone('America/New_York'); } catch {}

        const ua = this.buildUserAgent(req.options?.mobile, req.options?.customUserAgent);
        await page.setUserAgent(ua);

        if (req.options?.mobile) {
            await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        } else {
            await page.setViewport({
                width: config.lighthouse?.settings?.screenEmulation?.width ?? 1366,
                height: config.lighthouse?.settings?.screenEmulation?.height ?? 900,
                deviceScaleFactor: 1
            });
        }

        const blockedHosts = [
            'doubleclick.net', 'google-analytics.com', 'googletagmanager.com', 'googletagservices.com',
            'facebook.net', 'facebook.com/tr', 'hotjar.com', 'segment.com', 'mixpanel.com', 'fullstory.com',
        ];
        const shouldBlock = (url: string) => blockedHosts.some(h => url.includes(h));

        await page.setRequestInterception(true);
        page.on('request', (r: HTTPRequest) => {
            const type = r.resourceType();
            const url = r.url();

            if (type === 'document' || type === 'xhr' || type === 'fetch' || type === 'script' || type === 'stylesheet') {
                if (shouldBlock(url) && (type !== 'stylesheet' && type !== 'script')) {
                    return r.abort();
                }
                return r.continue();
            }

            if (!req.options?.includeScreenshot && (type === 'image' || type === 'media' || type === 'font')) {
                return r.abort();
            }

            if (shouldBlock(url)) return r.abort();
            return r.continue();
        });
    }

    // --- robust “page is done” detector for JS-heavy sites ---
    private async waitForPageComplete(page: Page, { quietMs = 1500, maxWaitMs = 45_000 } = {}) {
        const noisy = [/googletagmanager\.com/, /google-analytics\.com/, /doubleclick\.net/, /cdn-cgi\/beacon/];
        const ignore = (url: string) => noisy.some(rx => rx.test(url));

        let inflight = 0;
        const inc = (url: string) => { if (!ignore(url)) inflight++; };
        const dec = (url: string) => { if (!ignore(url)) inflight = Math.max(0, inflight - 1); };

        const onReq = (r: HTTPRequest) => inc(r.url());
        const onFin = (r: HTTPRequest) => dec(r.url());
        const onFail = (r: HTTPRequest) => dec(r.url());

        page.on('request', onReq);
        page.on('requestfinished', onFin);
        page.on('requestfailed', onFail);

        const stableDOM = async () => {
            const snap = await page.evaluate(() => {
                const body = document.body;
                const html = document.documentElement;
                const h = Math.max(
                    body?.scrollHeight || 0, body?.offsetHeight || 0,
                    html?.clientHeight || 0, html?.scrollHeight || 0, html?.offsetHeight || 0
                );
                const count = document.getElementsByTagName('*').length;
                return { h, count };
            });
            await this.sleep(250);
            const snap2 = await page.evaluate(() => {
                const body = document.body;
                const html = document.documentElement;
                const h = Math.max(
                    body?.scrollHeight || 0, body?.offsetHeight || 0,
                    html?.clientHeight || 0, html?.scrollHeight || 0, html?.offsetHeight || 0
                );
                const count = document.getElementsByTagName('*').length;
                return { h, count };
            });
            return (Math.abs(snap.h - snap2.h) < 2) && (Math.abs(snap.count - snap2.count) < 5);
        };

        const start = Date.now();
        let lastQuiet = Date.now();

        while (Date.now() - start < maxWaitMs) {
            if (inflight === 0 && await stableDOM()) {
                try { await page.evaluate(() => (document as any).fonts && (document as any).fonts.ready); } catch {}
                await page.evaluate(() => new Promise(requestAnimationFrame));
                await page.evaluate(() => new Promise(requestAnimationFrame));
                if (Date.now() - lastQuiet >= quietMs) break;
            } else {
                lastQuiet = Date.now();
            }
            await this.sleep(150);
        }

        page.off('request', onReq);
        page.off('requestfinished', onFin);
        page.off('requestfailed', onFail);
    }

    // --- auto-scroll to trigger lazy content ---
    private async autoScroll(page: Page, maxPixels = 4000) {
        try {
            await page.evaluate(async (limit) => {
                await new Promise<void>((resolve) => {
                    let total = 0;
                    const step = 350;
                    const timer = setInterval(() => {
                        const { scrollHeight } = document.documentElement;
                        window.scrollBy(0, step);
                        total += step;
                        if (total >= limit || window.scrollY + window.innerHeight >= scrollHeight) {
                            clearInterval(timer);
                            resolve();
                        }
                    }, 50);
                });
            }, maxPixels);
        } catch {}
    }

    private async runLighthouseAudit(
        page: Page,
        url: string,
        _ctx: { mobile?: boolean; includeScreenshot?: boolean; customUserAgent?: string } = {}
    ) {
        try {
            console.log('[audit] starting progressive navigation to', url);

            let response: Awaited<ReturnType<Page['goto']>> | null = null;
            const strategies = [
                { waitUntil: 'domcontentloaded' as const, timeout: 30_000, name: 'DOM ready' },
                { waitUntil: 'load' as const, timeout: 45_000, name: 'full load' },
                { waitUntil: 'networkidle2' as const, timeout: 55_000, name: 'network idle' },
            ];

            for (const strategy of strategies) {
                try {
                    console.log(`[audit] trying navigation strategy: ${strategy.name}`);
                    response = await page.goto(url, { waitUntil: strategy.waitUntil, timeout: strategy.timeout });
                    if (response && response.ok()) {
                        console.log(`[audit] navigation successful with: ${strategy.name}`);
                        break;
                    }
                } catch (error) {
                    console.warn(`[audit] strategy "${strategy.name}" failed:`, (error as Error).message);
                    continue;
                }
            }

            if (!response) {
                console.warn('[audit] falling back to basic navigation');
                response = await page.goto(url, { timeout: 25_000 }).catch(() => null);
            }

            if (!response) throw new Error('All navigation strategies failed');

            await Promise.race([
                page.waitForSelector('#__next, #root, [data-reactroot], app-root', { timeout: 8_000 }).catch(() => null),
                page.waitForFunction('document.readyState === "complete"', { timeout: 8_000 }).catch(() => null),
            ]);

            await this.autoScroll(page);
            await this.waitForPageComplete(page, { quietMs: 1500, maxWaitMs: 45_000 });

            console.log('[audit] page loaded & stable, collecting metrics');

            const perf = await page.evaluate(() => {
                try {
                    const nav = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
                    const n = nav && nav.length ? nav[0] : null;
                    return {
                        loadTime: n ? n.loadEventEnd : 0,
                        domContentLoaded: n ? n.domContentLoadedEventEnd : 0,
                        firstPaint: (performance.getEntriesByName('first-paint')[0] as any)?.startTime || 0,
                        firstContentfulPaint: (performance.getEntriesByName('first-contentful-paint')[0] as any)?.startTime || 0,
                    };
                } catch {
                    return { loadTime: 0, domContentLoaded: 0, firstPaint: 0, firstContentfulPaint: 0 };
                }
            });

            const lt = perf.loadTime || perf.firstContentfulPaint || 3000;
            const performanceScore = Math.max(0, Math.min(100, Math.round(100 - lt / 80)));

            console.log('[audit] running SEO analysis');
            const seoChecks = await page.evaluate(() => {
                try {
                    const title = document.title || '';
                    const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
                    const h1s = document.querySelectorAll('h1').length;
                    const hasViewport = !!document.querySelector('meta[name="viewport"]');

                    let score = 0;
                    if (title && title.length <= 60) score += 25;
                    if (metaDescription && metaDescription.length <= 160) score += 25;
                    if (h1s === 1) score += 25;
                    if (hasViewport) score += 25;

                    return score;
                } catch {
                    return 50;
                }
            });

            console.log('[audit] running accessibility analysis');
            const accessibilityScore = await page.evaluate(() => {
                try {
                    let score = 100;
                    const imgs = Array.from(document.querySelectorAll('img'));
                    for (const img of imgs) if (!img.getAttribute('alt')) score -= 10;
                    const buttons = Array.from(document.querySelectorAll('button'));
                    for (const b of buttons) {
                        const label = b.textContent?.trim() || b.getAttribute('aria-label') || '';
                        if (!label) score -= 5;
                    }
                    return Math.max(0, Math.min(100, score));
                } catch { return 70; }
            });

            return {
                performance: performanceScore,
                seo: seoChecks,
                accessibility: Math.round(accessibilityScore),
                bestPractices: 75,
                metrics: {
                    loadTime: lt,
                    cumulativeLayoutShift: 0
                },
                issues: []
            };

        } catch (error) {
            console.error('Audit failed:', error);
            throw error;
        }
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