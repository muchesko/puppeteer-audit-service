import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT || '8080'),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Security - match Koyeb environment variable names
  apiSecretKey: process.env['audit-secret-key'] || process.env.API_KEY || process.env.API_SECRET_KEY || 'default-secret',
  webhookSecret: process.env.WEBHOOK_SECRET || process.env.API_SECRET_KEY || process.env.API_KEY || 'default-secret',
  apiKey: process.env.API_KEY || process.env.API_SECRET_KEY || 'default-api-key',
  
  // Callback
  callbackUrl: process.env.CALLBACK_URL || 'http://localhost:3000/api/audits/callback',
  
  // Chrome/Puppeteer
  chromeExecutablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome',
  puppeteerSkipDownload: process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD === 'true',
  
  // Performance
  maxConcurrentJobs: parseInt(process.env.MAX_CONCURRENT_JOBS || '3'),
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || '300000'), // 5 minutes
  memoryLimit: parseInt(process.env.MEMORY_LIMIT || '512'), // MB
  
  // Lighthouse
  lighthouse: {
    settings: {
      maxWaitForFcp: 15 * 1000,
      maxWaitForLoad: 35 * 1000,
      formFactor: 'desktop' as const,
      throttling: {
        rttMs: 40,
        throughputKbps: 10 * 1024,
        cpuSlowdownMultiplier: 1,
        requestLatencyMs: 0,
        downloadThroughputKbps: 0,
        uploadThroughputKbps: 0
      },
      screenEmulation: {
        mobile: false,
        width: 1350,
        height: 940,
        deviceScaleFactor: 1,
        disabled: false
      },
      emulatedUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.109 Safari/537.36'
    },
    config: {
      extends: 'lighthouse:default',
      settings: {
        onlyAudits: [
          'first-contentful-paint',
          'largest-contentful-paint',
          'first-meaningful-paint',
          'speed-index',
          'total-blocking-time',
          'max-potential-fid',
          'cumulative-layout-shift',
          'server-response-time',
          'interactive',
          'redirects-http',
          'redirects',
          'uses-long-cache-ttl',
          'total-byte-weight',
          'uses-optimized-images',
          'uses-text-compression',
          'unused-css-rules',
          'unused-javascript',
          'modern-image-formats',
          'uses-responsive-images',
          'efficient-animated-content',
          'preload-lcp-image',
          'non-composited-animations',
          'unsized-images',
          'critical-request-chains'
        ]
      }
    }
  }
};
