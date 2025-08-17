import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { auditRouter } from './routes/audit.js';
import { pdfRouter } from './routes/pdf.js';
import { healthRouter } from './routes/health.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authMiddleware } from './middleware/auth.js';

const app = express();

// Trust proxy - Required for Koyeb and other cloud platforms
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://your-domain.com'] 
    : true,
  credentials: true
}));

// Rate limiting - with proper proxy support and skip handling
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // Skip function to handle proxy detection failures gracefully
  skip: (req) => {
    // If we can't determine the real IP, allow the request
    if (!req.ip || req.ip === '::1' || req.ip === '127.0.0.1') {
      console.warn(`[rate-limit] unable to determine real IP for request, allowing: ${req.ip}`);
      return true;
    }
    return false;
  },
  // Custom key generator that handles proxy edge cases
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    const realIp = req.headers['x-real-ip'];
    const ip = req.ip;
    
    // Try to get the most reliable IP address
    let clientIp = ip;
    if (typeof forwarded === 'string' && forwarded) {
      clientIp = forwarded.split(',')[0].trim();
    } else if (typeof realIp === 'string' && realIp) {
      clientIp = realIp;
    }
    
    return clientIp || 'unknown';
  }
});
app.use(limiter);

// Body parsing and compression
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Logging
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Health check (no auth required)
app.use('/health', healthRouter);

// Protected routes
app.use('/api/audit', authMiddleware, auditRouter);
app.use('/api/pdf', authMiddleware, pdfRouter);

// Error handling
app.use(errorHandler);

// Start server
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`🚀 Puppeteer service running on port ${PORT}`);
  console.log(`📊 Max concurrent jobs: ${config.maxConcurrentJobs}`);
  console.log(`⏱️  Request timeout: ${config.requestTimeout}ms`);
});

export default app;
