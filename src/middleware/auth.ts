import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { config } from '../config/index.js';

export interface AuthenticatedRequest extends Request {
  isValidSignature?: boolean;
}

export const authMiddleware = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const signature = req.headers['x-signature'] as string;
  
  if (!signature) {
    return res.status(401).json({ error: 'Missing signature header' });
  }
  
  // Verify HMAC signature
  try {
    const body = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', config.apiSecretKey)
      .update(body)
      .digest('base64');
    
    if (!crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature)
    )) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    
    req.isValidSignature = true;
  } catch (error) {
    return res.status(401).json({ error: 'Invalid signature format' });
  }
  
  next();
};
