import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config/index.js';

export interface AuthenticatedRequest extends Request {
  isValidSignature?: boolean;
}

export const authMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const apiKey = req.headers['x-api-key'];
  const signature = req.headers['x-signature'] as string;
  
  // Check API key
  if (apiKey !== config.apiKey) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  
  // Verify HMAC signature for webhook callbacks
  if (req.path.includes('/callback') && signature) {
    const body = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', config.webhookSecret)
      .update(body)
      .digest('hex');
    
    const providedSignature = signature.replace('sha256=', '');
    
    if (!crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(providedSignature, 'hex')
    )) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    req.isValidSignature = true;
  }
  
  next();
};
