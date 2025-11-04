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
import { modelDownloadRouter } from './routes/model-download.js';
import panelRoutes from './routes/panels.js';
import groupRoutes from './routes/groups.js';
import statusManagementRoutes from './routes/status-management.js';
import groupManagementRoutes from './routes/group-management.js';
import adminRoutes from './routes/admin.js';
import userRoutes from './routes/user.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}));

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
app.listen(PORT, () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  logger.info(`📊 Health check: http://localhost:${PORT}/health`);
  logger.info(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
