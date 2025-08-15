import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as crypto from 'crypto';
import { AuditService } from '../services/auditService.js';

const router = Router();
const auditService = new AuditService();

// Request validation schemas
const auditRequestSchema = z.object({
  url: z.string().url(),
  priority: z.number().min(1).max(10).optional().default(5),
  options: z.object({
    mobile: z.boolean().optional().default(false),
    desktop: z.boolean().optional().default(true),
    screenshot: z.boolean().optional().default(true)
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
    const jobId = crypto.randomUUID();
    
    console.log(`Starting audit for job ${jobId}: ${validatedData.url}`);
    
    // Start audit asynchronously
    auditService.startAudit({
      jobId,
      websiteUrl: validatedData.url,
      priority: validatedData.priority,
      options: validatedData.options
    })
      .catch((error: Error) => {
        console.error(`Audit failed for job ${jobId}:`, error);
      });
    
    res.status(202).json({ 
      message: 'Audit started successfully',
      jobId: jobId
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
