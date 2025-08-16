import puppeteer, { Browser, Page } from 'puppeteer';
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
  private jobResults = new Map<string, AuditResult>();

  async getBrowser(): Promise<Browser> {
    if (!this.activeBrowser || !this.activeBrowser.isConnected()) {
      this.activeBrowser = await puppeteer.launch({
        headless: true,
        executablePath: config.chromeExecutablePath,
        args: [
          // Essential security flags for containerized environments
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          
          // Minimal set of flags for stability in nano instances
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--disable-extensions',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--memory-pressure-off',
          '--disable-ipc-flooding-protection',
          '--disable-hang-monitor',
          '--disable-prompt-on-repost',
          '--disable-component-update',
          '--disable-domain-reliability',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-features=TranslateUI',
          '--enable-automation',
          '--hide-scrollbars',
          '--mute-audio'
        ],
        timeout: 30000, // Reduced timeout for faster feedback
        protocolTimeout: 30000,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        dumpio: false,
        pipe: false, // Back to WebSocket - pipe seems to have issues in this environment
        slowMo: 50 // Reduced from 100ms to be less aggressive
      });
    }
    return this.activeBrowser;
  }

  async startAudit(request: AuditRequest): Promise<void> {
    // Start processing the audit asynchronously
    this.processAudit(request);
  }

  async processAudit(request: AuditRequest): Promise<void> {
    this.jobStatuses.set(request.jobId, 'PROCESSING');
    
    try {
      console.log(`Processing audit for ${request.websiteUrl} (Job: ${request.jobId})`);
      
      // Add retry logic for browser launch with exponential backoff
      let browser: Browser;
      let retryCount = 0;
      const maxRetries = 5; // Increased retries
      
      while (retryCount < maxRetries) {
        try {
          console.log(`Browser launch attempt ${retryCount + 1}/${maxRetries}`);
          browser = await this.getBrowser();
          
          // Test the connection by creating and closing a test page
          const testPage = await browser.newPage();
          await testPage.close();
          
          console.log(`Browser launch successful on attempt ${retryCount + 1}`);
          break;
        } catch (error) {
          retryCount++;
          console.error(`Browser launch attempt ${retryCount} failed:`, error);
          console.error('Chrome executable path:', config.chromeExecutablePath);
          console.error('Error details:', error instanceof Error ? error.stack : error);
          
          if (retryCount >= maxRetries) {
            throw new Error(`Failed to launch browser after ${maxRetries} attempts`);
          }
          
          // Clean up any existing browser
          if (this.activeBrowser) {
            try {
              await this.activeBrowser.close();
            } catch (e) {
              console.log('Browser cleanup completed (errors ignored)');
            }
            this.activeBrowser = null;
          }
          
          // Exponential backoff: wait longer between retries
          const backoffTime = Math.min(10000, 1000 * Math.pow(2, retryCount));
          console.log(`Waiting ${backoffTime}ms before retry ${retryCount + 1}`);
          await new Promise(resolve => setTimeout(resolve, backoffTime));
        }
      }
      
      const page = await browser!.newPage();
      
      try {
        // Configure page with error handling
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
        
        // Set additional page configurations for stability
        await page.setDefaultTimeout(config.requestTimeout);
        await page.setDefaultNavigationTimeout(config.requestTimeout);
        
        // Run Lighthouse audit with timeout protection
        const lighthouseResult = await Promise.race([
          this.runLighthouseAudit(request.websiteUrl, request.options?.mobile),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Lighthouse audit timeout')), config.requestTimeout)
          )
        ]) as any;
        
        // Take screenshot if requested
        let screenshot: string | undefined;
        if (request.options?.includeScreenshot) {
          try {
            await page.goto(request.websiteUrl, { 
              waitUntil: 'networkidle2',
              timeout: 30000 
            });
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
      
      // Note: Callback functionality disabled for now
      // await this.sendCallback(auditResult);
      
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
      
      // Note: Callback functionality disabled for now
      // await this.sendCallback(auditResult);
    }
  }

  private async runLighthouseAudit(url: string, mobile = false) {
    // Simplified audit using just Puppeteer instead of chrome-launcher
    // This avoids the complex Chrome launcher that was causing WebSocket issues
    
    try {
      const browser = await this.getBrowser();
      const page = await browser.newPage();
      
      try {
        // Configure page for mobile/desktop
        if (mobile) {
          await page.setViewport({ width: 375, height: 667 });
          await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15');
        } else {
          await page.setViewport({ 
            width: config.lighthouse.settings.screenEmulation.width, 
            height: config.lighthouse.settings.screenEmulation.height 
          });
        }
        
        // Set timeouts for stability
        await page.setDefaultTimeout(30000);
        await page.setDefaultNavigationTimeout(30000);
        
        // Navigate to page with retries
        let response;
        let navRetries = 0;
        const maxNavRetries = 3;
        
        while (navRetries < maxNavRetries) {
          try {
            response = await page.goto(url, { 
              waitUntil: 'networkidle2',
              timeout: config.requestTimeout 
            });
            if (response) break;
          } catch (error) {
            navRetries++;
            console.warn(`Navigation attempt ${navRetries} failed:`, error);
            if (navRetries >= maxNavRetries) throw error;
            await new Promise(resolve => setTimeout(resolve, 2000));
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
          const links = document.querySelectorAll('a');
          
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
        
      } finally {
        try {
          await page.close();
        } catch (error) {
          console.warn('Page close error in runLighthouseAudit (ignored):', error);
        }
      }
      
    } catch (error) {
      console.error('Simplified audit failed:', error);
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
