import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger.js';

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
}

/**
 * Global error handler middleware
 */
export function errorHandler(
  error: ApiError | ZodError | Prisma.PrismaClientKnownRequestError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logger.error('Error occurred:', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });

  // Zod validation errors
  if (error instanceof ZodError) {
    res.status(400).json({
      error: 'Validation Error',
      message: 'Invalid request data',
      details: error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message,
        code: err.code
      })),
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Prisma errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002':
        res.status(409).json({
          error: 'Conflict',
          message: 'A record with this data already exists',
          field: error.meta?.target,
          timestamp: new Date().toISOString()
        });
        return;

      case 'P2025':
        res.status(404).json({
          error: 'Not Found',
          message: 'The requested record was not found',
          timestamp: new Date().toISOString()
        });
        return;

      case 'P2003':
        res.status(400).json({
          error: 'Foreign Key Constraint',
          message: 'Referenced record does not exist',
          timestamp: new Date().toISOString()
        });
        return;

      default:
        res.status(500).json({
          error: 'Database Error',
          message: 'An error occurred while processing your request',
          code: error.code,
          timestamp: new Date().toISOString()
        });
        return;
    }
  }

  // Custom API errors
  if (error.statusCode) {
    res.status(error.statusCode).json({
      error: error.name || 'API Error',
      message: error.message,
      code: error.code,
      timestamp: new Date().toISOString()
    });
    return;
  }

  // JWT errors
  if (error.name === 'JsonWebTokenError') {
    res.status(401).json({
      error: 'Authentication Error',
      message: 'Invalid token',
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (error.name === 'TokenExpiredError') {
    res.status(401).json({
      error: 'Authentication Error',
      message: 'Token expired',
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Multer errors (file upload)
  if (error.name === 'MulterError') {
    let message = 'File upload error';
    let statusCode = 400;

    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        message = 'File too large';
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Too many files';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = 'Unexpected file field';
        break;
    }

    res.status(statusCode).json({
      error: 'Upload Error',
      message,
      timestamp: new Date().toISOString()
    });
    return;
  }

  // Default server error
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' 
      ? 'An unexpected error occurred' 
      : error.message,
    timestamp: new Date().toISOString()
  });
}

/**
 * Create a custom API error
 */
export function createApiError(message: string, statusCode = 500, code?: string): ApiError {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.code = code || 'SERVER_ERROR';
  return error;
}

/**
 * Async error wrapper for route handlers
 */
export function asyncHandler(fn: Function) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
