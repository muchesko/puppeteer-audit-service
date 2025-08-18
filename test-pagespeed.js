#!/usr/bin/env node

/**
 * Test script for PageSpeed Insights integration
 */

const { config } = await import('./src/config/index.js');

console.log('Testing PageSpeed Insights integration...');

// Mock the config to use a test API key (you would need to set PAGESPEED_API_KEY env var)
console.log('PageSpeed API Key configured:', config.pageSpeedApiKey ? 'Yes' : 'No');

if (!config.pageSpeedApiKey) {
  console.log('Note: Set PAGESPEED_API_KEY environment variable to test PageSpeed Insights integration');
  console.log('Example: export PAGESPEED_API_KEY="your-google-api-key"');
  process.exit(0);
}

// Test the PageSpeed Insights API call
const testUrl = 'https://example.com';
const apiUrl = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
apiUrl.searchParams.set('url', testUrl);
apiUrl.searchParams.set('key', config.pageSpeedApiKey);
apiUrl.searchParams.set('strategy', 'desktop');
apiUrl.searchParams.set('category', 'performance');

console.log('Testing PageSpeed Insights API with URL:', testUrl);
console.log('API endpoint:', apiUrl.toString());

try {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  const response = await fetch(apiUrl.toString(), {
    signal: controller.signal,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AuditService/1.0)',
    },
  });

  clearTimeout(timeout);

  if (!response.ok) {
    console.error('API error:', response.status, response.statusText);
    const errorText = await response.text().catch(() => '');
    console.error('Error details:', errorText);
    process.exit(1);
  }

  const data = await response.json();
  
  // Extract performance metrics
  const lighthouseResult = data.lighthouseResult;
  if (!lighthouseResult) {
    console.error('No lighthouse result in response');
    process.exit(1);
  }

  const categories = lighthouseResult.categories;
  const audits = lighthouseResult.audits;

  const performanceScore = Math.round((categories?.performance?.score || 0) * 100);
  const firstContentfulPaint = audits?.['first-contentful-paint']?.numericValue || 0;
  const largestContentfulPaint = audits?.['largest-contentful-paint']?.numericValue || 0;
  const firstInputDelay = audits?.['max-potential-fid']?.numericValue || 0;
  const cumulativeLayoutShift = audits?.['cumulative-layout-shift']?.numericValue || 0;
  const speedIndex = audits?.['speed-index']?.numericValue || 0;
  const totalBlockingTime = audits?.['total-blocking-time']?.numericValue || 0;

  console.log('✅ PageSpeed Insights API test successful!');
  console.log('Metrics received:');
  console.log('  - Performance Score:', performanceScore);
  console.log('  - First Contentful Paint:', Math.round(firstContentfulPaint), 'ms');
  console.log('  - Largest Contentful Paint:', Math.round(largestContentfulPaint), 'ms');
  console.log('  - First Input Delay:', Math.round(firstInputDelay), 'ms');
  console.log('  - Cumulative Layout Shift:', Math.round(cumulativeLayoutShift * 1000) / 1000);
  console.log('  - Speed Index:', Math.round(speedIndex), 'ms');
  console.log('  - Total Blocking Time:', Math.round(totalBlockingTime), 'ms');

} catch (error) {
  if (error.name === 'AbortError') {
    console.error('❌ Request timeout');
  } else {
    console.error('❌ Error calling PageSpeed Insights:', error.message);
  }
  process.exit(1);
}
