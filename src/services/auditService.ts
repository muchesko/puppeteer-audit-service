import puppeteer, { type LaunchOptions, type Browser, Page } from 'puppeteer';
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

                /*'--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-zygote',
                '--disable-background-networking',
                '--disable-sync',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-ipc-flooding-protection',
                '--metrics-recording-only',
                '--mute-audio',
                '--disable-extensions',
                '--disable-software-rasterizer',
                '--disable-canvas-aa',
                '--disable-2d-canvas-clip-aa',
                '--disable-gl-drawing-for-tests',
                '--disable-accelerated-2d-canvas',
                '--disable-accelerated-video-decode',
                '--user-data-dir=/tmp/chrome-data',
                '--disable-features=VizDisplayCompositor,AudioServiceOutOfProcess,TranslateUI',
                // do NOT add --remote-debugging-port or --remote-debugging-pipe here when using WS transport
                */
            ];

            // Also: DO NOT use `as const` on launchOpts
            const launchOpts: LaunchOptions = {
                headless: true,
                pipe: usePipe,         // false => WebSocket transport
                executablePath,
                args,
                timeout: 120_000,        // Increased for nano instances
                protocolTimeout: 180_000, // Significantly increased for nano instances
                dumpio: true          // Enable dumpio to log
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

            try {
                const jobDeadlineMs = 120_000; // 2 minute job watchdog
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

                        console.log('[audit] setViewport');
                        if (request.options?.mobile) {
                            await page.setViewport({ width: 375, height: 667 });
                        } else {
                            await page.setViewport({
                                width: config.lighthouse.settings.screenEmulation.width,
                                height: config.lighthouse.settings.screenEmulation.height
                            });
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

    private async runLighthouseAudit(page: Page, url: string) {
        // Run audit directly on the provided page instance (no re-configuration)
        try {
            console.log('[audit] starting progressive navigation to', url);

            // Progressive navigation with fallback strategies
            let response;
            let navSuccess = false;
            const strategies = [
                { waitUntil: 'domcontentloaded', timeout: 30_000, name: 'DOM ready' },
                { waitUntil: 'load', timeout: 45_000, name: 'full load' },
                { waitUntil: 'networkidle2', timeout: 60_000, name: 'network idle' },
                { waitUntil: undefined, timeout: 20_000, name: 'basic navigation' }
            ];

            for (const strategy of strategies) {
                try {
                    console.log(`[audit] trying navigation strategy: ${strategy.name}`);
                    const opts: any = { timeout: strategy.timeout };
                    if (strategy.waitUntil) opts.waitUntil = strategy.waitUntil;
                    
                    response = await page.goto(url, opts);
                    if (response && response.ok()) {
                        console.log(`[audit] navigation successful with: ${strategy.name}`);
                        navSuccess = true;
                        break;
                    }
                } catch (error) {
                    console.warn(`[audit] strategy "${strategy.name}" failed:`, error);
                    continue;
                }
            }

            if (!navSuccess || !response) {
                throw new Error('All navigation strategies failed');
            }

            console.log('[audit] page loaded, collecting metrics');

            // Safer performance metrics collection with timeout protection
            const metricsPromise = page.metrics().catch(e => {
                console.warn('[audit] metrics collection failed:', e);
                return {};
            });

            const performanceEntriesPromise = page.evaluate(() => {
                try {
                    return JSON.stringify(performance.getEntriesByType('navigation'));
                } catch {
                    return '[]';
                }
            }).catch(() => '[]');

            const [metrics, performanceEntries] = await Promise.all([
                metricsPromise, 
                performanceEntriesPromise
            ]);

            const navigationEntries = JSON.parse(performanceEntries);
            const loadTime = navigationEntries[0]?.loadEventEnd || 0;

            // Simple scoring based on load time and basic checks
            const performanceScore = Math.max(0, Math.min(100, 100 - (loadTime / 100)));

            // Safer SEO checks with error handling
            console.log('[audit] running SEO analysis');
            const seoChecks = await page.evaluate(() => {
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
                } catch (error) {
                    console.warn('SEO evaluation error:', error);
                    return 50; // Default score on error
                }
            }).catch(() => 50);

            // Safer accessibility checks with error handling
            console.log('[audit] running accessibility analysis');
            const accessibilityScore = await page.evaluate(() => {
                try {
                    const images = document.querySelectorAll('img');
                    const buttons = document.querySelectorAll('button');

                    let score = 100;

                    // Check for alt text on images
                    for (const img of images) {
                        if (!img.getAttribute('alt')) {
                            score -= 10;
                        }
                    }

                    // Check for proper button text
                    for (const button of buttons) {
                        if (!button.textContent?.trim() && !button.getAttribute('aria-label')) {
                            score -= 5;
                        }
                    }

                    return Math.max(0, score);
                } catch (error) {
                    console.warn('Accessibility evaluation error:', error);
                    return 70; // Default score on error
                }
            }).catch(() => 70);

            console.log('[audit] analysis complete, compiling results');
            return {
                performance: Math.round(performanceScore),
                seo: seoChecks,
                accessibility: Math.round(accessibilityScore),
                bestPractices: 75, // Default score
                metrics: {
                    loadTime: loadTime,
                    cumulativeLayoutShift: 0 // Simplified
                },
                issues: [] // Simplified - no detailed issues for now
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
