// routes/preview.ts - Live PDF Preview Routes
import { Router, Request, Response } from 'express';
import { PDFService } from '../services/pdfService.js';
import { HTMLTemplateService } from '../services/htmlTemplateService.js';
import { authMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();
const pdfService = new PDFService();
const htmlTemplateService = new HTMLTemplateService();

/**
 * Live PDF Preview - Returns PDF for inline viewing
 */
router.post('/pdf-preview', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { auditData } = req.body;
    
    if (!auditData) {
      return res.status(400).json({ error: 'Missing auditData in request body' });
    }

    console.log('🔍 Generating PDF preview for:', auditData.websiteUrl);

    // Generate PDF
    const pdfBuffer = await pdfService.generatePDF(auditData);
    
    // Set headers to display PDF inline in browser
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="audit-preview.pdf"');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    
    res.send(pdfBuffer);
  } catch (error) {
    console.error('❌ PDF preview generation failed:', error);
    res.status(500).json({ 
      error: 'PDF preview generation failed', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

/**
 * HTML Preview - Returns raw HTML for debugging
 */
router.post('/html-preview', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { auditData } = req.body;
    
    if (!auditData) {
      return res.status(400).json({ error: 'Missing auditData in request body' });
    }

    console.log('🌐 Generating HTML preview for:', auditData.websiteUrl);

    // Generate HTML template
    const html = htmlTemplateService.generateHTMLReport(auditData);
    
    // Return raw HTML for browser preview
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);
  } catch (error) {
    console.error('❌ HTML preview generation failed:', error);
    res.status(500).json({ 
      error: 'HTML preview generation failed', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

/**
 * Preview Dashboard - Simple UI for testing (no auth required)
 */
router.get('/dashboard', (req: Request, res: Response) => {
  const dashboardHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PDF Preview Dashboard</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #f8fafc;
            color: #334155;
            line-height: 1.6;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem;
        }
        
        .header {
            text-align: center;
            margin-bottom: 3rem;
        }
        
        .header h1 {
            color: #1e293b;
            font-size: 2.5rem;
            margin-bottom: 0.5rem;
        }
        
        .header p {
            color: #64748b;
            font-size: 1.1rem;
        }
        
        .preview-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 2rem;
            margin-bottom: 2rem;
        }
        
        .preview-card {
            background: white;
            border-radius: 12px;
            box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
            padding: 2rem;
            border: 1px solid #e2e8f0;
        }
        
        .preview-card h2 {
            color: #1e293b;
            font-size: 1.5rem;
            margin-bottom: 1rem;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        .preview-card .icon {
            font-size: 1.5rem;
        }
        
        .preview-card p {
            color: #64748b;
            margin-bottom: 1.5rem;
        }
        
        .btn {
            display: inline-flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.75rem 1.5rem;
            background: #3b82f6;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 500;
            transition: all 0.2s;
            border: none;
            cursor: pointer;
            font-size: 1rem;
        }
        
        .btn:hover {
            background: #2563eb;
            transform: translateY(-1px);
        }
        
        .btn-secondary {
            background: #6366f1;
        }
        
        .btn-secondary:hover {
            background: #4f46e5;
        }
        
        .controls {
            background: white;
            border-radius: 12px;
            box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);
            padding: 2rem;
            border: 1px solid #e2e8f0;
        }
        
        .controls h3 {
            color: #1e293b;
            margin-bottom: 1rem;
        }
        
        .form-group {
            margin-bottom: 1rem;
        }
        
        .form-group label {
            display: block;
            font-weight: 500;
            margin-bottom: 0.5rem;
            color: #374151;
        }
        
        .form-group input, .form-group select {
            width: 100%;
            padding: 0.75rem;
            border: 1px solid #d1d5db;
            border-radius: 6px;
            font-size: 1rem;
        }
        
        .form-group input:focus, .form-group select:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 3px rgb(59 130 246 / 0.1);
        }
        
        #previewFrame {
            width: 100%;
            height: 80vh;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            background: white;
        }
        
        .status {
            margin-top: 1rem;
            padding: 1rem;
            border-radius: 6px;
            display: none;
        }
        
        .status.success {
            background: #ecfdf5;
            border: 1px solid #a7f3d0;
            color: #065f46;
        }
        
        .status.error {
            background: #fef2f2;
            border: 1px solid #fecaca;
            color: #991b1b;
        }
        
        @media (max-width: 768px) {
            .preview-grid {
                grid-template-columns: 1fr;
            }
            
            .container {
                padding: 1rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎨 PDF Preview Dashboard</h1>
            <p>Live preview your PDF reports without downloading</p>
        </div>
        
        <div class="preview-grid">
            <div class="preview-card">
                <h2><span class="icon">📄</span> PDF Preview</h2>
                <p>Generate and view the PDF report directly in your browser</p>
                <button class="btn" onclick="generatePDFPreview()">
                    <span>🔍</span> Preview PDF
                </button>
            </div>
            
            <div class="preview-card">
                <h2><span class="icon">🌐</span> HTML Preview</h2>
                <p>View the raw HTML template for debugging styling</p>
                <button class="btn btn-secondary" onclick="generateHTMLPreview()">
                    <span>👁️</span> Preview HTML
                </button>
            </div>
        </div>
        
        <div class="controls">
            <h3>🎛️ Quick Settings</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
                <div class="form-group">
                    <label for="websiteUrl">Website URL</label>
                    <input type="url" id="websiteUrl" value="https://example-client.com" placeholder="https://example.com">
                </div>
                <div class="form-group">
                    <label for="companyName">Agency Name</label>
                    <input type="text" id="companyName" value="Dev Agency" placeholder="Your Agency Name">
                </div>
                <div class="form-group">
                    <label for="primaryColor">Primary Color</label>
                    <input type="color" id="primaryColor" value="#3b82f6">
                </div>
                <div class="form-group">
                    <label for="performanceScore">Performance Score</label>
                    <input type="number" id="performanceScore" value="78" min="0" max="100">
                </div>
            </div>
        </div>
        
        <div style="margin-top: 2rem;">
            <iframe id="previewFrame" src="about:blank"></iframe>
        </div>
        
        <div id="status" class="status"></div>
    </div>
    
    <script>
        function showStatus(message, type = 'success') {
            const status = document.getElementById('status');
            status.textContent = message;
            status.className = \`status \${type}\`;
            status.style.display = 'block';
            
            if (type === 'success') {
                setTimeout(() => {
                    status.style.display = 'none';
                }, 3000);
            }
        }
        
        function getAuditData() {
            return {
                auditId: 'preview-' + Date.now(),
                websiteUrl: document.getElementById('websiteUrl').value,
                completedAt: new Date().toISOString(),
                createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
                results: {
                    performanceScore: parseInt(document.getElementById('performanceScore').value),
                    seoScore: 85,
                    accessibilityScore: 92,
                    bestPracticesScore: 88,
                    issues: [
                        {
                            type: 'ERROR',
                            category: 'PERFORMANCE',
                            title: 'Large images slowing page load',
                            description: 'Multiple large images are not optimized, causing significant delays in page loading times.',
                            impact: 'HIGH',
                            recommendation: 'Compress images to WebP format and implement lazy loading for images below the fold.'
                        },
                        {
                            type: 'WARNING',
                            category: 'SEO',
                            title: 'Missing meta descriptions',
                            description: 'Several important pages are missing meta descriptions, reducing search engine visibility.',
                            impact: 'MEDIUM',
                            recommendation: 'Add unique, compelling meta descriptions (150-160 characters) for all key pages.'
                        },
                        {
                            type: 'ERROR',
                            category: 'ACCESSIBILITY',
                            title: 'Images missing alt text',
                            description: 'Multiple images lack alternative text, affecting users with screen readers.',
                            impact: 'HIGH',
                            recommendation: 'Add descriptive alt text to all images. Use empty alt="" for decorative images.'
                        },
                        {
                            type: 'INFO',
                            category: 'BEST_PRACTICES',
                            title: 'HTTP resources on HTTPS pages',
                            description: 'Some resources are loaded over HTTP instead of HTTPS, triggering security warnings.',
                            impact: 'LOW',
                            recommendation: 'Update all resource URLs to use HTTPS protocol for better security.'
                        },
                        {
                            type: 'WARNING',
                            category: 'PERFORMANCE',
                            title: 'Render-blocking JavaScript',
                            description: 'JavaScript files are blocking initial page render, delaying content visibility.',
                            impact: 'MEDIUM',
                            recommendation: 'Defer non-critical JavaScript and use async loading for third-party scripts.'
                        },
                        {
                            type: 'ERROR',
                            category: 'SEO',
                            title: 'Duplicate title tags',
                            description: 'Multiple pages share identical title tags, confusing search engines.',
                            impact: 'HIGH',
                            recommendation: 'Create unique, descriptive title tags for each page with relevant keywords.'
                        },
                        {
                            type: 'WARNING',
                            category: 'ACCESSIBILITY',
                            title: 'Low color contrast',
                            description: 'Some text elements have insufficient color contrast ratios.',
                            impact: 'MEDIUM',
                            recommendation: 'Increase color contrast to meet WCAG AA standards (4.5:1 for normal text).'
                        },
                        {
                            type: 'INFO',
                            category: 'BEST_PRACTICES',
                            title: 'Missing security headers',
                            description: 'Important security headers like CSP and X-Frame-Options are not implemented.',
                            impact: 'LOW',
                            recommendation: 'Implement Content Security Policy and other security headers for better protection.'
                        }
                    ],
                    metrics: {
                        loadTime: 2850,
                        cumulativeLayoutShift: 0.08,
                        timeToInteractive: 3400,
                        firstMeaningfulPaint: 2100
                    },
                    pageSpeedMetrics: {
                        performanceScore: parseInt(document.getElementById('performanceScore').value),
                        firstContentfulPaint: 1350,
                        largestContentfulPaint: 2850,
                        firstInputDelay: 65,
                        cumulativeLayoutShift: 0.08,
                        speedIndex: 2200,
                        totalBlockingTime: 180
                    },
                    pagesCrawled: 8
                },
                branding: {
                    companyName: document.getElementById('companyName').value,
                    primaryColor: document.getElementById('primaryColor').value,
                    secondaryColor: '#64748b',
                    website: 'https://devagency.com',
                    contactEmail: 'contact@devagency.com'
                },
                options: {
                    format: 'A4',
                    orientation: 'portrait',
                    printBackground: true
                }
            };
        }
        
        async function generatePDFPreview() {
            showStatus('🔄 Generating PDF preview...', 'success');
            
            try {
                const auditData = getAuditData();
                
                const response = await fetch('/api/preview/pdf-preview', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-signature': 'sha256=' + await createSignature(JSON.stringify({ auditData }))
                    },
                    body: JSON.stringify({ auditData })
                });
                
                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error || 'Failed to generate PDF');
                }
                
                const blob = await response.blob();
                const url = URL.createObjectURL(blob);
                
                document.getElementById('previewFrame').src = url;
                showStatus('✅ PDF preview generated successfully!', 'success');
                
            } catch (error) {
                console.error('PDF preview error:', error);
                showStatus('❌ Failed to generate PDF: ' + error.message, 'error');
            }
        }
        
        async function generateHTMLPreview() {
            showStatus('🔄 Generating HTML preview...', 'success');
            
            try {
                const auditData = getAuditData();
                
                const response = await fetch('/api/preview/html-preview', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-signature': 'sha256=' + await createSignature(JSON.stringify({ auditData }))
                    },
                    body: JSON.stringify({ auditData })
                });
                
                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.error || 'Failed to generate HTML');
                }
                
                const html = await response.text();
                const blob = new Blob([html], { type: 'text/html' });
                const url = URL.createObjectURL(blob);
                
                document.getElementById('previewFrame').src = url;
                showStatus('✅ HTML preview generated successfully!', 'success');
                
            } catch (error) {
                console.error('HTML preview error:', error);
                showStatus('❌ Failed to generate HTML: ' + error.message, 'error');
            }
        }
        
        // Simple signature creation for demo (matches audit client)
        async function createSignature(body) {
            const encoder = new TextEncoder();
            const key = await crypto.subtle.importKey(
                'raw',
                encoder.encode('local-dev-api-key-67890'), // API key from .env
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign']
            );
            
            const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
            return Array.from(new Uint8Array(signature))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        }
        
        // Auto-generate initial preview
        window.addEventListener('load', () => {
            setTimeout(generatePDFPreview, 1000);
        });
    </script>
</body>
</html>`;

  res.send(dashboardHTML);
});

export default router;
