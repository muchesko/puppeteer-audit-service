// test-report-generation.js
import { AuditClient } from '../packages/audit-client/src/index.js';
import fs from 'fs';

async function testReportGeneration() {
  console.log('🔧 Testing professional PDF report generation...');
  
  try {
    const auditClient = new AuditClient(
      'http://localhost:3001', // Local development
      'test-api-key',
      'test-webhook-secret'
    );

    // Test 1: Generate sample report
    console.log('\n1. Testing sample report generation...');
    const samplePDF = await auditClient.generateSampleReport();
    console.log('✅ Sample PDF generated successfully');
    console.log(`   Size: ${samplePDF.length} bytes`);
    
    // Save to file for inspection
    fs.writeFileSync('sample-audit-report.pdf', samplePDF);
    console.log('   Saved as: sample-audit-report.pdf');

    // Test 2: Generate report with realistic audit data
    console.log('\n2. Testing realistic audit report generation...');
    const realisticAuditData = {
      auditId: 'audit-real-789',
      websiteUrl: 'https://example-ecommerce.com',
      completedAt: new Date().toISOString(),
      createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      results: {
        performanceScore: 65,
        seoScore: 78,
        accessibilityScore: 82,
        bestPracticesScore: 74,
        issues: [
          {
            type: 'ERROR',
            category: 'PERFORMANCE',
            title: 'Render-blocking resources',
            description: 'CSS and JavaScript files are blocking the initial render of the page, causing poor loading performance.',
            impact: 'HIGH',
            recommendation: 'Defer non-critical CSS and JavaScript, use async loading for scripts that don\'t need to run immediately.'
          },
          {
            type: 'ERROR',
            category: 'PERFORMANCE',
            title: 'Largest Contentful Paint above threshold',
            description: 'The largest element takes too long to load, resulting in poor user experience.',
            impact: 'HIGH',
            recommendation: 'Optimize images, reduce server response times, and implement preloading for critical resources.'
          },
          {
            type: 'WARNING',
            category: 'SEO',
            title: 'Missing meta descriptions',
            description: 'Several pages are missing meta descriptions, which can impact search engine rankings and click-through rates.',
            impact: 'MEDIUM',
            recommendation: 'Write unique, compelling meta descriptions for each page, keeping them between 150-160 characters.'
          },
          {
            type: 'ERROR',
            category: 'ACCESSIBILITY',
            title: 'Insufficient color contrast',
            description: 'Some text elements don\'t meet WCAG AA contrast requirements, making them difficult to read.',
            impact: 'HIGH',
            recommendation: 'Ensure all text has a contrast ratio of at least 4.5:1 for normal text and 3:1 for large text.'
          },
          {
            type: 'WARNING',
            category: 'ACCESSIBILITY',
            title: 'Missing form labels',
            description: 'Form inputs are missing proper labels, making them inaccessible to screen readers.',
            impact: 'MEDIUM',
            recommendation: 'Add proper label elements or aria-label attributes to all form inputs.'
          },
          {
            type: 'WARNING',
            category: 'BEST_PRACTICES',
            title: 'Mixed content issues',
            description: 'The site loads some resources over HTTP instead of HTTPS.',
            impact: 'MEDIUM',
            recommendation: 'Ensure all resources (images, scripts, stylesheets) are loaded over HTTPS.'
          },
          {
            type: 'INFO',
            category: 'BEST_PRACTICES',
            title: 'Browser compatibility',
            description: 'Some features may not work in older browsers.',
            impact: 'LOW',
            recommendation: 'Consider adding polyfills or progressive enhancement for better browser support.'
          }
        ],
        metrics: {
          loadTime: 3200,
          cumulativeLayoutShift: 0.15
        },
        pageSpeedMetrics: {
          performanceScore: 65,
          firstContentfulPaint: 1800,
          largestContentfulPaint: 4200,
          firstInputDelay: 120,
          cumulativeLayoutShift: 0.15,
          speedIndex: 2900,
          totalBlockingTime: 450
        },
        pagesCrawled: 42
      },
      branding: {
        companyName: 'WebOptim Digital Solutions',
        primaryColor: '#059669',
        secondaryColor: '#6b7280',
        website: 'https://weboptim.digital',
        contactEmail: 'reports@weboptim.digital'
      },
      options: {
        format: 'A4',
        orientation: 'portrait',
        printBackground: true
      }
    };

    const realisticPDF = await auditClient.generateAuditReport(realisticAuditData);
    console.log('✅ Realistic audit PDF generated successfully');
    console.log(`   Size: ${realisticPDF.length} bytes`);
    
    // Save to file for inspection
    fs.writeFileSync('realistic-audit-report.pdf', realisticPDF);
    console.log('   Saved as: realistic-audit-report.pdf');

    console.log('\n🎉 All report generation tests passed!');
    console.log('\nGenerated files for review:');
    console.log('  - sample-audit-report.pdf (demo data)');
    console.log('  - realistic-audit-report.pdf (realistic audit scenario)');

  } catch (error) {
    console.error('❌ Report generation test failed:', error);
    console.error('Error details:', error.message);
    
    if (error.message.includes('ECONNREFUSED')) {
      console.log('\n💡 Make sure the puppeteer service is running locally:');
      console.log('   cd meizo/services/puppeteer-service');
      console.log('   npm run dev');
    }
    
    process.exit(1);
  }
}

// Run the test
testReportGeneration();
