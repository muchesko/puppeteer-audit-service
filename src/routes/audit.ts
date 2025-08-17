import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as crypto from 'crypto';
import { AuditService } from '../services/auditService.js';

const router = Router();
const auditService = new AuditService();

// Request validation schemas
const auditRequestSchema = z.object({
  // Allow the client (Meizo app) to provide the jobId so both systems share the same ID
  jobId: z.string().uuid().optional(),
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
  const startTime = Date.now();
  let jobId: string | undefined;
  
  try {
    console.log('[route] validating audit request');
    const validatedData = auditRequestSchema.parse(req.body);
    
    // Use provided jobId when present so the caller can track status by the same ID
    jobId = validatedData.jobId || crypto.randomUUID();
    
    console.log(`[route] starting audit for job ${jobId}: ${validatedData.url}`);
    
    // Add request timeout protection
    const requestTimeout = 5_000; // 5 seconds for route handler
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Route handler timeout')), requestTimeout);
    });
    
    // Start audit asynchronously with timeout protection
    const auditPromise = auditService.startAudit({
      jobId,
      websiteUrl: validatedData.url,
      priority: validatedData.priority,
      // Normalize option name: router uses `screenshot`, service expects `includeScreenshot`
      options: {
        mobile: validatedData.options?.mobile,
        customUserAgent: undefined,
        includeScreenshot: validatedData.options?.screenshot
      }
    }).catch((error: Error) => {
      console.error(`[route] audit failed for job ${jobId}:`, error);
      // Don't throw here - we want the route to return 202 even if audit fails
    });
    
    // Race the audit start against timeout
    await Promise.race([auditPromise, timeoutPromise]);
    
    const duration = Date.now() - startTime;
    console.log(`[route] audit ${jobId} queued successfully in ${duration}ms`);
    
    res.status(202).json({ 
      message: 'Audit started successfully',
      jobId: jobId,
      estimatedCompletion: '2-3 minutes'
    });
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[route] audit start error for job ${jobId} after ${duration}ms:`, error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Validation error', 
        details: error.errors 
      });
    }
    
    if (error instanceof Error && error.message === 'Route handler timeout') {
      return res.status(202).json({
        message: 'Audit queued (may take longer due to resource constraints)',
        jobId: jobId || 'unknown',
        warning: 'Initial processing timed out but audit may still complete'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to start audit',
      message: error instanceof Error ? error.message : 'Unknown error',
      jobId: jobId || 'unknown'
    });
  }
});

// Get audit status
router.get('/status/:jobId', async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    const { jobId } = req.params;
    console.log(`[route] checking status for job ${jobId}`);
    
    if (!jobId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) {
      return res.status(400).json({
        error: 'Invalid job ID format',
        jobId
      });
    }
    
    // Add timeout protection for status checks
    const statusTimeout = 3_000; // 3 seconds
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Status check timeout')), statusTimeout);
    });
    
    const [status, details] = await Promise.race([
      Promise.all([
        auditService.getAuditStatus(jobId),
        auditService.getAuditDetails(jobId)
      ]),
      timeoutPromise
    ]);
    
    const duration = Date.now() - startTime;
    console.log(`[route] status check for ${jobId} completed in ${duration}ms: ${status || 'NOT_FOUND'}`);
    
    res.json({ 
      jobId,
      status: status || 'NOT_FOUND',
      results: details?.results,
      error: details?.error,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[route] status check error after ${duration}ms:`, error);
    
    if (error instanceof Error && error.message === 'Status check timeout') {
      return res.status(408).json({
        error: 'Status check timed out',
        jobId: req.params.jobId,
        message: 'Service may be under heavy load'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to get audit status',
      message: error instanceof Error ? error.message : 'Unknown error',
      jobId: req.params.jobId
    });
  }
});

export { router as auditRouter };
