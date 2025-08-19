import { AuditService } from './dist/services/auditService.js';

const auditService = new AuditService();

// Mock audit data to test the extractIssues method
const mockAuditData = {
  performanceScore: 40, // Low score to trigger issues
  seoScore: 35, // Low score to trigger issues
  accessibilityScore: 45, // Low score to trigger issues
  bestPracticesScore: 60, // Below threshold to trigger issues
  loadTime: 6000, // High load time to trigger issues
  categoryDetails: {
    seo: {
      items: [
        {
          title: 'Page Title',
          status: 'FAIL',
          description: 'Page is missing a title tag'
        },
        {
          title: 'Meta Description', 
          status: 'FAIL',
          description: 'Page is missing a meta description'
        }
      ]
    },
    accessibility: {
      items: [
        {
          title: 'Image Alt Text',
          status: 'FAIL',
          description: '5 out of 10 images are missing alt text'
        }
      ]
    }
  },
  pageSpeedMetrics: {
    desktop: {
      firstContentfulPaint: 2500,
      largestContentfulPaint: 5500, // High LCP to trigger issue
      cumulativeLayoutShift: 0.35 // High CLS to trigger issue
    },
    mobile: {
      firstContentfulPaint: 3200,
      largestContentfulPaint: 6800, // High LCP to trigger issue
      cumulativeLayoutShift: 0.28 // High CLS to trigger issue
    }
  }
};

console.log('Testing extractIssues method...');
console.log('Input data:', JSON.stringify(mockAuditData, null, 2));

// Access the private method through a workaround for testing
const issues = auditService.extractIssues(mockAuditData);

console.log('\nGenerated Issues:');
console.log(`Found ${issues.length} issues:`);

issues.forEach((issue, index) => {
  console.log(`\n${index + 1}. [${issue.type}] ${issue.title}`);
  console.log(`   Category: ${issue.category}`);
  console.log(`   Impact: ${issue.impact}`);
  console.log(`   Description: ${issue.description}`);
  console.log(`   Recommendation: ${issue.recommendation}`);
});

console.log('\nTest completed successfully!');
