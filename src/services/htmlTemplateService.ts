// services/htmlTemplateService.ts (Agency‑grade PDF)
// Clean print‑first HTML with consistent spacing, brand tokens, SVG score rings,
// proper page numbers, and table/issue layouts that don’t explode at print time.

import type { AuditResults, AuditIssue } from '../types/audit.js';

export interface BrandingConfig {
  companyName?: string;
  logoUrl?: string;
  primaryColor?: string; // brand primary
  secondaryColor?: string; // muted text
  accentColor?: string; // used for highlights
  website?: string;
  contactEmail?: string;
  addressLine1?: string;
  addressLine2?: string;
  // Optional: add a faint diagonal watermark like "DRAFT"
  watermarkText?: string;
}

export interface ReportData {
  auditId: string;
  websiteUrl: string;
  completedAt: Date;
  createdAt: Date;
  results: AuditResults;
  branding: BrandingConfig;
}

// ===== Utility helpers =====
const clamp = (n: number, min = 0, max = 100) => Math.max(min, Math.min(max, n));
const fmtDate = (d: Date) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

export class HTMLTemplateService {
  /**
   * Generate a complete HTML report for PDF generation
   */
  generateHTMLReport(data: ReportData): string {
    const { results, branding, websiteUrl, completedAt, auditId } = data;

    const primary = branding.primaryColor || '#2563eb';
    const secondary = branding.secondaryColor || '#64748b';
    const accent = branding.accentColor || '#0ea5e9';

    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SEO Audit Report — ${websiteUrl}</title>
  <style>
    ${this.getBaseStyles()}
    ${this.getCustomStyles(primary, secondary, accent)}
  </style>
</head>
<body>
  ${branding.watermarkText ? this.generateWatermark(branding.watermarkText) : ''}

  <!-- ===== Cover ===== -->
  <section class="page cover">
    ${this.generateCover(branding, websiteUrl, completedAt, auditId, results)}
  </section>

  <div class="page-break"></div>

  <!-- ===== Table of Contents ===== -->
  <section class="page toc">
    ${this.generatePageHeader('Table of Contents', branding)}
    ${this.generateTOC([
      ['Executive Summary', '#executive-summary'],
      ['Performance Analysis', '#performance'],
      ['SEO Analysis', '#seo'],
      ['Accessibility Analysis', '#accessibility'],
      ['Best Practices Analysis', '#best-practices'],
      ['Detailed Issues & Recommendations', '#details'],
      ['Summary & Next Steps', '#next-steps']
    ])}
    ${this.generateFooter(branding, auditId)}
  </section>

  <div class="page-break"></div>

  <!-- ===== Executive Summary ===== -->
  <section class="page" id="executive-summary">
    ${this.generatePageHeader('Executive Summary', branding)}
    ${this.generateExecutiveSummary(results)}
    ${this.generateKeyMetrics(results)}
    ${this.generateTopIssues(results.issues.slice(0, 5))}
    ${this.generateFooter(branding, auditId)}
  </section>

  <div class="page-break"></div>

  <!-- ===== Performance ===== -->
  <section class="page" id="performance">
    ${this.generatePageHeader('Performance Analysis', branding)}
    ${this.generatePerformanceSection(results)}
    ${this.generateWebVitalsSection(results)}
    ${this.generateFooter(branding, auditId)}
  </section>

  <div class="page-break"></div>

  <!-- ===== SEO ===== -->
  <section class="page" id="seo">
    ${this.generatePageHeader('SEO Analysis', branding)}
    ${this.generateSEOSection(results)}
    ${this.generateSEOIssues(results.issues.filter((i: AuditIssue) => i.category === 'SEO'))}
    ${this.generateFooter(branding, auditId)}
  </section>

  <div class="page-break"></div>

  <!-- ===== Accessibility ===== -->
  <section class="page" id="accessibility">
    ${this.generatePageHeader('Accessibility Analysis', branding)}
    ${this.generateAccessibilitySection(results)}
    ${this.generateAccessibilityIssues(results.issues.filter((i: AuditIssue) => i.category === 'ACCESSIBILITY'))}
    ${this.generateFooter(branding, auditId)}
  </section>

  <div class="page-break"></div>

  <!-- ===== Best Practices ===== -->
  <section class="page" id="best-practices">
    ${this.generatePageHeader('Best Practices Analysis', branding)}
    ${this.generateBestPracticesSection(results)}
    ${this.generateBestPracticesIssues(results.issues.filter((i: AuditIssue) => i.category === 'BEST_PRACTICES'))}
    ${this.generateFooter(branding, auditId)}
  </section>

  <div class="page-break"></div>

  <!-- ===== Details ===== -->
  <section class="page" id="details">
    ${this.generatePageHeader('Detailed Issues & Recommendations', branding)}
    ${this.generateDetailedIssues(results.issues)}
    ${this.generateFooter(branding, auditId)}
  </section>

  <div class="page-break"></div>

  <!-- ===== Next Steps ===== -->
  <section class="page" id="next-steps">
    ${this.generatePageHeader('Summary & Next Steps', branding)}
    ${this.generateSummarySection(results)}
    ${this.generateRecommendations(results)}
    ${this.generateFooter(branding, auditId)}
  </section>
</body>
</html>
    `.trim();
  }

  // ===== Styles =====
  private getBaseStyles(): string {
    return `
      /* Print page box */
      @page { size: A4; margin: 16mm 16mm 20mm 16mm; }

      :root {
        --primary: #2563eb;
        --secondary: #64748b;
        --accent: #0ea5e9;
        --ink: #0f172a; /* near-black */
        --muted-ink: #475569;
        --border: #e2e8f0;
        --bg-soft: #f8fafc; /* very light */
        --success: #059669; --success-100: #dcfce7;
        --warn: #d97706;   --warn-100: #fef3c7;
        --danger: #dc2626; --danger-100: #fee2e2;
      }

      /* Inter fallback stack (safe for PDF renderers) */
      body { font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, Inter, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"; }

      * { box-sizing: border-box; }
      html, body { color: var(--ink); line-height: 1.55; font-size: 12px; }

      /* Page wrapper */
      .page { position: relative; background: #fff; min-height: calc(297mm - 36mm); }
      .page-break { page-break-before: always; height: 0; }

      /* Running footer with page numbers */
      .footer { position: absolute; left: 0; right: 0; bottom: -6mm; border-top: 1px solid var(--border); padding: 6px 0; font-size: 10px; color: var(--secondary); display: flex; justify-content: space-between; align-items: center; }
      .footer .page-num:after { counter-increment: page; content: counter(page); }
      body { counter-reset: page; }

      /* Header / page title */
      .header { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 16px; padding-bottom: 10px; border-bottom: 2px solid var(--primary); margin-bottom: 18px; }
      .company-name { font-weight: 800; color: var(--primary); letter-spacing: .2px; }
      .logo { max-height: 44px; max-width: 180px; object-fit: contain; }

      /* Cover */
      .cover .hero { display: grid; grid-template-columns: 1.2fr .8fr; gap: 24px; align-items: center; }
      .cover h1 { font-size: 28px; color: var(--primary); margin: 10px 0 4px; }
      .subtitle { color: var(--secondary); margin-bottom: 18px; }
      .pill { display: inline-block; font-size: 10px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; }

      .grid { display: grid; gap: 12px; }
      .grid.cols-2 { grid-template-columns: 1fr 1fr; }
      .grid.cols-3 { grid-template-columns: repeat(3, 1fr); }
      .grid.cols-4 { grid-template-columns: repeat(4, 1fr); }

      .card { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
      .muted { color: var(--muted-ink); }

      .section + .section { margin-top: 18px; }
      .section-title { font-weight: 800; color: var(--primary); margin-bottom: 10px; font-size: 15px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }

      /* Metric styles */
      .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
      .metric { background: var(--bg-soft); border: 1px solid var(--border); border-radius: 8px; padding: 12px; text-align: center; }
      .metric .label { font-size: 10px; color: var(--secondary); margin-bottom: 3px; }
      .metric .value { font-size: 22px; font-weight: 800; margin-bottom: 3px; }
      .badge { font-size: 10px; font-weight: 700; border-radius: 4px; padding: 2px 6px; display: inline-block; border: 1px solid currentColor; }
      .b-ok { color: var(--success); background: var(--success-100); }
      .b-warn { color: var(--warn); background: var(--warn-100); }
      .b-bad { color: var(--danger); background: var(--danger-100); }

      /* Issues */
      .issues { display: grid; gap: 10px; }
      .issue { border: 1px solid var(--border); border-left-width: 3px; border-radius: 6px; padding: 10px 12px; background: #fff; break-inside: avoid; }
      .issue.error { border-left-color: var(--danger); }
      .issue.warning { border-left-color: var(--warn); }
      .issue.info { border-left-color: var(--primary); }
      .issue h4 { margin: 0 0 6px; font-size: 13px; }
      .issue .meta { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
      .chip { font-size: 10px; padding: 2px 6px; border-radius: 999px; border: 1px solid var(--border); }

      /* Web Vitals */
      .vitals { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
      .vital { border: 1px solid var(--border); border-radius: 8px; padding: 10px; background: #fff; display: grid; grid-template-columns: 56px 1fr; gap: 10px; align-items: center; }
      .vital .name { font-size: 11px; color: var(--secondary); }
      .vital .val { font-size: 18px; font-weight: 800; }
      .vital .th { font-size: 10px; color: var(--secondary); }

      /* Table of contents */
      .toc-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
      .toc-list a { color: var(--ink); text-decoration: none; display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); }
      .toc-list a:hover { background: var(--bg-soft); }

      /* Watermark */
      .watermark { position: fixed; inset: 0; pointer-events: none; opacity: .06; font-weight: 900; font-size: 120px; color: var(--ink); transform: rotate(-22deg); display: grid; place-items: center; }

      /* Print rules */
      @media print {
        .page { page-break-after: always; }
        .page:last-child { page-break-after: auto; }
      }

      /* Avoid orphans */
      h1, h2, h3, .section-title { break-after: avoid; }
      .issue, .vital, .metric, .card { break-inside: avoid; }
    `;
  }

  private getCustomStyles(primary: string, secondary: string, accent: string): string {
    return `
      :root { --primary: ${primary}; --secondary: ${secondary}; --accent: ${accent}; }
    `;
  }

  // ===== Structural generators =====
  private generateWatermark(text: string) {
    return `<div class="watermark">${this.escape(text)}</div>`;
  }

  private generateCover(branding: BrandingConfig, websiteUrl: string, completedAt: Date, auditId: string, results: AuditResults) {
    const logo = branding.logoUrl ? `<img class="logo" src="${branding.logoUrl}" alt="${branding.companyName || 'Company'} logo" />` : '';
    const overall = this.getOverallScore(results);

    return `
      <header class="header">
        <div>
          ${branding.companyName ? `<div class="company-name">${this.escape(branding.companyName)}</div>` : ''}
          ${branding.website ? `<div class="muted">${this.escape(branding.website)}</div>` : ''}
          ${branding.contactEmail ? `<div class="muted">${this.escape(branding.contactEmail)}</div>` : ''}
        </div>
        <div>${logo}</div>
      </header>

      <div class="hero">
        <div>
          <h1>SEO Audit Report</h1>
          <div class="subtitle">${this.escape(websiteUrl)}</div>
          <div class="grid cols-2">
            <div class="card"><strong>Generated</strong><br/><span class="muted">${fmtDate(completedAt)}</span></div>
            <div class="card"><strong>Audit ID</strong><br/><span class="muted">${this.escape(auditId)}</span></div>
          </div>
          <div style="margin-top: 12px;" class="pill">Powered by Meizo</div>
        </div>
        <div class="card" style="justify-self:end;">
          ${this.generateScoreRing('Overall Score', overall)}
          <div class="muted" style="margin-top:8px;">Based on ${results.pagesCrawled || 1} page${(results.pagesCrawled||1)>1?'s':''} analyzed</div>
        </div>
      </div>
    `;
  }

  private generateTOC(items: Array<[string, string]>) {
    return `
      <ul class="toc-list">
        ${items.map(([label, href]) => `<li><a href="${href}"><span>${this.escape(label)}</span><span>→</span></a></li>`).join('')}
      </ul>
    `;
  }

  private generatePageHeader(title: string, branding: BrandingConfig): string {
    return `
      <header class="header">
        <h2 style="margin:0; font-size:18px; font-weight:800; color:var(--primary);">${this.escape(title)}</h2>
        ${branding.logoUrl ? `<img class="logo" src="${branding.logoUrl}" alt="${branding.companyName || 'Company'} logo"/>` : (branding.companyName ? `<div class="company-name">${this.escape(branding.companyName)}</div>` : '')}
      </header>
    `;
  }

  // ===== Content sections =====
  private generateExecutiveSummary(results: AuditResults): string {
    const overall = this.getOverallScore(results);
    const status = this.scoreStatus(overall);

    return `
      <div class="section">
        <div class="grid cols-4 metrics">
          ${this.metricCard('Performance', results.performanceScore)}
          ${this.metricCard('SEO', results.seoScore)}
          ${this.metricCard('Accessibility', results.accessibilityScore)}
          ${this.metricCard('Best Practices', results.bestPracticesScore)}
        </div>
        <div class="card" style="margin-top:12px; display:grid; grid-template-columns: 90px 1fr; gap:12px; align-items:center;">
          ${this.generateScoreRing('Overall', overall)}
          <div>
            <div style="font-size:14px; font-weight:800;">Overall Website Score: ${overall}/100</div>
            <div class="muted">${results.issues.length > 0
              ? `We identified ${results.issues.length} issues across performance, SEO, accessibility, and best practices. Prioritize high‑impact fixes first.`
              : 'Excellent compliance across all categories.'}
            </div>
            <div style="margin-top:6px;">${this.statusBadge(status)}</div>
          </div>
        </div>
      </div>
    `;
  }

  private generateKeyMetrics(results: AuditResults): string {
    return `
      <div class="section">
        <div class="section-title">Key Performance Metrics</div>
        <div class="metrics">
          ${this.metricCard('Performance', results.performanceScore)}
          ${this.metricCard('SEO', results.seoScore)}
          ${this.metricCard('Accessibility', results.accessibilityScore)}
          ${this.metricCard('Best Practices', results.bestPracticesScore)}
        </div>
      </div>
    `;
  }

  private generateTopIssues(issues: AuditIssue[]): string {
    if (!issues?.length) {
      return `
        <div class="section">
          <div class="section-title">Top Priority Issues</div>
          <div class="card" style="text-align:center; color:var(--success); border-color:var(--success);">Excellent! No critical issues found.</div>
        </div>
      `;
    }

    return `
      <div class="section">
        <div class="section-title">Top Priority Issues</div>
        <div class="issues">
          ${issues.map((i) => this.issueCard(i)).join('')}
        </div>
      </div>
    `;
  }

  private generatePerformanceSection(results: AuditResults): string {
    const perfIssues = results.issues.filter((i) => i.category === 'PERFORMANCE');
    const score = results.performanceScore || 0;
    const tone = score >= 90 ? 'success' : score >= 70 ? 'warn' : 'danger';

    return `
      <div class="section">
        <div class="section-title">Performance Overview</div>
        <div class="card" style="border-color: var(--${tone}); background: var(--${tone}-100);">
          <strong>Performance Score:</strong> ${score}/100 — ${perfIssues.length ? `${perfIssues.length} issue${perfIssues.length>1?'s':''} impacting load and UX.` : 'Great performance with fast loads.'}
        </div>
      </div>
    `;
  }

  private generateWebVitalsSection(results: AuditResults): string {
    const m = results.metrics; const p = results.pageSpeedMetrics;
    const vitals: Array<{ name: string; value: string; status: 'ok'|'warn'|'bad'; threshold: string }>
      = [];

    const statusFor = (value: number, good: number, needs: number, lowerBetter = true): 'ok'|'warn'|'bad' => {
      const v = value;
      if (lowerBetter) return v <= good ? 'ok' : v <= needs ? 'warn' : 'bad';
      return v >= good ? 'ok' : v >= needs ? 'warn' : 'bad';
    };

    if (m?.loadTime != null) vitals.push({ name: 'Page Load Time', value: `${(m.loadTime/1000).toFixed(1)}s`, status: statusFor(m.loadTime, 2000, 4000, true), threshold: 'Good <2.0s · Needs <4.0s' });
    if (p?.largestContentfulPaint != null) vitals.push({ name: 'Largest Contentful Paint', value: `${(p.largestContentfulPaint/1000).toFixed(1)}s`, status: statusFor(p.largestContentfulPaint, 2500, 4000, true), threshold: 'Good <2.5s · Needs <4.0s' });
    if (m?.cumulativeLayoutShift != null) vitals.push({ name: 'Cumulative Layout Shift', value: m.cumulativeLayoutShift.toFixed(3), status: statusFor(m.cumulativeLayoutShift, 0.1, 0.25, true), threshold: 'Good <0.10 · Needs <0.25' });
    if (p?.firstInputDelay != null) vitals.push({ name: 'First Input Delay', value: `${p.firstInputDelay}ms`, status: statusFor(p.firstInputDelay, 100, 300, true), threshold: 'Good <100ms · Needs <300ms' });

    if (!vitals.length) {
      return `
        <div class="section">
          <div class="section-title">Core Web Vitals</div>
          <div class="card">Core Web Vitals data was not available for this audit.</div>
        </div>
      `;
    }

    const icon = (s: 'ok'|'warn'|'bad') => s === 'ok' ? 'b-ok' : s === 'warn' ? 'b-warn' : 'b-bad';

    return `
      <div class="section">
        <div class="section-title">Core Web Vitals</div>
        <div class="vitals">
          ${vitals.map(v => `
            <div class="vital">
              ${this.generateMiniRing(v.value, v.status)}
              <div>
                <div class="name">${v.name}</div>
                <div class="val">${v.value}</div>
                <div class="th"><span class="badge ${icon(v.status)}">${v.status === 'ok' ? 'Good' : v.status === 'warn' ? 'Needs improvement' : 'Poor'}</span> · ${v.threshold}</div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  private generateSEOSection(results: AuditResults): string {
    const issues = results.issues.filter(i => i.category === 'SEO');
    const score = results.seoScore || 0;
    const tone = score >= 90 ? 'success' : score >= 70 ? 'warn' : 'danger';

    return `
      <div class="section">
        <div class="section-title">SEO Overview</div>
        <div class="card" style="border-color: var(--${tone}); background: var(--${tone}-100);">
          <strong>SEO Score:</strong> ${score}/100 — ${issues.length ? `${issues.length} opportunity${issues.length>1?'ies':'y'} to improve visibility.` : 'Excellent adherence to SEO best practices.'}
        </div>
      </div>
    `;
  }

  private generateSEOIssues(issues: AuditIssue[]): string {
    if (!issues?.length) {
      return `
        <div class="section">
          <div class="section-title">SEO Analysis Details</div>
          <div class="card">No SEO issues found.</div>
        </div>
      `;
    }
    return `
      <div class="section">
        <div class="section-title">SEO Issues & Recommendations</div>
        <div class="issues">${issues.map(i => this.issueCard(i)).join('')}</div>
      </div>
    `;
  }

  private generateAccessibilitySection(results: AuditResults): string {
    const issues = results.issues.filter(i => i.category === 'ACCESSIBILITY');
    const score = results.accessibilityScore || 0;
    const tone = score >= 90 ? 'success' : score >= 70 ? 'warn' : 'danger';

    return `
      <div class="section">
        <div class="section-title">Accessibility Overview</div>
        <div class="card" style="border-color: var(--${tone}); background: var(--${tone}-100);">
          <strong>Accessibility Score:</strong> ${score}/100 — ${issues.length ? `${issues.length} improvement${issues.length>1?'s':''} to better meet WCAG.` : 'Great accessibility baseline.'}
        </div>
      </div>
    `;
  }

  private generateAccessibilityIssues(issues: AuditIssue[]): string {
    if (!issues?.length) {
      return `
        <div class="section">
          <div class="section-title">Accessibility Analysis Details</div>
          <div class="card">No accessibility issues found.</div>
        </div>
      `;
    }
    return `
      <div class="section">
        <div class="section-title">Accessibility Issues & Recommendations</div>
        <div class="issues">${issues.map(i => this.issueCard(i)).join('')}</div>
      </div>
    `;
  }

  private generateBestPracticesSection(results: AuditResults): string {
    const issues = results.issues.filter(i => i.category === 'BEST_PRACTICES');
    const score = results.bestPracticesScore || 0;
    const tone = score >= 90 ? 'success' : score >= 70 ? 'warn' : 'danger';

    return `
      <div class="section">
        <div class="section-title">Best Practices Overview</div>
        <div class="card" style="border-color: var(--${tone}); background: var(--${tone}-100);">
          <strong>Best Practices Score:</strong> ${score}/100 — ${issues.length ? `${issues.length} improvement area${issues.length>1?'s':''}.` : 'Excellent adherence to modern standards.'}
        </div>
      </div>
    `;
  }

  private generateBestPracticesIssues(issues: AuditIssue[]): string {
    if (!issues?.length) {
      return `
        <div class="section">
          <div class="section-title">Best Practices Analysis Details</div>
          <div class="card">No best practices issues found.</div>
        </div>
      `;
    }
    return `
      <div class="section">
        <div class="section-title">Best Practices Issues & Recommendations</div>
        <div class="issues">${issues.map(i => this.issueCard(i)).join('')}</div>
      </div>
    `;
  }

  private generateDetailedIssues(issues: AuditIssue[]): string {
    if (!issues?.length) {
      return `
        <div class="section">
          <div class="section-title">Detailed Issues Analysis</div>
          <div class="card">No issues found.</div>
        </div>
      `;
    }

    // Group by category
    const grouped = issues.reduce((acc: Record<string, AuditIssue[]>, i) => {
      (acc[i.category] ||= []).push(i); return acc;
    }, {} as Record<string, AuditIssue[]>);

    const categoryNames: Record<string,string> = {
      PERFORMANCE: 'Performance Issues',
      SEO: 'SEO Issues',
      ACCESSIBILITY: 'Accessibility Issues',
      BEST_PRACTICES: 'Best Practices Issues'
    };

    return `
      ${Object.entries(grouped).map(([cat, arr]) => `
        <div class="section">
          <div class="section-title">${categoryNames[cat] || cat} (${arr.length})</div>
          <div class="issues">${arr.map((i, idx) => this.issueCard(i, idx+1)).join('')}</div>
        </div>
      `).join('')}
    `;
  }

  private generateSummarySection(results: AuditResults): string {
    const total = results.issues.length;
    const hi = results.issues.filter(i => i.impact === 'HIGH').length;
    const mid = results.issues.filter(i => i.impact === 'MEDIUM').length;
    const low = results.issues.filter(i => i.impact === 'LOW').length;

    return `
      <div class="section">
        <div class="section-title">Audit Summary</div>
        <div class="grid cols-4">
          <div class="metric"><div class="value">${results.pagesCrawled || 1}</div><div class="label">Pages Analyzed</div></div>
          <div class="metric"><div class="value">${total}</div><div class="label">Total Issues</div></div>
          <div class="metric"><div class="value">${hi}</div><div class="label">High Priority</div></div>
          <div class="metric"><div class="value">${mid + low}</div><div class="label">Other Issues</div></div>
        </div>
      </div>
    `;
  }

  private generateRecommendations(results: AuditResults): string {
    const hi = results.issues.filter(i => i.impact === 'HIGH').slice(0, 4);
    const mid = results.issues.filter(i => i.impact === 'MEDIUM').slice(0, 4);

    const recCards = (arr: AuditIssue[], tone: 'danger'|'warn') => `
      <div class="grid cols-2" style="margin-top:8px;">${arr.map((i, idx) => `
        <div class="card" style="border-left:3px solid var(--${tone});">
          <div style="font-weight:800; margin-bottom:6px;">${idx+1}. ${this.escape(i.title)}</div>
          <div class="badge ${tone==='danger'?'b-bad':'b-warn'}" style="margin-bottom:6px;">${tone==='danger'?'High Impact':'Medium Impact'}</div>
          <div class="muted">${this.escape(i.recommendation)}</div>
        </div>`).join('')}</div>`;

    return `
      <div class="section">
        <div class="section-title">Priority Recommendations</div>
        ${hi.length ? `<h3 style="margin:6px 0 2px; color:var(--danger); font-size:13px;">High Priority</h3>${recCards(hi,'danger')}` : ''}
        ${mid.length ? `<h3 style="margin:12px 0 2px; color:var(--warn); font-size:13px;">Medium Priority</h3>${recCards(mid,'warn')}` : ''}
        ${!hi.length && !mid.length ? `<div class="card" style="text-align:center;">No high or medium priority recommendations. Great work!</div>` : ''}
      </div>
    `;
  }

  private generateFooter(branding: BrandingConfig, auditId: string): string {
    return `
      <footer class="footer">
        <div>${branding.companyName ? `Generated by ${this.escape(branding.companyName)} · ` : ''}Powered by Meizo</div>
        <div>Audit ID: ${this.escape(auditId)} · Page <span class="page-num"></span></div>
      </footer>
    `;
  }

  // ===== UI atoms =====
  private metricCard(label: string, score?: number) {
    const s = clamp(score ?? 0);
    const badge = s >= 90 ? 'b-ok' : s >= 70 ? 'b-warn' : 'b-bad';
    const text = s >= 90 ? 'Excellent' : s >= 70 ? 'Good' : 'Needs Improvement';
    return `<div class="metric"><div class="label">${label}</div><div class="value">${s}</div><span class="badge ${badge}">${text}</span></div>`;
  }

  private issueCard(i: AuditIssue, index?: number) {
    const type = i.type?.toLowerCase?.() || 'info';
    const impact = (i.impact || 'LOW').toLowerCase();
    const impactBadge = impact === 'high' ? 'b-bad' : impact === 'medium' ? 'b-warn' : 'b-ok';
    return `
      <div class="issue ${type}">
        <h4>${index ? `${index}. ` : ''}${this.escape(i.title)}</h4>
        <div class="meta">
          <span class="chip">${i.category}</span>
          <span class="badge ${impactBadge}">${i.impact} Impact</span>
          <span class="badge ${type==='error'?'b-bad':type==='warning'?'b-warn':'b-ok'}">${i.type}</span>
        </div>
        <div class="muted" style="margin-bottom:6px;">${this.escape(i.description)}</div>
        <div class="card" style="border-color:var(--accent); background:#f0f9ff;"> <strong>Recommendation:</strong> ${this.escape(i.recommendation)} </div>
      </div>
    `;
  }

  private scoreStatus(score: number): 'excellent'|'good'|'needs-improvement' { return score >= 90 ? 'excellent' : score >= 70 ? 'good' : 'needs-improvement'; }
  private statusBadge(s: 'excellent'|'good'|'needs-improvement') { return `<span class="badge ${s==='excellent'?'b-ok':s==='good'?'b-warn':'b-bad'}" style="font-size:11px;">${s.replace('-', ' ')}</span>`; }

  private getOverallScore(r: AuditResults) {
    const vals = [r.performanceScore, r.seoScore, r.accessibilityScore, r.bestPracticesScore].map(v => v ?? 0);
    return Math.round((vals[0] + vals[1] + vals[2] + vals[3]) / 4);
  }

  // SVG Rings (donut charts) — print‑safe, no external assets
  private generateScoreRing(label: string, scoreRaw: number) {
    const score = clamp(scoreRaw);
    const radius = 24; const c = 2 * Math.PI * radius; const dash = (score / 100) * c;
    const cls = score >= 90 ? 'b-ok' : score >= 70 ? 'b-warn' : 'b-bad';
    return `
      <div style="display:grid; justify-items:center;">
        <svg width="56" height="56" viewBox="0 0 56 56" aria-label="${label} ${score}">
          <circle cx="28" cy="28" r="${radius}" fill="none" stroke="#e5e7eb" stroke-width="6" />
          <circle cx="28" cy="28" r="${radius}" fill="none" stroke="currentColor" stroke-width="6" stroke-dasharray="${dash} ${c}" stroke-linecap="round" transform="rotate(-90 28 28)" class="${cls}" />
          <text x="50%" y="51%" dominant-baseline="middle" text-anchor="middle" font-size="12" font-weight="800" fill="#0f172a">${score}</text>
        </svg>
        <div style="font-size:10px; margin-top:4px;" class="muted">${this.escape(label)}</div>
      </div>`;
  }

  private generateMiniRing(centerLabel: string, status: 'ok'|'warn'|'bad') {
    const cls = status === 'ok' ? 'b-ok' : status === 'warn' ? 'b-warn' : 'b-bad';
    return `
      <svg width="56" height="56" viewBox="0 0 56 56" style="color:inherit;">
        <circle cx="28" cy="28" r="24" fill="#fff" stroke="#e5e7eb" stroke-width="6" />
        <circle cx="28" cy="28" r="24" fill="none" stroke="currentColor" stroke-width="6" class="${cls}" />
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-size="11" font-weight="800" fill="#0f172a">${this.escape(centerLabel)}</text>
      </svg>
    `;
  }

  // ===== Footer =====
  private escape(s: any) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'} as any)[c]); }
}
