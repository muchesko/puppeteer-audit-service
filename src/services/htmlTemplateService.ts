// services/htmlTemplateService.ts
import type { AuditResults, AuditIssue } from '../types/audit.js';

export interface BrandingConfig {
  companyName?: string;
  logoUrl?: string;
  primaryColor?: string;
  secondaryColor?: string;
  website?: string;
  contactEmail?: string;
}

export interface ReportData {
  auditId: string;
  websiteUrl: string;
  completedAt: Date;
  createdAt: Date;
  results: AuditResults;
  branding: BrandingConfig;
}

export class HTMLTemplateService {
  /**
   * Generate a complete HTML report for PDF generation
   */
  generateHTMLReport(data: ReportData): string {
    const { results, branding, websiteUrl, completedAt, auditId } = data;
    
    const primaryColor = branding.primaryColor || '#2563eb';
    const secondaryColor = branding.secondaryColor || '#64748b';
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SEO Audit Report - ${websiteUrl}</title>
  <style>
    ${this.getBaseStyles()}
    ${this.getCustomStyles(primaryColor, secondaryColor)}
  </style>
</head>
<body>
  <!-- Executive Summary Page -->
  <div class="page executive-summary">
    ${this.generateHeaderSection(branding, websiteUrl, completedAt)}
    ${this.generateExecutiveSummary(results)}
    ${this.generateKeyMetrics(results)}
    ${this.generateTopIssues(results.issues.slice(0, 5))}
    ${this.generateFooter(branding, auditId)}
  </div>
  
  <!-- Page Break -->
  <div class="page-break"></div>
  
  <!-- Performance Analysis Page -->
  <div class="page performance-analysis">
    ${this.generatePageHeader('Performance Analysis', branding)}
    ${this.generatePerformanceSection(results)}
    ${this.generateWebVitalsSection(results)}
    ${this.generateFooter(branding, auditId)}
  </div>
  
  <!-- Page Break -->
  <div class="page-break"></div>
  
  <!-- SEO Analysis Page -->
  <div class="page seo-analysis">
    ${this.generatePageHeader('SEO Analysis', branding)}
    ${this.generateSEOSection(results)}
    ${this.generateSEOIssues(results.issues.filter((issue: AuditIssue) => issue.category === 'SEO'))}
    ${this.generateFooter(branding, auditId)}
  </div>
  
  <!-- Page Break -->
  <div class="page-break"></div>
  
  <!-- Accessibility Analysis Page -->
  <div class="page accessibility-analysis">
    ${this.generatePageHeader('Accessibility Analysis', branding)}
    ${this.generateAccessibilitySection(results)}
    ${this.generateAccessibilityIssues(results.issues.filter((issue: AuditIssue) => issue.category === 'ACCESSIBILITY'))}
    ${this.generateFooter(branding, auditId)}
  </div>
  
  <!-- Page Break -->
  <div class="page-break"></div>
  
  <!-- Best Practices Analysis Page -->
  <div class="page best-practices-analysis">
    ${this.generatePageHeader('Best Practices Analysis', branding)}
    ${this.generateBestPracticesSection(results)}
    ${this.generateBestPracticesIssues(results.issues.filter((issue: AuditIssue) => issue.category === 'BEST_PRACTICES'))}
    ${this.generateFooter(branding, auditId)}
  </div>
  
  <!-- Page Break -->
  <div class="page-break"></div>
  
  <!-- Detailed Issues Page -->
  <div class="page detailed-issues">
    ${this.generatePageHeader('Detailed Issues & Recommendations', branding)}
    ${this.generateDetailedIssues(results.issues)}
    ${this.generateFooter(branding, auditId)}
  </div>
  
  <!-- Page Break -->
  <div class="page-break"></div>
  
  <!-- Summary & Next Steps -->
  <div class="page summary">
    ${this.generatePageHeader('Summary & Next Steps', branding)}
    ${this.generateSummarySection(results)}
    ${this.generateRecommendations(results)}
    ${this.generateFooter(branding, auditId)}
  </div>
</body>
</html>
    `.trim();
  }

  private getBaseStyles(): string {
    return `
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      
      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        line-height: 1.6;
        color: #333;
        font-size: 14px;
      }
      
      .page {
        min-height: 297mm;
        max-width: 210mm;
        margin: 0 auto;
        padding: 20mm;
        position: relative;
        background: white;
      }
      
      .page-break {
        page-break-before: always;
        page-break-after: avoid;
      }
      
      .header {
        border-bottom: 3px solid var(--primary-color);
        padding-bottom: 20px;
        margin-bottom: 30px;
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
      }
      
      .logo-section img {
        max-height: 50px;
        max-width: 200px;
        object-fit: contain;
      }
      
      .company-info {
        text-align: right;
      }
      
      .company-name {
        font-size: 24px;
        font-weight: bold;
        color: var(--primary-color);
        margin-bottom: 5px;
      }
      
      .report-title {
        font-size: 32px;
        font-weight: bold;
        color: var(--primary-color);
        margin: 30px 0 10px 0;
      }
      
      .report-subtitle {
        font-size: 18px;
        color: var(--secondary-color);
        margin-bottom: 5px;
      }
      
      .report-date {
        font-size: 14px;
        color: var(--secondary-color);
      }
      
      .section {
        margin-bottom: 40px;
      }
      
      .section-title {
        font-size: 20px;
        font-weight: bold;
        color: var(--primary-color);
        margin-bottom: 15px;
        padding-bottom: 5px;
        border-bottom: 2px solid var(--primary-color);
      }
      
      .metrics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 20px;
        margin-bottom: 30px;
      }
      
      .metric-card {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 20px;
        text-align: center;
      }
      
      .metric-label {
        font-size: 14px;
        color: var(--secondary-color);
        margin-bottom: 5px;
      }
      
      .metric-value {
        font-size: 36px;
        font-weight: bold;
        margin-bottom: 5px;
      }
      
      .metric-status {
        font-size: 12px;
        font-weight: bold;
        text-transform: uppercase;
        padding: 4px 8px;
        border-radius: 4px;
      }
      
      .score-excellent { color: #059669; background: #dcfce7; }
      .score-good { color: #d97706; background: #fef3c7; }
      .score-needs-improvement { color: #dc2626; background: #fecaca; }
      
      .value-excellent { color: #059669; }
      .value-good { color: #d97706; }
      .value-needs-improvement { color: #dc2626; }
      
      .issues-list {
        list-style: none;
      }
      
      .issue-item {
        background: #f8fafc;
        border-left: 4px solid #e2e8f0;
        padding: 15px;
        margin-bottom: 15px;
        border-radius: 0 8px 8px 0;
      }
      
      .issue-error { border-left-color: #dc2626; }
      .issue-warning { border-left-color: #d97706; }
      .issue-info { border-left-color: #2563eb; }
      
      .issue-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 10px;
      }
      
      .issue-title {
        font-weight: bold;
        color: #1f2937;
        font-size: 16px;
      }
      
      .issue-type {
        font-size: 12px;
        font-weight: bold;
        text-transform: uppercase;
        padding: 4px 8px;
        border-radius: 4px;
        white-space: nowrap;
      }
      
      .type-error { color: #dc2626; background: #fecaca; }
      .type-warning { color: #d97706; background: #fef3c7; }
      .type-info { color: #2563eb; background: #dbeafe; }
      
      .issue-description {
        color: var(--secondary-color);
        margin-bottom: 10px;
        line-height: 1.5;
      }
      
      .issue-recommendation {
        background: #f0f9ff;
        border: 1px solid #0ea5e9;
        border-radius: 6px;
        padding: 10px;
        font-size: 13px;
        color: #0c4a6e;
      }
      
      .footer {
        position: absolute;
        bottom: 20mm;
        left: 20mm;
        right: 20mm;
        border-top: 1px solid #e2e8f0;
        padding-top: 15px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        color: var(--secondary-color);
      }
      
      .page-number::after {
        content: counter(page);
      }
      
      .recommendations-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 20px;
      }
      
      .recommendation-card {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 20px;
      }
      
      .priority-high {
        border-left: 4px solid #dc2626;
      }
      
      .priority-medium {
        border-left: 4px solid #d97706;
      }
      
      .priority-low {
        border-left: 4px solid #059669;
      }
      
      .recommendation-title {
        font-weight: bold;
        margin-bottom: 10px;
        font-size: 16px;
      }
      
      .recommendation-impact {
        font-size: 12px;
        font-weight: bold;
        text-transform: uppercase;
        padding: 4px 8px;
        border-radius: 4px;
        display: inline-block;
        margin-bottom: 10px;
      }
      
      .impact-high { color: #dc2626; background: #fecaca; }
      .impact-medium { color: #d97706; background: #fef3c7; }
      .impact-low { color: #059669; background: #dcfce7; }
      
      .web-vitals-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 20px;
        margin-bottom: 30px;
      }
      
      .vital-card {
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 20px;
      }
      
      .vital-name {
        font-size: 14px;
        color: var(--secondary-color);
        margin-bottom: 5px;
      }
      
      .vital-value {
        font-size: 28px;
        font-weight: bold;
        margin-bottom: 5px;
      }
      
      .vital-threshold {
        font-size: 12px;
        color: var(--secondary-color);
      }
      
      .summary-stats {
        background: linear-gradient(135deg, var(--primary-color), #1e40af);
        color: white;
        border-radius: 12px;
        padding: 30px;
        margin-bottom: 30px;
        text-align: center;
      }
      
      .summary-stats h3 {
        font-size: 24px;
        margin-bottom: 20px;
      }
      
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 20px;
      }
      
      .stat-item {
        text-align: center;
      }
      
      .stat-value {
        font-size: 32px;
        font-weight: bold;
        display: block;
      }
      
      .stat-label {
        font-size: 14px;
        opacity: 0.9;
      }
    `;
  }

  private getCustomStyles(primaryColor: string, secondaryColor: string): string {
    return `
      :root {
        --primary-color: ${primaryColor};
        --secondary-color: ${secondaryColor};
      }
    `;
  }

  private generateHeaderSection(branding: BrandingConfig, websiteUrl: string, completedAt: Date): string {
    return `
      <div class="header">
        <div class="logo-section">
          ${branding.logoUrl ? 
            `<img src="${branding.logoUrl}" alt="${branding.companyName || 'Company'} Logo">` : 
            `<div class="company-name">${branding.companyName || 'SEO Report'}</div>`
          }
        </div>
        <div class="company-info">
          ${branding.companyName ? `<div class="company-name">${branding.companyName}</div>` : ''}
          ${branding.website ? `<div>${branding.website}</div>` : ''}
          ${branding.contactEmail ? `<div>${branding.contactEmail}</div>` : ''}
        </div>
      </div>
      
      <div class="report-title">SEO Audit Report</div>
      <div class="report-subtitle">${websiteUrl}</div>
      <div class="report-date">Generated on ${completedAt.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      })}</div>
    `;
  }

  private generatePageHeader(title: string, branding: BrandingConfig): string {
    return `
      <div class="header">
        <div class="section-title">${title}</div>
        <div class="company-info">
          ${branding.companyName ? `<div class="company-name">${branding.companyName}</div>` : ''}
        </div>
      </div>
    `;
  }

  private generateExecutiveSummary(results: AuditResults): string {
    const overallScore = Math.round((
      (results.performanceScore || 0) +
      (results.seoScore || 0) +
      (results.accessibilityScore || 0) +
      (results.bestPracticesScore || 0)
    ) / 4);

    const getOverallStatus = (score: number) => {
      if (score >= 90) return 'excellent';
      if (score >= 70) return 'good';
      return 'needs-improvement';
    };

    const status = getOverallStatus(overallScore);

    return `
      <div class="section">
        <div class="section-title">Executive Summary</div>
        <div class="summary-stats">
          <h3>Overall Website Score</h3>
          <div class="stat-value" style="font-size: 48px;">${overallScore}/100</div>
          <div class="stat-label">Based on ${results.pagesCrawled || 1} page${(results.pagesCrawled || 1) > 1 ? 's' : ''} analyzed</div>
        </div>
        
        <p style="font-size: 16px; line-height: 1.8; margin-bottom: 20px;">
          This comprehensive SEO audit analyzed your website across four critical dimensions: 
          Performance, SEO, Accessibility, and Best Practices. 
          ${results.issues.length > 0 ? 
            `We identified ${results.issues.length} issues that require attention, ranging from critical performance optimizations to accessibility improvements.` :
            'Your website shows excellent compliance across all tested categories.'
          }
        </p>
        
        ${results.issues.length > 0 ? `
          <p style="font-size: 16px; line-height: 1.8;">
            The recommendations in this report are prioritized by impact and ease of implementation. 
            Addressing the high-priority issues first will deliver the most significant improvements 
            to your website's performance and user experience.
          </p>
        ` : ''}
      </div>
    `;
  }

  private generateKeyMetrics(results: AuditResults): string {
    const getScoreClass = (score: number) => {
      if (score >= 90) return 'score-excellent';
      if (score >= 70) return 'score-good';
      return 'score-needs-improvement';
    };

    const getScoreStatus = (score: number) => {
      if (score >= 90) return 'Excellent';
      if (score >= 70) return 'Good';
      return 'Needs Improvement';
    };

    return `
      <div class="section">
        <div class="section-title">Key Performance Metrics</div>
        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-label">Performance</div>
            <div class="metric-value value-${getScoreClass(results.performanceScore || 0).replace('score-', '')}">${results.performanceScore || 0}</div>
            <div class="metric-status ${getScoreClass(results.performanceScore || 0)}">${getScoreStatus(results.performanceScore || 0)}</div>
          </div>
          
          <div class="metric-card">
            <div class="metric-label">SEO</div>
            <div class="metric-value value-${getScoreClass(results.seoScore || 0).replace('score-', '')}">${results.seoScore || 0}</div>
            <div class="metric-status ${getScoreClass(results.seoScore || 0)}">${getScoreStatus(results.seoScore || 0)}</div>
          </div>
          
          <div class="metric-card">
            <div class="metric-label">Accessibility</div>
            <div class="metric-value value-${getScoreClass(results.accessibilityScore || 0).replace('score-', '')}">${results.accessibilityScore || 0}</div>
            <div class="metric-status ${getScoreClass(results.accessibilityScore || 0)}">${getScoreStatus(results.accessibilityScore || 0)}</div>
          </div>
          
          <div class="metric-card">
            <div class="metric-label">Best Practices</div>
            <div class="metric-value value-${getScoreClass(results.bestPracticesScore || 0).replace('score-', '')}">${results.bestPracticesScore || 0}</div>
            <div class="metric-status ${getScoreClass(results.bestPracticesScore || 0)}">${getScoreStatus(results.bestPracticesScore || 0)}</div>
          </div>
        </div>
      </div>
    `;
  }

  private generateTopIssues(issues: AuditIssue[]): string {
    if (issues.length === 0) {
      return `
        <div class="section">
          <div class="section-title">Top Priority Issues</div>
          <div style="text-align: center; padding: 40px; background: #f0f9ff; border-radius: 8px; color: #0c4a6e;">
            <strong>Excellent!</strong> No critical issues were found during this audit.
          </div>
        </div>
      `;
    }

    return `
      <div class="section">
        <div class="section-title">Top Priority Issues</div>
        <ul class="issues-list">
          ${issues.map(issue => `
            <li class="issue-item issue-${issue.type.toLowerCase()}">
              <div class="issue-header">
                <div class="issue-title">${issue.title}</div>
                <div class="issue-type type-${issue.type.toLowerCase()}">${issue.type}</div>
              </div>
              <div class="issue-description">${issue.description}</div>
              <div class="issue-recommendation"><strong>Recommendation:</strong> ${issue.recommendation}</div>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }

  private generatePerformanceSection(results: AuditResults): string {
    const performanceIssues = results.issues.filter((issue: AuditIssue) => issue.category === 'PERFORMANCE');
    
    return `
      <div class="section">
        <div class="section-title">Performance Overview</div>
        <p style="margin-bottom: 20px;">
          Performance directly impacts user experience, search rankings, and conversion rates. 
          Your performance score of <strong>${results.performanceScore || 0}/100</strong> is based on 
          key loading metrics and user experience indicators.
        </p>
        
        ${performanceIssues.length > 0 ? `
          <div style="background: #fef3c7; border: 1px solid #d97706; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <strong>Performance Impact:</strong> We found ${performanceIssues.length} performance-related 
            issue${performanceIssues.length > 1 ? 's' : ''} that could be affecting your website's loading speed and user experience.
          </div>
        ` : `
          <div style="background: #dcfce7; border: 1px solid #059669; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <strong>Great Performance!</strong> Your website demonstrates excellent performance metrics 
            with fast loading times and optimal user experience.
          </div>
        `}
      </div>
    `;
  }

  private generateWebVitalsSection(results: AuditResults): string {
    const metrics = results.metrics;
    const pageSpeedMetrics = results.pageSpeedMetrics;
    
    if (!metrics && !pageSpeedMetrics) {
      return `
        <div class="section">
          <div class="section-title">Core Web Vitals</div>
          <p>Core Web Vitals data was not available for this audit.</p>
        </div>
      `;
    }

    const getVitalStatus = (value: number, thresholds: {good: number, needs: number}) => {
      if (value <= thresholds.good) return 'excellent';
      if (value <= thresholds.needs) return 'good';
      return 'needs-improvement';
    };

    return `
      <div class="section">
        <div class="section-title">Core Web Vitals</div>
        <p style="margin-bottom: 20px;">
          Core Web Vitals are Google's metrics for measuring user experience quality. 
          These metrics directly impact your search rankings.
        </p>
        
        <div class="web-vitals-grid">
          ${metrics?.loadTime ? `
            <div class="vital-card">
              <div class="vital-name">Page Load Time</div>
              <div class="vital-value value-${getVitalStatus(metrics.loadTime, {good: 2000, needs: 4000})}">${(metrics.loadTime / 1000).toFixed(1)}s</div>
              <div class="vital-threshold">Good: &lt; 2.0s | Needs Improvement: &lt; 4.0s</div>
            </div>
          ` : ''}
          
          ${pageSpeedMetrics?.largestContentfulPaint ? `
            <div class="vital-card">
              <div class="vital-name">Largest Contentful Paint</div>
              <div class="vital-value value-${getVitalStatus(pageSpeedMetrics.largestContentfulPaint, {good: 2500, needs: 4000})}">${(pageSpeedMetrics.largestContentfulPaint / 1000).toFixed(1)}s</div>
              <div class="vital-threshold">Good: &lt; 2.5s | Needs Improvement: &lt; 4.0s</div>
            </div>
          ` : ''}
          
          ${metrics?.cumulativeLayoutShift !== undefined ? `
            <div class="vital-card">
              <div class="vital-name">Cumulative Layout Shift</div>
              <div class="vital-value value-${getVitalStatus(metrics.cumulativeLayoutShift, {good: 0.1, needs: 0.25})}">${metrics.cumulativeLayoutShift.toFixed(3)}</div>
              <div class="vital-threshold">Good: &lt; 0.1 | Needs Improvement: &lt; 0.25</div>
            </div>
          ` : ''}
          
          ${pageSpeedMetrics?.firstInputDelay ? `
            <div class="vital-card">
              <div class="vital-name">First Input Delay</div>
              <div class="vital-value value-${getVitalStatus(pageSpeedMetrics.firstInputDelay, {good: 100, needs: 300})}">${pageSpeedMetrics.firstInputDelay}ms</div>
              <div class="vital-threshold">Good: &lt; 100ms | Needs Improvement: &lt; 300ms</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  private generateSEOSection(results: AuditResults): string {
    const seoIssues = results.issues.filter((issue: AuditIssue) => issue.category === 'SEO');
    
    return `
      <div class="section">
        <div class="section-title">SEO Overview</div>
        <p style="margin-bottom: 20px;">
          Search Engine Optimization affects your website's visibility in search results. 
          Your SEO score of <strong>${results.seoScore || 0}/100</strong> reflects how well 
          your site follows SEO best practices and guidelines.
        </p>
        
        ${seoIssues.length > 0 ? `
          <div style="background: #fef3c7; border: 1px solid #d97706; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <strong>SEO Opportunities:</strong> We identified ${seoIssues.length} SEO improvement${seoIssues.length > 1 ? 's' : ''} 
            that could help increase your search engine visibility and rankings.
          </div>
        ` : `
          <div style="background: #dcfce7; border: 1px solid #059669; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <strong>Excellent SEO!</strong> Your website follows SEO best practices and is well-optimized for search engines.
          </div>
        `}
      </div>
    `;
  }

  private generateSEOIssues(issues: AuditIssue[]): string {
    if (issues.length === 0) {
      return `
        <div class="section">
          <div class="section-title">SEO Analysis Details</div>
          <div style="text-align: center; padding: 40px; background: #f0f9ff; border-radius: 8px; color: #0c4a6e;">
            No SEO issues found. Your website follows SEO best practices.
          </div>
        </div>
      `;
    }

    return `
      <div class="section">
        <div class="section-title">SEO Issues & Recommendations</div>
        <ul class="issues-list">
          ${issues.map(issue => `
            <li class="issue-item issue-${issue.type.toLowerCase()}">
              <div class="issue-header">
                <div class="issue-title">${issue.title}</div>
                <div class="issue-type type-${issue.type.toLowerCase()}">${issue.type}</div>
              </div>
              <div class="issue-description">${issue.description}</div>
              <div class="issue-recommendation"><strong>Recommendation:</strong> ${issue.recommendation}</div>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }

  private generateAccessibilitySection(results: AuditResults): string {
    const accessibilityIssues = results.issues.filter((issue: AuditIssue) => issue.category === 'ACCESSIBILITY');
    
    return `
      <div class="section">
        <div class="section-title">Accessibility Overview</div>
        <p style="margin-bottom: 20px;">
          Web accessibility ensures your site is usable by people with disabilities and follows WCAG guidelines. 
          Your accessibility score of <strong>${results.accessibilityScore || 0}/100</strong> indicates 
          how well your site serves users with various abilities and assistive technologies.
        </p>
        
        ${accessibilityIssues.length > 0 ? `
          <div style="background: #fef3c7; border: 1px solid #d97706; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <strong>Accessibility Improvements Needed:</strong> We found ${accessibilityIssues.length} accessibility 
            issue${accessibilityIssues.length > 1 ? 's' : ''} that could prevent some users from fully accessing your content.
          </div>
        ` : `
          <div style="background: #dcfce7; border: 1px solid #059669; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <strong>Great Accessibility!</strong> Your website demonstrates excellent accessibility standards 
            and is inclusive for users with disabilities.
          </div>
        `}
      </div>
    `;
  }

  private generateAccessibilityIssues(issues: AuditIssue[]): string {
    if (issues.length === 0) {
      return `
        <div class="section">
          <div class="section-title">Accessibility Analysis Details</div>
          <div style="text-align: center; padding: 40px; background: #f0f9ff; border-radius: 8px; color: #0c4a6e;">
            No accessibility issues found. Your website follows WCAG guidelines.
          </div>
        </div>
      `;
    }

    return `
      <div class="section">
        <div class="section-title">Accessibility Issues & Recommendations</div>
        <ul class="issues-list">
          ${issues.map(issue => `
            <li class="issue-item issue-${issue.type.toLowerCase()}">
              <div class="issue-header">
                <div class="issue-title">${issue.title}</div>
                <div class="issue-type type-${issue.type.toLowerCase()}">${issue.type}</div>
              </div>
              <div class="issue-description">${issue.description}</div>
              <div class="issue-recommendation"><strong>Recommendation:</strong> ${issue.recommendation}</div>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }

  private generateBestPracticesSection(results: AuditResults): string {
    const bestPracticesIssues = results.issues.filter((issue: AuditIssue) => issue.category === 'BEST_PRACTICES');
    
    return `
      <div class="section">
        <div class="section-title">Best Practices Overview</div>
        <p style="margin-bottom: 20px;">
          Best practices ensure your website follows modern web standards for security, performance, and user experience. 
          Your best practices score of <strong>${results.bestPracticesScore || 0}/100</strong> reflects 
          compliance with current web development standards.
        </p>
        
        ${bestPracticesIssues.length > 0 ? `
          <div style="background: #fef3c7; border: 1px solid #d97706; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <strong>Best Practices Improvements:</strong> We identified ${bestPracticesIssues.length} area${bestPracticesIssues.length > 1 ? 's' : ''} 
            where your site could better follow modern web development best practices.
          </div>
        ` : `
          <div style="background: #dcfce7; border: 1px solid #059669; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
            <strong>Excellent Standards!</strong> Your website follows modern web development best practices 
            and maintains high standards for security and user experience.
          </div>
        `}
      </div>
    `;
  }

  private generateBestPracticesIssues(issues: AuditIssue[]): string {
    if (issues.length === 0) {
      return `
        <div class="section">
          <div class="section-title">Best Practices Analysis Details</div>
          <div style="text-align: center; padding: 40px; background: #f0f9ff; border-radius: 8px; color: #0c4a6e;">
            No best practices issues found. Your website follows modern web standards.
          </div>
        </div>
      `;
    }

    return `
      <div class="section">
        <div class="section-title">Best Practices Issues & Recommendations</div>
        <ul class="issues-list">
          ${issues.map(issue => `
            <li class="issue-item issue-${issue.type.toLowerCase()}">
              <div class="issue-header">
                <div class="issue-title">${issue.title}</div>
                <div class="issue-type type-${issue.type.toLowerCase()}">${issue.type}</div>
              </div>
              <div class="issue-description">${issue.description}</div>
              <div class="issue-recommendation"><strong>Recommendation:</strong> ${issue.recommendation}</div>
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }

  private generateDetailedIssues(issues: AuditIssue[]): string {
    if (issues.length === 0) {
      return `
        <div class="section">
          <div class="section-title">Detailed Issues Analysis</div>
          <div style="text-align: center; padding: 40px; background: #f0f9ff; border-radius: 8px; color: #0c4a6e;">
            <strong>No issues found!</strong> Your website demonstrates excellent compliance across all audit categories.
          </div>
        </div>
      `;
    }

    // Group issues by category
    const groupedIssues = issues.reduce((acc: Record<string, AuditIssue[]>, issue: AuditIssue) => {
      if (!acc[issue.category]) acc[issue.category] = [];
      acc[issue.category].push(issue);
      return acc;
    }, {} as Record<string, AuditIssue[]>);

    const categoryNames = {
      'PERFORMANCE': 'Performance Issues',
      'SEO': 'SEO Issues',
      'ACCESSIBILITY': 'Accessibility Issues',
      'BEST_PRACTICES': 'Best Practices Issues'
    };

    return `
      <div class="section">
        <div class="section-title">All Issues & Recommendations</div>
        ${Object.entries(groupedIssues).map(([category, categoryIssues]: [string, AuditIssue[]]) => `
          <div style="margin-bottom: 40px;">
            <h3 style="color: var(--primary-color); margin-bottom: 20px; font-size: 18px;">
              ${categoryNames[category as keyof typeof categoryNames] || category} (${categoryIssues.length})
            </h3>
            <ul class="issues-list">
              ${categoryIssues.map((issue: AuditIssue, index: number) => `
                <li class="issue-item issue-${issue.type.toLowerCase()}">
                  <div class="issue-header">
                    <div class="issue-title">${index + 1}. ${issue.title}</div>
                    <div class="issue-type type-${issue.type.toLowerCase()}">${issue.type}</div>
                  </div>
                  <div style="margin-bottom: 10px;">
                    <span class="recommendation-impact impact-${issue.impact.toLowerCase()}">${issue.impact} Impact</span>
                  </div>
                  <div class="issue-description">${issue.description}</div>
                  <div class="issue-recommendation"><strong>Recommendation:</strong> ${issue.recommendation}</div>
                </li>
              `).join('')}
            </ul>
          </div>
        `).join('')}
      </div>
    `;
  }

  private generateSummarySection(results: AuditResults): string {
    const totalIssues = results.issues.length;
    const highPriorityIssues = results.issues.filter((issue: AuditIssue) => issue.impact === 'HIGH').length;
    const mediumPriorityIssues = results.issues.filter((issue: AuditIssue) => issue.impact === 'MEDIUM').length;
    const lowPriorityIssues = results.issues.filter((issue: AuditIssue) => issue.impact === 'LOW').length;

    return `
      <div class="section">
        <div class="section-title">Audit Summary</div>
        <div class="summary-stats">
          <h3>Analysis Results</h3>
          <div class="stats-grid">
            <div class="stat-item">
              <span class="stat-value">${results.pagesCrawled || 1}</span>
              <span class="stat-label">Pages Analyzed</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">${totalIssues}</span>
              <span class="stat-label">Total Issues</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">${highPriorityIssues}</span>
              <span class="stat-label">High Priority</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">${mediumPriorityIssues + lowPriorityIssues}</span>
              <span class="stat-label">Other Issues</span>
            </div>
          </div>
        </div>
        
        <p style="font-size: 16px; line-height: 1.8; margin-bottom: 20px;">
          This audit provides a comprehensive analysis of your website's performance, SEO, accessibility, 
          and adherence to best practices. The identified issues are categorized by priority to help you 
          focus on the most impactful improvements first.
        </p>
      </div>
    `;
  }

  private generateRecommendations(results: AuditResults): string {
    const highPriorityIssues = results.issues.filter((issue: AuditIssue) => issue.impact === 'HIGH').slice(0, 3);
    const mediumPriorityIssues = results.issues.filter((issue: AuditIssue) => issue.impact === 'MEDIUM').slice(0, 3);
    
    return `
      <div class="section">
        <div class="section-title">Priority Recommendations</div>
        
        ${highPriorityIssues.length > 0 ? `
          <h3 style="color: #dc2626; margin-bottom: 15px;">High Priority (Immediate Action)</h3>
          <div class="recommendations-grid">
            ${highPriorityIssues.map((issue: AuditIssue, index: number) => `
              <div class="recommendation-card priority-high">
                <div class="recommendation-title">${index + 1}. ${issue.title}</div>
                <div class="recommendation-impact impact-high">High Impact</div>
                <p>${issue.recommendation}</p>
              </div>
            `).join('')}
          </div>
        ` : ''}
        
        ${mediumPriorityIssues.length > 0 ? `
          <h3 style="color: #d97706; margin: 30px 0 15px 0;">Medium Priority (Next Phase)</h3>
          <div class="recommendations-grid">
            ${mediumPriorityIssues.map((issue: AuditIssue, index: number) => `
              <div class="recommendation-card priority-medium">
                <div class="recommendation-title">${index + 1}. ${issue.title}</div>
                <div class="recommendation-impact impact-medium">Medium Impact</div>
                <p>${issue.recommendation}</p>
              </div>
            `).join('')}
          </div>
        ` : ''}
        
        ${highPriorityIssues.length === 0 && mediumPriorityIssues.length === 0 ? `
          <div style="text-align: center; padding: 40px; background: #f0f9ff; border-radius: 8px; color: #0c4a6e;">
            <strong>Excellent work!</strong> No high or medium priority issues were identified. 
            Your website demonstrates strong performance across all audit categories.
          </div>
        ` : ''}
      </div>
    `;
  }

  private generateFooter(branding: BrandingConfig, auditId: string): string {
    return `
      <div class="footer">
        <div>
          ${branding.companyName ? `Generated by ${branding.companyName} | ` : ''}
          Powered by Meizo
        </div>
        <div>
          Audit ID: ${auditId} | Page <span class="page-number"></span>
        </div>
      </div>
    `;
  }
}
