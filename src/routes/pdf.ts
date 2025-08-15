import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as crypto from 'crypto';
import { PDFService } from '../services/pdfService.js';

const router = Router();
const pdfService = new PDFService();

// Request validation schemas
const pdfRequestSchema = z.object({
  html: z.string().min(1),
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

// Generate PDF
router.post('/generate', async (req: Request, res: Response) => {
  try {
    const validatedData = pdfRequestSchema.parse(req.body);
    const jobId = crypto.randomUUID();
    
    console.log(`Generating PDF for job ${jobId}`);
    
    const pdfBuffer = await pdfService.generatePDF({
      jobId,
      htmlContent: validatedData.html,
      options: validatedData.options
    });
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="report-${jobId}.pdf"`);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('PDF generation error:', error);
    
    if (error instanceof z.ZodError) {
      return res.status(400).json({ 
        error: 'Validation error', 
        details: error.errors 
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to generate PDF',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Generate PDF from URL (for quick reports)
router.post('/generate-from-url', async (req: Request, res: Response) => {
  try {
    const { url, options } = req.body;
    
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required' });
    }
    
    console.log(`Generating PDF from URL: ${url}`);
    
    const pdfBuffer = await pdfService.generatePDFFromURL(url, options);
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="website-${Date.now()}.pdf"`);
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('PDF from URL generation error:', error);
    
    res.status(500).json({ 
      error: 'Failed to generate PDF from URL',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export { router as pdfRouter };
