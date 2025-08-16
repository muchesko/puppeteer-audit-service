import puppeteer, { Browser, Page, PDFOptions } from 'puppeteer';
import { config } from '../config/index.js';

export interface PDFRequest {
  jobId: string;
  htmlContent: string;
  options?: {
    format?: 'A4' | 'Letter';
    orientation?: 'portrait' | 'landscape';
    margin?: {
      top?: string;
      right?: string;
      bottom?: string;
      left?: string;
    };
    displayHeaderFooter?: boolean;
    headerTemplate?: string;
    footerTemplate?: string;
    printBackground?: boolean;
    scale?: number;
  };
}

export class PDFService {
  private activeBrowser: Browser | null = null;

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
          '--disable-renderer-backgrounding',
          '--disable-features=TranslateUI',
          '--disable-ipc-flooding-protection',
          '--disable-background-networking',
          '--disable-sync',
          '--disable-default-apps',
          '--no-default-browser-check',
          '--no-pings',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--memory-pressure-off',
          '--max_old_space_size=4096'
        ],
        timeout: 30000,
        protocolTimeout: 30000
      });
    }
    return this.activeBrowser;
  }

  async generatePDF(request: PDFRequest): Promise<Buffer> {
    // Add retry logic for browser launch
    let browser: Browser;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        browser = await this.getBrowser();
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
            // Ignore cleanup errors
          }
          this.activeBrowser = null;
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
      }
    }
    
    const page = await browser!.newPage();
    
    try {
      // Set content
      await page.setContent(request.htmlContent, {
        waitUntil: 'networkidle0',
        timeout: config.requestTimeout
      });
      
      // Configure PDF options
      const pdfOptions: PDFOptions = {
        format: request.options?.format || 'A4',
        landscape: request.options?.orientation === 'landscape',
        margin: {
          top: request.options?.margin?.top || '1cm',
          right: request.options?.margin?.right || '1cm',
          bottom: request.options?.margin?.bottom || '1cm',
          left: request.options?.margin?.left || '1cm'
        },
        displayHeaderFooter: request.options?.displayHeaderFooter || false,
        headerTemplate: request.options?.headerTemplate || '',
        footerTemplate: request.options?.footerTemplate || '',
        printBackground: request.options?.printBackground !== false,
        scale: request.options?.scale || 1,
        timeout: config.requestTimeout
      };
      
      // Generate PDF
      const pdfData = await page.pdf(pdfOptions);
      
      return Buffer.from(pdfData);
      
    } finally {
      await page.close();
    }
  }

  async generatePDFFromURL(url: string, options?: PDFRequest['options']): Promise<Buffer> {
    // Add retry logic for browser launch
    let browser: Browser;
    let retryCount = 0;
    const maxRetries = 3;
    
    while (retryCount < maxRetries) {
      try {
        browser = await this.getBrowser();
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
            // Ignore cleanup errors
          }
          this.activeBrowser = null;
        }
        
        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
      }
    }
    
    const page = await browser!.newPage();
    
    try {
      // Navigate to URL
      await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: config.requestTimeout
      });
      
      // Configure PDF options
      const pdfOptions: PDFOptions = {
        format: options?.format || 'A4',
        landscape: options?.orientation === 'landscape',
        margin: {
          top: options?.margin?.top || '1cm',
          right: options?.margin?.right || '1cm',
          bottom: options?.margin?.bottom || '1cm',
          left: options?.margin?.left || '1cm'
        },
        displayHeaderFooter: options?.displayHeaderFooter || false,
        headerTemplate: options?.headerTemplate || '',
        footerTemplate: options?.footerTemplate || '',
        printBackground: options?.printBackground !== false,
        scale: options?.scale || 1,
        timeout: config.requestTimeout
      };
      
      // Generate PDF
      const pdfData = await page.pdf(pdfOptions);
      
      return Buffer.from(pdfData);
      
    } finally {
      await page.close();
    }
  }

  async cleanup(): Promise<void> {
    if (this.activeBrowser) {
      await this.activeBrowser.close();
      this.activeBrowser = null;
    }
  }
}
