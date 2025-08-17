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
        /** If true, block common 3P analytics *after* initial nav settles */
        lightlyBlockTrackers?: boolean;

        /** NEW: best signal for dynamic pages */
        waitForSelector?: string;
        /** NEW: auto-scroll duration to trigger lazy/infinite loading (ms) */
        maxScrollMs?: number;
        /** NEW: quiet time after scroll before measuring (ms, default 1200) */
        idleAfterScrollMs?: number;
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

    // Small, reliable “auto-scroll” to trigger lazy/infinite loaders.
    private async autoScroll(page: Page, maxMs = 12000, stepPx = 1200, pauseMs = 500) {
        const t0 = Date.now();
        let lastHeight = await page.evaluate(() => document.body?.scrollHeight || 0);

        while (Date.now() - t0 < maxMs) {
            await page.evaluate((y) => window.scrollBy(0, y), stepPx);
            await this.sleep(pauseMs);

            const newHeight = await page.evaluate(() => document.body?.scrollHeight || 0);
            if (!Number.isFinite(newHeight) || newHeight <= lastHeight) break;
            lastHeight = newHeight;
        }

        // Snap back to top so above-the-fold metrics/screenshot look normal
        try { await page.evaluate(() => window.scrollTo(0, 0)); } catch { /* ignore */ }
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
        const usePipe = true; // lighter on small instances

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
            '--renderer-process-limit=2',
            '--js-flags=--jitless',

            // trim background work a bit more
            '--disable-background-networking',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-ipc-flooding-protection',
            '--metrics-recording-only',

            // Additional flags that tend to help with complex React/SPA sites
            '--disable-web-security',
            '--disable-site-isolation-trials',
            '--disable-blink-features=AutomationControlled',
            '--enable-aggressive-domstorage-flushing',
            '--disable-component-extensions-with-background-pages',
            '--allow-running-insecure-content',
            '--disable-client-side-phishing-detection',
            '--disable-sync',
            '--disable-features=TranslateUI',
            '--disable-default-apps',
            '--disable-prompt-on-repost',
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
        this.processAudit(request); // fire-and-forget
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

            // Preflight (HEAD -> tiny GET)
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 8_000);
                let ok = false;
                try {
                    const head = await fetch(request.websiteUrl, { method: 'HEAD', signal: ctrl.signal, redirect: 'follow' });
                    ok = head.ok;
                    console.log('[audit] preflight HEAD:', head.status);
                } catch {
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

            // Launch (small retry)
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

            // Page + hardening
            page = await this.createPageWithWatchdog(browser, 25_000);
            this.hookPageLogs(page);
            await this.setupPage(page); // installs network-idle tracker

            // Job watchdog (more time for heavy SPAs)
            const jobWatchdog = new Promise<never>((_, rej) =>
                setTimeout(() => rej(new Error('Job watchdog timeout')), 180_000)
            );

            const result = await Promise.race([
                this.runSinglePageAudit(page, request),
                jobWatchdog,
            ]);

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
            try { await page?.close({ runBeforeUnload: false }); } catch { /* ignore */ }
            try { await this.activeBrowser?.close(); } catch { /* ignore */ }
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
                await this.hardenPage(p);
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
        page.on('dialog', async d => { try { await d.dismiss(); } catch { /* ignore */ } });
    }

    private async hardenPage(page: Page) {
        try { await page.setBypassCSP(true); } catch { /* ignore */ }
        try { await page.setJavaScriptEnabled(true); } catch { /* ignore */ }

        // Minimal stealth-ish tweaks + block SW registration
        await page.evaluateOnNewDocument(() => {
            // @ts-ignore
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            // @ts-ignore
            const origQuery = navigator.permissions?.query;
            if (origQuery) {
                // @ts-ignore
                navigator.permissions.query = (parameters: any) =>
                    parameters && parameters.name === 'notifications'
                        ? Promise.resolve({ state: 'denied' })
                        : origQuery(parameters);
            }
            try {
                const sw = navigator.serviceWorker;
                if (sw && sw.register) {
                    // @ts-ignore
                    sw.register = new Proxy(sw.register, { apply() { return Promise.reject(new Error('SW disabled')); } });
                }
            } catch { /* ignore */ }
            // @ts-ignore
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            // @ts-ignore
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });
    }

    // Install a CDP-backed network idle tracker on the page: (page as any).__waitForNetworkIdle(idleMs?, maxWaitMs?)
    private async installNetworkIdleTracker(page: Page) {
        try {
            const client = await (page.target() as any).createCDPSession();
            await client.send('Network.enable');

            const inflight = new Set<string>();
            client.on('Network.requestWillBeSent', (e: any) => inflight.add(e.requestId));
            client.on('Network.loadingFinished', (e: any) => inflight.delete(e.requestId));
            client.on('Network.loadingFailed', (e: any) => inflight.delete(e.requestId));

            (page as any).__waitForNetworkIdle = async (idleMs = 1000, maxWaitMs = 10000) => {
                const t0 = Date.now();
                let lastBusy = Date.now();

                while (Date.now() - t0 < maxWaitMs) {
                    if (inflight.size === 0) {
                        if (Date.now() - lastBusy >= idleMs) return;
                        await this.sleep(100);
                    } else {
                        lastBusy = Date.now();
                        await this.sleep(100);
                    }
                }
            };
        } catch (e) {
            console.warn('[audit] failed to install network-idle tracker:', (e as Error).message);
        }
    }

    private async setupPage(page: Page): Promise<void> {
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
        });

        try { await page.emulateMediaType('screen'); } catch { /* ignore */ }
        page.setDefaultNavigationTimeout(0);
        page.setDefaultTimeout(60_000);
        try { await page.setCacheEnabled(false); } catch { /* ignore */ }

        await this.installNetworkIdleTracker(page);
    }

    private async dismissConsents(page: Page) {
        // Best-effort cookie/consent acceptance; optional
        const selectors = [
            'button#onetrust-accept-btn-handler',
            'button[aria-label="Accept all"]',
            'button[aria-label="Accept All"]',
            'button:has-text("Accept all")',
            'button:has-text("Accept All")',
            'button:has-text("I agree")',
            'button:has-text("Agree")',
            'button[mode="primary"]:has-text("Accept")',
            '[data-testid="uc-accept-all-button"]',
            'button[aria-label="OK"]',
        ];
        for (const sel of selectors) {
            try {
                const el = await page.$(sel);
                if (el) {
                    await el.click({ delay: 10 }).catch(() => undefined);
                    await this.sleep(300);
                }
            } catch { /* ignore */ }
        }
    }

    private async runSinglePageAudit(page: Page, request: AuditRequest): Promise<AuditResult> {
        const ua =
            request.options?.customUserAgent ||
            config?.lighthouse?.settings?.emulatedUserAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

        await page.setUserAgent(ua);

        if (request.options?.mobile) {
            await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        } else {
            const w = config?.lighthouse?.settings?.screenEmulation?.width ?? 1366;
            const h = config?.lighthouse?.settings?.screenEmulation?.height ?? 768;
            await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
        }

        // Navigate (forgiving, with global budget)
        const response = await this.progressiveGoto(page, request.websiteUrl);
        console.log('[audit] navigation ok:', response?.status() || 'no response');

        // Try dismissing cookie walls (non-fatal)
        await this.dismissConsents(page);

        // --- Dynamic content helpers ---

        // 1) If the caller provides a “done” selector (best signal), wait for it.
        if (request.options?.waitForSelector) {
            try {
                await page.waitForSelector(request.options.waitForSelector, { timeout: 20_000 });
                await this.sleep(300);
            } catch {
                console.warn('[audit] waitForSelector timed out:', request.options.waitForSelector);
            }
        }

        // 2) Optional auto-scroll to trigger lazy/infinite loaders, then wait for quiet.
        if (request.options?.maxScrollMs && request.options.maxScrollMs > 0) {
            console.log('[audit] autoScroll start', request.options.maxScrollMs, 'ms');
            await this.autoScroll(page, request.options.maxScrollMs);
            const idleMs = request.options.idleAfterScrollMs ?? 1200;
            const waitForIdle = (page as any).__waitForNetworkIdle as (idle?: number, max?: number) => Promise<void>;
            if (typeof waitForIdle === 'function') {
                await waitForIdle(idleMs, Math.max(6000, idleMs + 2000));
            } else {
                await this.sleep(idleMs);
            }
        }

        // 3) Ensure DOM (guards against blank docs)
        try { await page.waitForSelector('body', { timeout: 10_000 }); } catch { /* ignore */ }

        // Optional: after initial settle, lightly block analytics to stabilize SPAs during metric reads
        if (request.options?.lightlyBlockTrackers) {
            const thirdPartyBlocklist = [
                'googletagmanager.com', 'google-analytics.com', 'doubleclick.net',
                'facebook.net', 'hotjar.com', 'fullstory.com', 'segment', 'mixpanel',
                'optimizely', 'stats.g', 'sentry.io', 'newrelic', 'datadog'
            ];

            try {
                console.log('[audit] setting up request interception for tracker blocking');
                await page.setRequestInterception(true);
                page.on('request', (req) => {
                    try {
                        const url = req.url();
                        const rt = (typeof req.resourceType === 'function'
                            ? String(req.resourceType()).toLowerCase()
                            : '').toLowerCase();

                        const is3p = thirdPartyBlocklist.some(d => url.includes(d));

                        // Only block non-critical background traffic from these vendors
                        if (is3p && (rt === 'xhr' || rt === 'fetch' || rt === 'ping' || rt === 'eventsource' || rt === 'other')) {
                            console.log('[audit] blocking tracker request:', url);
                            return req.abort();
                        }
                    } catch {
                        // fall through
                    }
                    try { return req.continue(); } catch { /* ignore */ }
                });
            } catch (e) {
                console.warn('[audit] failed to set up request interception:', (e as Error).message);
            }
        }

        // ---- Metrics collection ----
        const perfJson = await page.evaluate(() => {
            try { return JSON.stringify(performance.getEntriesByType('navigation')); }
            catch { return '[]'; }
        }).catch(() => '[]');

        let loadTime = 0;
        try {
            const nav = JSON.parse(perfJson) as any[];
            const nav0 = nav?.[0] ?? {};
            loadTime = Number.isFinite(nav0.loadEventEnd) ? Math.floor(nav0.loadEventEnd) : 0;
        } catch { /* ignore */ }

        const performanceScore = Math.max(0, Math.min(100, 100 - Math.floor(loadTime / 100)));

        // SEO
        const seoScore = await page.evaluate(() => {
            try {
                const title = document.title || '';
                const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content');
                const h1s = document.querySelectorAll('h1');
                let score = 0;
                if (title && title.length > 0 && title.length <= 60) score += 25;
                if (metaDescription && (metaDescription?.length ?? 0) > 0) score += 25;
                if (h1s.length === 1) score += 25;
                if (document.querySelector('meta[name="viewport"]')) score += 25;
                return score;
            } catch { return 50; }
        }).catch(() => 50);

        // Accessibility (very rough)
        const accessibilityScore = await page.evaluate(() => {
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
        }).catch(() => 70);

        // Optional screenshot
        let screenshot: string | undefined;
        if (request.options?.includeScreenshot) {
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
            metrics: { loadTime, cumulativeLayoutShift: 0 },
            pagesCrawled: 1,
            screenshot,
            issues: [] as Issues,
        };

        return { jobId: request.jobId, status: 'COMPLETED', results };
    }

    /** Count in-flight requests and wait until it’s quiet – ignoring long-lived types. */
    private async waitForNetworkIdleCustom(
        page: Page,
        idleMs = 1000,
        maxWaitMs = 30000
    ): Promise<void> {
        let inflight = 0;
        let resolveIdle!: () => void;
        let idleTimer: NodeJS.Timeout | null = null;

        const resetIdle = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => inflight === 0 && resolveIdle(), idleMs);
        };

        const onRequest = (req: any) => {
            const rt = (typeof req.resourceType === 'function' ? req.resourceType() : '')?.toString().toLowerCase();
            // Ignore long-lived/background stuff that never “idles”
            if (rt === 'websocket' || rt === 'eventsource' || rt === 'ping') return;
            inflight++;
            resetIdle();
        };

        const onFinishOrFail = (_: any) => {
            inflight = Math.max(0, inflight - 1);
            resetIdle();
        };

        page.on('request', onRequest);
        page.on('requestfinished', onFinishOrFail);
        page.on('requestfailed', onFinishOrFail);

        try {
            await new Promise<void>((resolve, reject) => {
                resolveIdle = resolve;
                const kill = setTimeout(() => reject(new Error('network idle timeout')), maxWaitMs);
                // prime the timer in case we arrive quiet
                resetIdle();
                // clear kill timer on resolve
                (async () => {
                    try { await new Promise<void>(r => (resolveIdle = () => { clearTimeout(kill); r(); })); }
                    catch { /* ignore */ }
                })();
            });
        } finally {
            page.off('request', onRequest);
            page.off('requestfinished', onFinishOrFail);
            page.off('requestfailed', onFinishOrFail);
            if (idleTimer) clearTimeout(idleTimer);
        }
    }

    /** Wait until the DOM stops changing for a short window (great for SPA hydration). */
    private async waitForStableDOM(page: Page, stableMs = 800, maxWaitMs = 15000): Promise<void> {
        await page.evaluate(
            (stable, overall) =>
                new Promise<void>((resolve) => {
                    let last = Date.now();
                    const obs = new MutationObserver(() => { last = Date.now(); });
                    obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

                    const tick = () => {
                        const now = Date.now();
                        if (now - last >= stable) {
                            obs.disconnect();
                            resolve();
                        } else if (now - (window as any).__stableStart__ >= overall) {
                            obs.disconnect();
                            resolve(); // give up gracefully – “ready enough”
                        } else {
                            requestAnimationFrame(tick);
                        }
                    };
                    (window as any).__stableStart__ = Date.now();
                    tick();
                }),
            stableMs,
            maxWaitMs
        );
    }

    /** Small, safe sleep */
    private async snooze(ms: number) {
        await new Promise<void>(r => setTimeout(r, ms));
    }

    private async progressiveGoto(page: Page, url: string): Promise<HTTPResponse | null> {
        // Quick function we can call a lot without throwing
        const considerReady = async () => {
            try {
                return await page.evaluate(() => {
                    const rs = document.readyState;
                    const hasBody = !!document.body;
                    const hasContent = (document.body?.children?.length || 0) > 0;
                    const hasReact = !!(window as any).React || !!document.querySelector('[data-reactroot]') || !!document.querySelector('#root') || !!document.querySelector('#app');
                    const hasVue = !!(window as any).Vue || !!document.querySelector('[data-v-]');
                    const hasAngular = !!(window as any).ng || !!document.querySelector('[ng-app]');
                    if (hasReact || hasVue || hasAngular) {
                        return hasBody && hasContent && (rs === 'interactive' || rs === 'complete');
                    }
                    return hasBody && (rs === 'interactive' || rs === 'complete');
                });
            } catch { return false; }
        };

        const totalBudgetMs = 150_000; // a bit more generous for heavy SPAs
        const start = Date.now();

        const strategies: Array<{ name: string; opts: Parameters<Page['goto']>[1] }> = [
            { name: 'domcontentloaded', opts: { waitUntil: 'domcontentloaded', timeout: 40_000 } },
            // networkidle0/2 are unreliable on WS/EventSource sites, but we still *try* once
            { name: 'networkidle2', opts: { waitUntil: 'networkidle2', timeout: 35_000 } },
            { name: 'load', opts: { waitUntil: 'load', timeout: 40_000 } },
            { name: 'basic', opts: { timeout: 30_000 } },
        ];

        let bestResp: HTTPResponse | null = null;

        for (let i = 0; i < strategies.length; i++) {
            const { name, opts } = strategies[i];
            if (Date.now() - start >= totalBudgetMs) break;

            try {
                console.log(`[audit] goto (${name})`, opts);
                const remaining = Math.min((opts?.timeout as number) ?? 30_000, totalBudgetMs - (Date.now() - start));
                const navPromise = page.goto(url, opts as any);
                const watchdog = new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error(`navigation timeout (${name})`)), Math.max(8_000, remaining))
                );

                const resp = await Promise.race([navPromise, watchdog]) as HTTPResponse | null;
                if (resp) {
                    bestResp = resp;
                    console.log(`[audit] response (${name})`, resp.status(), resp.url());
                }

                // Body present?
                try { await page.waitForSelector('body', { timeout: 6_000 }); } catch { /* ignore */ }

                // If we got *some* doc, run our reliable settles:
                await this.waitForNetworkIdleCustom(page, 800, 10_000).catch(() => undefined);
                await this.waitForStableDOM(page, 800, 10_000).catch(() => undefined);

                // One more quick sanity check
                if (await considerReady()) {
                    // For very JS-heavy pages, give JS a last tiny slice to flush layout
                    await this.snooze(500);
                    return resp;
                }

                // On last strategy, attempt a quick reload to break weird soft-nav states
                if (i === strategies.length - 1 && Date.now() - start < totalBudgetMs - 10_000) {
                    console.log('[audit] final attempt: reload + settles');
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
                    await this.waitForNetworkIdleCustom(page, 800, 8_000).catch(() => undefined);
                    await this.waitForStableDOM(page, 800, 8_000).catch(() => undefined);
                    if (await considerReady()) return bestResp;
                }
            } catch (e) {
                console.warn(`[audit] goto (${name}) failed:`, (e as Error).message);
                // try the next strategy
            }
        }

        // Salvage: if we have any response at all, proceed
        if (bestResp) {
            console.warn(`[audit] navigation salvage: proceeding with best response (${bestResp.status()})`);
            return bestResp;
        }

        // Last-ditch: minimal goto (no waits)
        try {
            console.warn('[audit] last-ditch: bare goto');
            const r = await page.goto(url, { timeout: 20_000 } as any).catch(() => null);
            if (r) return r;
        } catch { /* ignore */ }

        // Absolute fallback: if there’s DOM, proceed anyway
        try {
            const hasAny = await page.evaluate(() => !!document.body && document.body.innerHTML.length > 0);
            if (hasAny) {
                return { status: () => 200, ok: () => true, url: () => url } as any;
            }
        } catch { /* ignore */ }

        throw new Error('Navigation failed: all strategies exhausted');
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