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
        this.processAudit(request); // fire-and-forget (guarded internally)
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
            await this.setupPage(page);

            // Job watchdog
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

                // Hardening: stealth-ish + SW/CSP tweaks
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

        // Kill service workers; they can keep network idle from ever happening and alter fetches
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
            // Block SW registration
            try {
                const sw = navigator.serviceWorker;
                if (sw && sw.register) {
                    // @ts-ignore
                    sw.register = new Proxy(sw.register, { apply() { return Promise.reject(new Error('SW disabled')); } });
                }
            } catch { /* ignore */ }
            // Basic plugins spoof
            // @ts-ignore
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
            // @ts-ignore
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        });
    }

    private async setupPage(page: Page): Promise<void> {
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Upgrade-Insecure-Requests': '1',
            'DNT': '1',
        });

        try { await page.emulateMediaType('screen'); } catch { /* ignore */ }

        // DO NOT block images/fonts by default (too many sites depend on them).
        // We'll optionally trim analytics after initial settle (see runSinglePageAudit).
        page.setDefaultNavigationTimeout(0);
        page.setDefaultTimeout(60_000);
        try { await page.setCacheEnabled(false); } catch { /* ignore */ }
    }

    private async dismissConsents(page: Page) {
        // Best-effort cookie/consent acceptance; completely optional
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
            // A realistic desktop UA:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

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

        // Optional: after initial settle, lightly block analytics to stabilize SPAs during metric reads
        // IMPORTANT: Set up request interception AFTER navigation to avoid conflicts
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

        // Ensure DOM (guards against blank docs)
        try { await page.waitForSelector('body', { timeout: 10_000 }); } catch { /* ignore */ }

        // Collect metrics
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

    // Forgiving navigation with a global budget + “ready enough” checks + salvage fallbacks
    private async progressiveGoto(page: Page, url: string): Promise<HTTPResponse | null> {
        const considerReady = async () => {
            try {
                return await page.evaluate(() => {
                    const rs = document.readyState;
                    const hasBody = !!document.body;
                    const hasContent = document.body?.children?.length > 0;
                    
                    // For React/SPA sites, also check for common frameworks
                    const hasReact = !!(window as any).React || document.querySelector('[data-reactroot]') || document.querySelector('#root');
                    const hasVue = !!(window as any).Vue || document.querySelector('[data-v-]');
                    const hasAngular = !!(window as any).ng || document.querySelector('[ng-app]');
                    
                    // If it's a SPA, wait for framework to be ready AND content to be rendered
                    if (hasReact || hasVue || hasAngular) {
                        return hasBody && hasContent && (rs === 'interactive' || rs === 'complete');
                    }
                    
                    // For regular sites, just check basic readiness
                    return hasBody && (rs === 'interactive' || rs === 'complete');
                });
            } catch {
                return false;
            }
        };

        // Check if site appears to be a SPA/React app
        const detectSPA = async () => {
            try {
                const response = await fetch(url, { method: 'HEAD' }).catch(() => null);
                if (!response) return false;
                
                // Check for common SPA indicators in headers
                const contentType = response.headers.get('content-type') || '';
                return contentType.includes('text/html');
            } catch {
                return false;
            }
        };

        const isSPA = await detectSPA();
        const totalBudgetMs = isSPA ? 180_000 : 120_000; // Extra time for SPAs
        const start = Date.now();

        // Enhanced strategies with SPA-specific options
        const strategies: Array<{ name: string; opts: Parameters<Page['goto']>[1] }> = [
            { name: 'domcontentloaded', opts: { waitUntil: 'domcontentloaded', timeout: 40_000 } },
            { name: 'networkidle0', opts: { waitUntil: 'networkidle0', timeout: 45_000 } }, // Wait for all network activity to stop
            { name: 'networkidle2', opts: { waitUntil: 'networkidle2', timeout: 35_000 } },
            { name: 'load', opts: { waitUntil: 'load', timeout: 40_000 } },
            { name: 'basic', opts: { timeout: 30_000 } }, // no waitUntil
        ];

        let bestResp: HTTPResponse | null = null;

        for (let i = 0; i < strategies.length; i++) {
            const { name, opts } = strategies[i];
            const elapsed = Date.now() - start;
            if (elapsed >= totalBudgetMs) {
                console.log(`[audit] navigation budget exhausted (${elapsed}ms), stopping attempts`);
                break;
            }

            try {
                console.log(`[audit] goto attempt ${i + 1}/${strategies.length} (${name})`, opts);
                const navPromise = page.goto(url, opts as any);

                const remaining = Math.max(10_000,
                    Math.min(totalBudgetMs - elapsed, (opts?.timeout as number) ?? 30_000)
                );
                const watchdog = new Promise<never>((_, rej) =>
                    setTimeout(() => rej(new Error(`navigation timeout (${name})`)), remaining)
                );

                const resp = await Promise.race([navPromise, watchdog]) as HTTPResponse | null;
                if (resp) {
                    bestResp = resp;
                    console.log(`[audit] goto (${name}) got response:`, resp.status(), resp.url());
                }

                // quick DOM + settle checks even on non-200s (some sites return 3xx/4xx but render)
                try { 
                    await page.waitForSelector('body', { timeout: 5_000 }); 
                    console.log('[audit] body element found');
                } catch { 
                    console.log('[audit] no body element found yet');
                }

                // Wait for React/SPA specific elements to appear
                if (isSPA) {
                    try {
                        await page.waitForFunction(() => {
                            // Common React root selectors
                            const reactRoot = document.querySelector('#root') || 
                                             document.querySelector('#app') || 
                                             document.querySelector('[data-reactroot]') ||
                                             document.querySelector('.App');
                            
                            // Check if React root has content
                            return reactRoot && reactRoot.children.length > 0;
                        }, { timeout: 10_000 });
                        console.log('[audit] React/SPA content detected');
                    } catch {
                        console.log('[audit] React/SPA content not detected, continuing...');
                    }
                }

                // Check if page is "ready enough" with SPA-aware settling
                const settleTimeMs = isSPA ? 15_000 : 8_000; // More time for SPAs
                const settleUntil = Date.now() + settleTimeMs;
                let readyChecks = 0;
                const maxChecks = isSPA ? 40 : 20; // More checks for SPAs
                
                while (Date.now() < settleUntil && readyChecks < maxChecks) {
                    if (await considerReady()) {
                        console.log(`[audit] page ready after ${readyChecks} checks with strategy: ${name} (SPA: ${isSPA})`);
                        
                        // For SPAs, wait a bit more for final render
                        if (isSPA) {
                            console.log('[audit] SPA detected, waiting for final render...');
                            await this.sleep(2_000);
                        }
                        
                        return resp;
                    }
                    await this.sleep(isSPA ? 500 : 400); // Slower polling for SPAs
                    readyChecks++;
                }
                
                // Log what we found for debugging
                try {
                    const pageInfo = await page.evaluate(() => ({
                        readyState: document.readyState,
                        hasBody: !!document.body,
                        bodyChildren: document.body?.children?.length || 0,
                        hasReact: !!(window as any).React || !!document.querySelector('[data-reactroot]') || !!document.querySelector('#root'),
                        title: document.title || 'No title'
                    }));
                    console.log(`[audit] page info after ${readyChecks} checks:`, pageInfo);
                } catch (e) {
                    console.log('[audit] could not get page info:', (e as Error).message);
                }
                
                // If we have a response but not fully ready, still consider it success for first attempts
                if (resp && resp.ok() && i < strategies.length - 1) {
                    console.log(`[audit] strategy ${name} got OK response, continuing to next strategy`);
                    continue; // Try next strategy for better result
                }

                if (resp) {
                    console.log(`[audit] strategy ${name} completed with response, status: ${resp.status()}`);
                    return resp;
                }

            } catch (e) {
                const errorMsg = (e as Error).message;
                console.warn(`[audit] goto (${name}) failed:`, errorMsg);
                
                // Don't give up immediately on common navigation errors
                if (errorMsg.includes('timeout') || errorMsg.includes('Navigation')) {
                    continue; // Try next strategy
                }
                
                // For other errors, still try next strategy
                continue;
            }
        }

        // SALVAGE: if we navigated *somewhere*, continue with bestResp instead of hard fail
        if (bestResp) {
            console.warn(`[audit] navigation salvage: proceeding with best response (${bestResp.status()})`);
            return bestResp;
        }

        // Last-ditch: try opening with absolutely minimal constraints
        try {
            console.warn('[audit] last-ditch: basic navigation with minimal constraints');
            const r = await page.goto(url, { timeout: 20_000 } as any).catch(() => null);
            if (r) {
                console.log('[audit] last-ditch navigation succeeded');
                return r;
            }
        } catch (e) {
            console.warn('[audit] last-ditch navigation failed:', (e as Error).message);
        }

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