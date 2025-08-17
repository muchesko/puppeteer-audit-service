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

type Issues = NonNullable<NonNullable<AuditResult['results']>['issues']>;

export class AuditService {
    private activeBrowser: Browser | null = null;
    private jobStatuses = new Map<string, string>();
    private jobResults = new Map<string, AuditResult>();
    private activeJobs = 0;
    private readonly maxConcurrentJobs = 1;

    // ---------- Utils ----------
    private sleep(ms: number) {
        return new Promise<void>(resolve => setTimeout(resolve, ms));
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
            try { if (fs.existsSync(p)) return p; } catch (_err) { /* ignore */ }
        }
        return undefined;
    }

    private async launchBrowser(): Promise<Browser> {
        const executablePath = this.pickExecutablePath();
        const usePipe = true; // pipe is lighter on small instances

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

            // keep Chrome lean + help avoid CodeRange OOM
            '--renderer-process-limit=1',
            '--js-flags=--jitless',

            // trim background work a bit more
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-ipc-flooding-protection',
            '--metrics-recording-only',
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
            try { await this.activeBrowser?.close(); } catch (_err) { /* ignore */ }
            this.activeBrowser = await this.launchBrowser();
        }
        return this.activeBrowser!;
    }

    // ---------- Public API ----------

    async startAudit(request: AuditRequest): Promise<void> {
        if (this.activeJobs >= this.maxConcurrentJobs) {
            throw new Error('Maximum concurrent jobs reached');
        }
        // fire-and-forget (no await) – guarded inside
        this.processAudit(request);
    }

    async getAuditStatus(jobId: string): Promise<string | null> {
        return this.jobStatuses.get(jobId) || null;
    }

    async getAuditDetails(jobId: string): Promise<AuditResult | null> {
        return this.jobResults.get(jobId) || null;
    }

    async cleanup(): Promise<void> {
        try { await this.activeBrowser?.close(); } catch (_err) { /* ignore */ }
        this.activeBrowser = null;
    }

    // ---------- Core flow ----------

    private async processAudit(request: AuditRequest): Promise<void> {
        this.activeJobs++;
        this.jobStatuses.set(request.jobId, 'PROCESSING');

        let page: Page | null = null;
        try {
            console.log(`[audit] job ${request.jobId} → ${request.websiteUrl}`);

            // Quick preflight so we don't spawn Chrome if URL is obviously dead.
            // Some sites block HEAD; if HEAD fails, try a small GET with a tiny timeout.
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 8_000);
                let ok = false;
                try {
                    const head = await fetch(request.websiteUrl, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
                    ok = head.ok;
                    console.log('[audit] preflight HEAD:', head.status);
                } catch (_err) {
                    // fallback to tiny GET
                    const getCtrl = new AbortController();
                    const t2 = setTimeout(() => getCtrl.abort(), 8_000);
                    const get = await fetch(request.websiteUrl, {
                        method: 'GET',
                        signal: getCtrl.signal,
                        redirect: 'follow',
                        headers: { 'Accept': 'text/html,*/*;q=0.1' },
                    }).catch(() => null);
                    clearTimeout(t2);
                    ok = !!get && get.ok;
                    console.log('[audit] preflight GET:', get?.status ?? 'n/a');
                }
                clearTimeout(t);
                if (!ok) throw new Error('Preflight request not OK');
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
                    await this.sleep(2_000);
                }
            }
            if (!browser) throw new Error('Browser failed to launch');

            // Create page with watchdog (fail fast if renderer dies)
            page = await this.createPageWithWatchdog(browser, 25_000);
            this.hookPageLogs(page);
            await this.setupPage(page);

            // Job-level watchdog so we never hang forever
            const jobWatchdog = new Promise<never>((_, rej) =>
                setTimeout(() => rej(new Error('Job watchdog timeout')), 180_000) // give heavy SPAs more time
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
            try { await page?.close({ runBeforeUnload: false }); } catch (_err) { /* ignore */ }

            // Try graceful browser close after each job to prevent leaks
            try {
                await this.activeBrowser?.close();
            } catch (_err) { /* ignore */ }

            // If Chrome is wedged, hard kill the child proc
            try { this.activeBrowser?.process()?.kill('SIGKILL'); } catch (_err) { /* ignore */ }
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

    private async setupPage(page: Page): Promise<void> {
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Upgrade-Insecure-Requests': '1',
        });

        // Keep layout consistent and avoid print/CSS surprises
        try { await page.emulateMediaType('screen'); } catch (_err) { /* ignore */ }

        // Block heavy/irrelevant stuff so “big” sites settle faster
        await page.setRequestInterception(true);
        const thirdPartyBlocklist = [
            'googletagmanager.com', 'google-analytics.com', 'doubleclick.net',
            'facebook.net', 'hotjar.com', 'fullstory.com', 'segment', 'mixpanel',
            'optimizely', 'stats.g', 'sentry.io', 'newrelic', 'datadog'
        ];
        page.on('request', (req) => {
            const url = req.url();
            const type = req.resourceType();
            const method = req.method();

            if (method === 'OPTIONS') return req.continue();

            const is3p = thirdPartyBlocklist.some(d => url.includes(d));
            if (is3p || type === 'image' || type === 'media' || type === 'font' || type === 'websocket') {
                return req.abort();
            }
            return req.continue();
        });

        // We drive our own budgets; don't rely on nav timeout
        page.setDefaultNavigationTimeout(0);
        page.setDefaultTimeout(60_000);
    }

    private async runSinglePageAudit(page: Page, request: AuditRequest): Promise<AuditResult> {
        const ua = request.options?.customUserAgent || config?.lighthouse?.settings?.emulatedUserAgent || 'Mozilla/5.0';
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

        console.log('[audit] navigating', request.websiteUrl);
        const response = await this.progressiveGoto(page, request.websiteUrl);
        console.log('[audit] navigation ok:', response?.status());

        // Ensure body exists (guards against blank documents)
        try { await page.waitForSelector('body', { timeout: 8_000 }); } catch (_err) { /* ignore */ }

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
        } catch (_err) { /* ignore */ }

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
                    if (title && title.length > 0 && title.length <= 60) score += 25;
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
            issues: [] as Issues,
        };

        return { jobId: request.jobId, status: 'COMPLETED', results };
    }

    // Forgiving navigation with a global time budget and "ready enough" checks
    private async progressiveGoto(page: Page, url: string): Promise<HTTPResponse | null> {
        // "Ready enough" = body exists + document is interactive or complete
        const considerReady = async () => {
            try {
                return await page.evaluate(() => {
                    const rs = document.readyState;
                    return !!document.body && (rs === 'interactive' || rs === 'complete');
                });
            } catch {
                return false;
            }
        };

        // Global budget so we never blow up on slow sites
        const totalBudgetMs = 120_000; // was effectively ~70–90s; now more tolerant
        const start = Date.now();

        const attempts: Array<{ name: string; opts: Parameters<Page['goto']>[1] }> = [
            { name: 'domcontentloaded', opts: { waitUntil: 'domcontentloaded', timeout: 30_000 } },
            { name: 'load', opts: { waitUntil: 'load', timeout: 35_000 } },
            { name: 'basic', opts: { timeout: 20_000 } }, // no waitUntil
        ];

        let lastResponse: HTTPResponse | null = null;

        for (let i = 0; i < attempts.length; i++) {
            const { name, opts } = attempts[i];
            if (Date.now() - start >= totalBudgetMs) break;

            try {
                console.log(`[audit] goto (${name})`, opts);
                const nav = page.goto(url, opts as any);

                // Per-attempt watchdog: don't let a single strategy eat all time
                const remaining = Math.max(5_000,
                    Math.min(totalBudgetMs - (Date.now() - start), (opts?.timeout as number) ?? 30_000)
                );
                const watchdog = new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error('attempt timeout')), remaining)
                );

                lastResponse = await Promise.race([nav, watchdog]) as HTTPResponse | null;

                // If the HTTP status is OK, run a short settle window
                if (lastResponse && lastResponse.status() < 400) {
                    // Ensure DOM is present
                    try { await page.waitForSelector('body', { timeout: 5_000 }); } catch { }

                    // 10s settle loop for SPA hydration / late scripts
                    const settleUntil = Date.now() + 10_000; // was 0.5–5s; this is more forgiving
                    while (Date.now() < settleUntil) {
                        if (await considerReady()) return lastResponse;
                        await new Promise(r => setTimeout(r, 200));
                    }

                    // Final immediate check
                    if (await considerReady()) return lastResponse;

                    // On last attempt, try a hard reload to break weird soft-navigation states
                    if (i === attempts.length - 1 && (Date.now() - start) < totalBudgetMs - 5_000) {
                        console.log('[audit] final attempt: hard reload');
                        await page.reload({ waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => undefined);
                        if (await considerReady()) return lastResponse;
                    }
                } else {
                    console.warn(`[audit] goto (${name}) status ${lastResponse?.status()}`);
                }
            } catch (e) {
                console.warn(`[audit] goto (${name}) failed:`, (e as Error).message);
                continue;
            }
        }

        if (lastResponse) return lastResponse; // fall back to the best we saw
        throw new Error('Navigation failed after multiple strategies');
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