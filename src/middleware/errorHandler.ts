import { Request, Response, NextFunction } from 'express';

export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  
  // Default error
  let status = 500;
  let message = 'Internal server error';
  
  // Handle specific error types
  if (err.name === 'ValidationError') {
    status = 400;
    message = err.message;
  } else if (err.name === 'TimeoutError') {
    status = 408;
    message = 'Request timeout';
  } else if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')) {
    status = 400;
    message = 'Unable to reach the specified URL';
  }
  
  res.status(status).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};
