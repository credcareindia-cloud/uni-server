import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import fileUpload from 'express-fileupload';
import dotenv from 'dotenv';

import { authRoutes } from './routes/auth.js';
import projectRoutes from './routes/projects-simple.js';
import { modelRoutes } from './routes/models.js';
import { notificationRoutes } from './routes/notifications.js';
// import { uploadRoutes } from './routes/uploads.js';
import { modelFirstProjectRouter } from './routes/model-first-project.js';
import { uploadProcessRouter } from './routes/upload-process.js';
import { multiFileUploadRouter } from './routes/multi-file-upload.js';
import { modelDownloadRouter } from './routes/model-download.js';
import panelRoutes from './routes/panels.js';
import groupRoutes from './routes/groups.js';
import statusManagementRoutes from './routes/status-management.js';
import groupManagementRoutes from './routes/group-management.js';
import adminRoutes from './routes/admin.js';
import userRoutes from './routes/user.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';
import { startModelProcessingQueue } from './queue/index.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS configuration (supports exact origins and wildcard via regex)
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000,http://localhost:3001')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOriginPatterns = (process.env.CORS_ORIGIN_REGEX || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean)
  .map((p) => {
    try {
      return new RegExp(p);
    } catch {
      logger.warn(`Invalid CORS origin regex skipped: ${p}`);
      return null;
    }
  })
  .filter((v): v is RegExp => v !== null);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (allowedOriginPatterns.some((re) => re.test(origin))) return callback(null, true);
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

// Rate limiting - skip health checks and upload endpoints
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000, // limit each IP to 5000 requests per 15 minutes
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    return req.path === '/health' || 
           req.path.startsWith('/api/upload') || 
           req.path.includes('multi-file-upload') ||
           req.path.includes('model-upload');
  }
});
app.use(limiter);

// Body parsing middleware
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// File upload middleware - Use temp files for large IFC files (900MB+)
app.use(fileUpload({
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB max file size
  useTempFiles: true, // Use temp files instead of memory for large files
  tempFileDir: '/tmp/', // Temporary directory for uploads
  createParentPath: true,
  abortOnLimit: true,
  responseOnLimit: 'File size limit exceeded',
  debug: false
}));

// Logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } }));
}

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/models', modelRoutes);
app.use('/api/notifications', notificationRoutes);
// app.use('/api/uploads', uploadRoutes);
app.use('/api/panels', panelRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/status-management', statusManagementRoutes);
app.use('/api/group-management', groupManagementRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);
app.use('/api', modelFirstProjectRouter);
app.use('/api', uploadProcessRouter);
app.use('/api', multiFileUploadRouter);
// app.use('/api', metadataUpdateRouter);
app.use('/api', modelDownloadRouter);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Not Found',
    message: `Route ${req.originalUrl} not found`,
    timestamp: new Date().toISOString()
  });
});

// Global error handler
app.use(errorHandler);

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

// Start server
const server = app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`📊 Health check: http://${process.env.CORS_ORIGIN}?:${PORT}/health`);
  logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  // Start background workers queue
  startModelProcessingQueue();
});

// Increase timeouts for large file uploads
server.setTimeout(30 * 60 * 1000); // 30 minutes for socket timeout
server.headersTimeout = 35 * 60 * 1000; // 35 minutes for headers timeout
server.requestTimeout = 30 * 60 * 1000; // 30 minutes for request timeout

export default app;
