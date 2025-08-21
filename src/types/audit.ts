// types/audit.ts
export interface AuditResults {
  performanceScore: number;
  seoScore: number;
  accessibilityScore: number;
  bestPracticesScore: number;
  issues: AuditIssue[];
  metrics: {
    loadTime: number;
    cumulativeLayoutShift: number;
  };
  pageSpeedMetrics?: {
    performanceScore: number;
    firstContentfulPaint: number;
    largestContentfulPaint: number;
    firstInputDelay: number;
    cumulativeLayoutShift: number;
    speedIndex: number;
    totalBlockingTime: number;
  };
  pagesCrawled: number;
  screenshots?: string[];
}

export interface AuditIssue {
  type: 'ERROR' | 'WARNING' | 'INFO';
  category: 'PERFORMANCE' | 'SEO' | 'ACCESSIBILITY' | 'BEST_PRACTICES';
  title: string;
  description: string;
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  element?: string;
  recommendation: string;
}
