import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

declare global {
  var __prisma: PrismaClient | undefined;
}

// Production-ready Prisma Client with connection pooling and timeouts
const prisma = globalThis.__prisma || new PrismaClient({
  log: [
    { level: 'query', emit: 'event' },
    { level: 'error', emit: 'stdout' },
    { level: 'info', emit: 'stdout' },
    { level: 'warn', emit: 'stdout' },
  ],
  // Connection pool configuration for production stability
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

// Log slow queries (both dev and production)
prisma.$on('query' as any, (e: any) => {
  const threshold = process.env.NODE_ENV === 'production' ? 5000 : 1000;
  if (e.duration > threshold) {
    logger.warn(`Slow query detected: ${e.duration}ms - ${e.query}`);
  }
});

// Prevent multiple instances in development
if (process.env.NODE_ENV === 'development') {
  globalThis.__prisma = prisma;
}

// Connection test
export async function connectDatabase() {
  try {
    await prisma.$connect();
    logger.info('✅ Database connected successfully');
    return true;
  } catch (error) {
    logger.error('❌ Database connection failed:', error);
    return false;
  }
}

// Graceful disconnect
export async function disconnectDatabase() {
  try {
    await prisma.$disconnect();
    logger.info('📴 Database disconnected');
  } catch (error) {
    logger.error('Error disconnecting from database:', error);
  }
}

// Handle process termination to prevent segmentation faults
let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) {
    logger.warn(`Already shutting down, ignoring ${signal}`);
    return;
  }

  isShuttingDown = true;
  logger.info(`${signal} received, disconnecting database...`);

  try {
    await prisma.$disconnect();
    logger.info('✅ Database disconnected successfully');
    process.exit(0);
  } catch (error) {
    logger.error('❌ Error during database shutdown:', error);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('beforeExit', () => {
  if (!isShuttingDown) {
    logger.info('Process exiting, disconnecting database...');
    prisma.$disconnect().catch((err) => logger.error('Error on beforeExit:', err));
  }
});

// Handle uncaught errors that could cause segmentation faults
process.on('uncaughtException', (error) => {
  logger.error('❌ UNCAUGHT EXCEPTION - This could cause segmentation fault:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('❌ UNHANDLED REJECTION at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejection, just log it
});

export { prisma };
