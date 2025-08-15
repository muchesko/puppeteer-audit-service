import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../services/auditService.js';

const router = Router();
const auditService = new AuditService();

// Request validation schemas
const auditRequestSchema = z.object({
  jobId: z.string().uuid(),
  websiteUrl: z.string().url(),
  priority: z.number().min(1).max(10).optional().default(5),
  options: z.object({
    mobile: z.boolean().optional().default(false),
    includeScreenshot: z.boolean().optional().default(true),
    customUserAgent: z.string().optional()
  }).optional().default({})
});

const callbackSchema = z.object({
  jobId: z.string().uuid(),
  status: z.enum(['COMPLETED', 'FAILED']),
  results: z.object({
    performanceScore: z.number().optional(),
    seoScore: z.number().optional(),
    accessibilityScore: z.number().optional(),
    bestPracticesScore: z.number().optional(),
    issues: z.array(z.object({
      type: z.enum(['ERROR', 'WARNING', 'INFO']),
      category: z.enum(['PERFORMANCE', 'SEO', 'ACCESSIBILITY', 'BEST_PRACTICES']),
      title: z.string(),
      description: z.string(),
      impact: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      recommendation: z.string()
    })).optional(),
    metrics: z.object({
      loadTime: z.number().optional(),
      cumulativeLayoutShift: z.number().optional()
    }).optional(),
    pagesCrawled: z.number().optional(),
    screenshot: z.string().optional() // base64 encoded
  }).optional(),
  error: z.string().optional()
});

// Start audit
router.post('/start', async (req: Request, res: Response) => {
  try {
    const validatedData = auditRequestSchema.parse(req.body);
    
    console.log(`Starting audit for job ${validatedData.jobId}: ${validatedData.websiteUrl}`);
    
    // Start audit asynchronously
    auditService.processAudit(validatedData)
      .catch(error => {
        console.error(`Audit failed for job ${validatedData.jobId}:`, error);
      });
    
    res.json({ 
      success: true, 
      message: 'Audit started',
      jobId: validatedData.jobId
    });
    
  } catch (error) {
    console.error('Audit start error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Validation error', 
        details: error.errors 
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to start audit',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Get audit status
router.get('/status/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const status = await auditService.getAuditStatus(jobId);
    
    res.json({ 
      jobId,
      status: status || 'NOT_FOUND'
    });
    
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ 
      error: 'Failed to get audit status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export { router as auditRouter };
