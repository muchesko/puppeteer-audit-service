import puppeteer, { Browser, Page } from 'puppeteer';
import lighthouse from 'lighthouse';
import { launch } from 'chrome-launcher';
import crypto from 'crypto';
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

  async getBrowser(): Promise<Browser> {
    if (!this.activeBrowser || !this.activeBrowser.isConnected()) {
      this.activeBrowser = await puppeteer.launch({
        headless: true,
        executablePath: config.chromeExecutablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-extensions',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding'
        ]
      });
    }
    return this.activeBrowser;
  }

  async processAudit(request: AuditRequest): Promise<void> {
    this.jobStatuses.set(request.jobId, 'PROCESSING');
    
    try {
      console.log(`Processing audit for ${request.websiteUrl} (Job: ${request.jobId})`);
      
      const browser = await this.getBrowser();
      const page = await browser.newPage();
      
      // Configure page
      await page.setUserAgent(
        request.options?.customUserAgent || 
        config.lighthouse.settings.emulatedUserAgent
      );
      
      if (request.options?.mobile) {
        await page.setViewport({ width: 375, height: 667 });
      } else {
        await page.setViewport({ 
          width: config.lighthouse.settings.screenEmulation.width, 
          height: config.lighthouse.settings.screenEmulation.height 
        });
      }
      
      // Run Lighthouse audit
      const lighthouseResult = await this.runLighthouseAudit(request.websiteUrl, request.options?.mobile);
      
      // Take screenshot if requested
      let screenshot: string | undefined;
      if (request.options?.includeScreenshot) {
        try {
          await page.goto(request.websiteUrl, { waitUntil: 'networkidle2' });
          const screenshotBuffer = await page.screenshot({ 
            type: 'png',
            fullPage: false
          });
          screenshot = Buffer.from(screenshotBuffer).toString('base64');
        } catch (error) {
          console.warn('Screenshot failed:', error);
        }
      }
      
      await page.close();
      
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
      
      // Send callback
      await this.sendCallback(auditResult);
      
    } catch (error) {
      console.error(`Audit failed for job ${request.jobId}:`, error);
      
      const auditResult: AuditResult = {
        jobId: request.jobId,
        status: 'FAILED',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
      
      this.jobStatuses.set(request.jobId, 'FAILED');
      
      // Send failure callback
      await this.sendCallback(auditResult);
    }
  }

  private async runLighthouseAudit(url: string, mobile = false) {
    const chrome = await launch({
      chromeFlags: ['--headless', '--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
      const lighthouseConfig = {
        ...config.lighthouse.config,
        settings: {
          ...config.lighthouse.settings,
          formFactor: (mobile ? 'mobile' : 'desktop') as 'mobile' | 'desktop',
          screenEmulation: mobile ? {
            mobile: true,
            width: 375,
            height: 667,
            deviceScaleFactor: 2,
            disabled: false
          } : config.lighthouse.settings.screenEmulation
        }
      };
      
      const runnerResult = await lighthouse(url, {
        port: chrome.port,
        output: 'json',
        logLevel: 'error'
      }, lighthouseConfig);
      
      if (!runnerResult?.lhr) {
        throw new Error('Lighthouse audit failed - no results');
      }
      
      const lhr = runnerResult.lhr;
      
      // Extract scores (0-100)
      const performance = Math.round((lhr.categories.performance?.score || 0) * 100);
      const seo = Math.round((lhr.categories.seo?.score || 0) * 100);
      const accessibility = Math.round((lhr.categories.accessibility?.score || 0) * 100);
      const bestPractices = Math.round((lhr.categories['best-practices']?.score || 0) * 100);
      
      // Extract key metrics
      const metrics = {
        loadTime: lhr.audits['interactive']?.numericValue || 0,
        cumulativeLayoutShift: lhr.audits['cumulative-layout-shift']?.numericValue || 0
      };
      
      // Extract issues
      const issues = this.extractIssues(lhr);
      
      return {
        performance,
        seo,
        accessibility,
        bestPractices,
        metrics,
        issues
      };
      
    } finally {
      await chrome.kill();
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

  async cleanup(): Promise<void> {
    if (this.activeBrowser) {
      await this.activeBrowser.close();
      this.activeBrowser = null;
    }
  }
}
