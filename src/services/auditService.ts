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
      '--disable-features=TranslateUI',
      '--disable-background-networking',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--disable-extensions',
      '--disable-software-rasterizer',
      '--user-data-dir=/tmp/chrome-data',
      '--single-process',
      '--renderer-process-limit=1'
      // do NOT add --remote-debugging-port or --remote-debugging-pipe here when using WS transport
    ];

    // Also: DO NOT use `as const` on launchOpts
    const launchOpts: LaunchOptions = {
      headless: true,
      pipe: usePipe,         // false => WebSocket transport
      executablePath,
      args,
      timeout: 120000,
      protocolTimeout: 120000,
      dumpio: true
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

            try {
                // Configure page once with error handling
                const userAgent = request.options?.customUserAgent ||
                    config.lighthouse.settings.emulatedUserAgent;

                await page.setUserAgent(userAgent);

                if (request.options?.mobile) {
                    await page.setViewport({ width: 375, height: 667 });
                } else {
                    await page.setViewport({
                        width: config.lighthouse.settings.screenEmulation.width,
                        height: config.lighthouse.settings.screenEmulation.height
                    });
                }

                // Set reasonable timeouts
                await page.setDefaultTimeout(60000);
                await page.setDefaultNavigationTimeout(60000);

                // Run audit on the same page instance
                const lighthouseResult = await this.runLighthouseAudit(page, request.websiteUrl);

                // Take screenshot if requested (on same page)
                let screenshot: string | undefined;
                if (request.options?.includeScreenshot) {
                    try {
                        const screenshotBuffer = await page.screenshot({
                            type: 'png',
                            fullPage: false
                        });
                        screenshot = Buffer.from(screenshotBuffer).toString('base64');
                    } catch (error) {
                        console.warn('Screenshot failed:', error);
                    }
                }

                // Process results
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

                this.jobStatuses.set(request.jobId, 'COMPLETED');
                this.jobResults.set(request.jobId, auditResult);

                console.log(`Audit completed for job ${request.jobId}:`, {
                    performance: auditResult.results?.performanceScore,
                    seo: auditResult.results?.seoScore,
                    accessibility: auditResult.results?.accessibilityScore,
                    bestPractices: auditResult.results?.bestPracticesScore
                });

            } finally {
                // Always close the page
                try {
                    await page.close();
                } catch (error) {
                    console.warn('Page close error (ignored):', error);
                }
            }

        } catch (error) {
            console.error(`Audit failed for job ${request.jobId}:`, error);

            const auditResult: AuditResult = {
                jobId: request.jobId,
                status: 'FAILED',
                error: error instanceof Error ? error.message : 'Unknown error'
            };

            this.jobStatuses.set(request.jobId, 'FAILED');
            this.jobResults.set(request.jobId, auditResult);

            console.log(`Audit failed for job ${request.jobId}:`, error instanceof Error ? error.message : 'Unknown error');
        } finally {
            this.activeJobs--;
        }
    }

    private async runLighthouseAudit(page: Page, url: string) {
        // Run audit directly on the provided page instance (no re-configuration)
        try {
            // Navigate to page with retries
            let response;
            let navRetries = 0;
            const maxNavRetries = 3;

            while (navRetries < maxNavRetries) {
                try {
                    try {
                        response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                    } catch {
                        // fallback if networkidle2 stalls due to long-polling / analytics beacons
                        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    }
                    if (response) break;
                } catch (error) {
                    navRetries++;
                    console.warn(`Navigation attempt ${navRetries} failed:`, error);
                    if (navRetries >= maxNavRetries) throw error;
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            if (!response) {
                throw new Error('Failed to load page after retries');
            }

            // Basic performance metrics
            const metrics = await page.metrics();
            const performanceEntries = await page.evaluate(() => {
                return JSON.stringify(performance.getEntriesByType('navigation'));
            });

            const navigationEntries = JSON.parse(performanceEntries);
            const loadTime = navigationEntries[0]?.loadEventEnd || 0;

            // Simple scoring based on load time and basic checks
            const performanceScore = Math.max(0, Math.min(100, 100 - (loadTime / 100)));

            // Basic SEO checks
            const seoChecks = await page.evaluate(() => {
                const title = document.title;
                const metaDescription = document.querySelector('meta[name="description"]');
                const h1s = document.querySelectorAll('h1');

                let score = 0;
                if (title && title.length > 0 && title.length < 60) score += 25;
                if (metaDescription && metaDescription.getAttribute('content')) score += 25;
                if (h1s.length === 1) score += 25;
                if (document.querySelector('meta[name="viewport"]')) score += 25;

                return score;
            });

            // Basic accessibility checks
            const accessibilityScore = await page.evaluate(() => {
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
            });

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
        try {
            const body = JSON.stringify(result);
            const signature = crypto
                .createHmac('sha256', config.webhookSecret)
                .update(body)
                .digest('hex');

            const response = await fetch(config.callbackUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Signature': `sha256=${signature}`,
                    'X-API-Key': config.apiKey
                },
                body
            });

            if (!response.ok) {
                console.error(`Callback failed: ${response.status} ${response.statusText}`);
            } else {
                console.log(`Callback sent successfully for job ${result.jobId}`);
            }

        } catch (error) {
            console.error('Callback error:', error);
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
