import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'puppeteer-service',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

router.get('/ready', async (req, res) => {
  try {
    // Add any readiness checks here (DB connections, etc.)
    res.json({ 
      status: 'ready',
      service: 'puppeteer-service'
    });
  } catch (error) {
    res.status(503).json({ 
      status: 'not ready',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export { router as healthRouter };
