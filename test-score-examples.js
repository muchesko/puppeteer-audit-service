import { AuditService } from './dist/services/auditService.js';

// Mock test to show how different scores would be combined
function testCombinedScoreCalculation() {
  console.log('🧮 Testing Combined Score Calculation Examples:\n');
  
  const testCases = [
    { desktop: 90, mobile: 60 },
    { desktop: 70, mobile: 85 },
    { desktop: 45, mobile: 30 },
    { desktop: 95, mobile: 40 },
    { desktop: 50, mobile: 90 }
  ];
  
  testCases.forEach(({ desktop, mobile }, index) => {
    const combined = Math.round((desktop * 0.6) + (mobile * 0.4));
    console.log(`Test ${index + 1}:`);
    console.log(`  Desktop: ${desktop}/100`);
    console.log(`  Mobile:  ${mobile}/100`);
    console.log(`  Combined (60% desktop + 40% mobile): ${combined}/100`);
    console.log(`  Formula: (${desktop} × 0.6) + (${mobile} × 0.4) = ${combined}\n`);
  });
  
  console.log('💡 The weighting favors desktop slightly (60/40) but still gives significant weight to mobile performance.');
}

testCombinedScoreCalculation();
