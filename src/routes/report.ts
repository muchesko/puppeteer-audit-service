import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as crypto from 'crypto';
import { PDFService } from '../services/pdfService.js';
import { HTMLTemplateService, type ReportData } from '../services/htmlTemplateService.js';
import type { AuditResults } from '../types/audit.js';

const router = Router();
const pdfService = new PDFService();
const htmlTemplateService = new HTMLTemplateService();

// Request validation schema for audit report generation
const auditReportRequestSchema = z.object({
  auditId: z.string().min(1),
  websiteUrl: z.string().url(),
  completedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  results: z.object({
    performanceScore: z.number().min(0).max(100),
    seoScore: z.number().min(0).max(100),
    accessibilityScore: z.number().min(0).max(100),
    bestPracticesScore: z.number().min(0).max(100),
    issues: z.array(z.object({
      type: z.enum(['ERROR', 'WARNING', 'INFO']),
      category: z.enum(['PERFORMANCE', 'SEO', 'ACCESSIBILITY', 'BEST_PRACTICES']),
      title: z.string(),
      description: z.string(),
      impact: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      element: z.string().optional(),
      recommendation: z.string()
    })),
    metrics: z.object({
      loadTime: z.number(),
      cumulativeLayoutShift: z.number()
    }),
    pageSpeedMetrics: z.object({
      performanceScore: z.number(),
      firstContentfulPaint: z.number(),
      largestContentfulPaint: z.number(),
      firstInputDelay: z.number(),
      cumulativeLayoutShift: z.number(),
      speedIndex: z.number(),
      totalBlockingTime: z.number()
    }).optional(),
    pagesCrawled: z.number(),
    screenshots: z.array(z.string()).optional()
  }),
  branding: z.object({
    companyName: z.string().optional(),
    logoUrl: z.string().url().optional(),
    primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    website: z.string().optional(),
    contactEmail: z.string().email().optional()
  }).optional().default({}),
  options: z.object({
    format: z.enum(['A4', 'Letter']).optional().default('A4'),
    orientation: z.enum(['portrait', 'landscape']).optional().default('portrait'),
    margin: z.object({
      top: z.string().optional().default('1cm'),
      right: z.string().optional().default('1cm'),
      bottom: z.string().optional().default('1cm'),
      left: z.string().optional().default('1cm')
    }).optional().default({}),
    displayHeaderFooter: z.boolean().optional().default(false),
    headerTemplate: z.string().optional(),
    footerTemplate: z.string().optional(),
    printBackground: z.boolean().optional().default(true),
    scale: z.number().min(0.1).max(2).optional().default(1)
  }).optional().default({})
});

// Generate PDF report from audit data
router.post('/generate-audit-report', async (req: Request, res: Response) => {
  try {
    const validatedData = auditReportRequestSchema.parse(req.body);
    const jobId = crypto.randomUUID();
    
    console.log(`Generating audit report PDF for job ${jobId}`);
    
    // Prepare report data
    const reportData: ReportData = {
      auditId: validatedData.auditId,
      websiteUrl: validatedData.websiteUrl,
      completedAt: new Date(validatedData.completedAt),
      createdAt: new Date(validatedData.createdAt),
      results: validatedData.results as AuditResults,
      branding: validatedData.branding
    };
    
    // Generate HTML from template
    console.log(`Generating HTML template for audit ${validatedData.auditId}`);
    const htmlContent = htmlTemplateService.generateHTMLReport(reportData);
    
    // Generate PDF from HTML
    console.log(`Converting HTML to PDF for job ${jobId}`);
    const pdfBuffer = await pdfService.generatePDF({
      jobId,
      htmlContent,
      options: validatedData.options
    });
    
    // Set appropriate headers for PDF download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="audit-report-${validatedData.auditId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length.toString());
    
    console.log(`PDF generated successfully for job ${jobId}, size: ${pdfBuffer.length} bytes`);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('Audit report PDF generation error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Validation error', 
        details: error.errors 
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to generate audit report PDF',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Generate a sample report with mock data (for testing)
router.post('/generate-sample-report', async (req: Request, res: Response) => {
  try {
    const jobId = crypto.randomUUID();
    
    console.log(`Generating sample audit report PDF for job ${jobId}`);
    
    // Mock audit data for demonstration
    const mockReportData: ReportData = {
      auditId: 'sample-audit-123',
      websiteUrl: 'https://example.com',
      completedAt: new Date(),
      createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
      results: {
        performanceScore: 85,
        seoScore: 92,
        accessibilityScore: 78,
        bestPracticesScore: 88,
        issues: [
          {
            type: 'WARNING',
            category: 'PERFORMANCE',
            title: 'Large images detected',
            description: 'Some images could be optimized to reduce file size and improve loading times.',
            impact: 'MEDIUM',
            recommendation: 'Compress images using modern formats like WebP and implement responsive image loading.'
          },
          {
            type: 'ERROR',
            category: 'SEO',
            title: 'Missing meta description',
            description: 'The page is missing a meta description tag.',
            impact: 'HIGH',
            recommendation: 'Add a compelling meta description between 150-160 characters to improve search result click-through rates.'
          },
          {
            type: 'WARNING',
            category: 'ACCESSIBILITY',
            title: 'Low color contrast',
            description: 'Some text elements have insufficient color contrast ratios.',
            impact: 'MEDIUM',
            recommendation: 'Ensure all text has a contrast ratio of at least 4.5:1 for normal text and 3:1 for large text.'
          },
          {
            type: 'INFO',
            category: 'BEST_PRACTICES',
            title: 'HTTP/2 not enabled',
            description: 'The server is not using HTTP/2 protocol.',
            impact: 'LOW',
            recommendation: 'Enable HTTP/2 on your server to improve loading performance for multiple resources.'
          }
        ],
        metrics: {
          loadTime: 2340,
          cumulativeLayoutShift: 0.05
        },
        pageSpeedMetrics: {
          performanceScore: 85,
          firstContentfulPaint: 1200,
          largestContentfulPaint: 2100,
          firstInputDelay: 45,
          cumulativeLayoutShift: 0.05,
          speedIndex: 1800,
          totalBlockingTime: 150
        },
        pagesCrawled: 25
      },
      branding: {
        companyName: 'Acme Digital Agency',
        primaryColor: '#2563eb',
        secondaryColor: '#64748b',
        website: 'https://acme-digital.com',
        contactEmail: 'hello@acme-digital.com'
      }
    };
    
    // Generate HTML from template
    console.log(`Generating HTML template for sample report`);
    const htmlContent = htmlTemplateService.generateHTMLReport(mockReportData);
    
    // Generate PDF from HTML
    console.log(`Converting HTML to PDF for job ${jobId}`);
    const pdfBuffer = await pdfService.generatePDF({
      jobId,
      htmlContent,
      options: {
        format: 'A4',
        orientation: 'portrait',
        printBackground: true,
        displayHeaderFooter: false
      }
    });
    
    // Set appropriate headers for PDF download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sample-audit-report.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length.toString());
    
    console.log(`Sample PDF generated successfully for job ${jobId}, size: ${pdfBuffer.length} bytes`);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('Sample report PDF generation error:', error);
    
    res.status(500).json({ 
      error: 'Failed to generate sample audit report PDF',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export { router as reportRouter };
