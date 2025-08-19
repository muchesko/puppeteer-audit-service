import { AuditService } from './dist/services/auditService.js';

async function testCombinedPerformanceScoring() {
  const auditService = new AuditService();
  
  console.log('🚀 Testing combined performance scoring...');
  
  try {
    // Start an audit with PageSpeed enabled
    const jobId = 'test-combined-' + Date.now();
    await auditService.startAudit({
      jobId,
      websiteUrl: 'https://example.com',
      options: {
        includePageSpeedInsights: true
      }
    });
    
    console.log('✅ Audit started, waiting for completion...');
    
    // Poll for completion
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      
      const status = await auditService.getAuditStatus(jobId);
      console.log(`📊 Status check ${attempts + 1}: ${status}`);
      
      if (status === 'COMPLETED' || status === 'FAILED') {
        const details = await auditService.getAuditDetails(jobId);
        
        if (details?.results) {
          console.log('\n🎯 Combined Performance Results:');
          console.log(`Overall Performance Score: ${details.results.performanceScore}/100`);
          
          if (details.results.pageSpeedMetrics) {
            console.log(`Desktop Score: ${details.results.pageSpeedMetrics.desktop?.performanceScore || 0}/100`);
            console.log(`Mobile Score: ${details.results.pageSpeedMetrics.mobile?.performanceScore || 0}/100`);
            
            // Calculate expected combined score
            const desktop = details.results.pageSpeedMetrics.desktop?.performanceScore || 0;
            const mobile = details.results.pageSpeedMetrics.mobile?.performanceScore || 0;
            const expectedCombined = Math.round((desktop * 0.6) + (mobile * 0.4));
            console.log(`Expected Combined (60% desktop + 40% mobile): ${expectedCombined}/100`);
            console.log(`Actual Combined: ${details.results.performanceScore}/100`);
            console.log(`✅ Match: ${expectedCombined === details.results.performanceScore ? 'YES' : 'NO'}`);
          }
          
          // Show performance details
          if (details.results.categoryDetails?.performance?.items) {
            console.log('\n📋 Performance Details:');
            details.results.categoryDetails.performance.items.slice(0, 3).forEach((item, index) => {
              console.log(`${index + 1}. ${item.title}: ${item.value} (${item.status})`);
              console.log(`   ${item.description}`);
            });
          }
          
          // Show any performance issues
          const performanceIssues = details.results.issues?.filter(issue => issue.category === 'PERFORMANCE') || [];
          if (performanceIssues.length > 0) {
            console.log('\n⚠️ Performance Issues Found:');
            performanceIssues.forEach((issue, index) => {
              console.log(`${index + 1}. [${issue.type}] ${issue.title}`);
              console.log(`   ${issue.description}`);
            });
          }
        }
        
        break;
      }
      
      attempts++;
    }
    
    if (attempts >= maxAttempts) {
      console.log('❌ Test timed out waiting for completion');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await auditService.cleanup();
    console.log('🧹 Cleanup completed');
  }
}

testCombinedPerformanceScoring().catch(console.error);
