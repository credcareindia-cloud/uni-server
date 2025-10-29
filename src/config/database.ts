import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

declare global {
  var __prisma: PrismaClient | undefined;
}

// Prevent multiple instances of Prisma Client in development
const prisma = globalThis.__prisma || new PrismaClient({
  log: [
    { level: 'query', emit: 'event' },
    { level: 'error', emit: 'stdout' },
    { level: 'info', emit: 'stdout' },
    { level: 'warn', emit: 'stdout' },
  ],
});

// Log slow queries in development
if (process.env.NODE_ENV === 'development') {
  prisma.$on('query', (e) => {
    if (e.duration > 1000) { // Log queries taking more than 1 second
      logger.warn(`Slow query detected: ${e.duration}ms - ${e.query}`);
    }
  });
}

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

export { prisma };
