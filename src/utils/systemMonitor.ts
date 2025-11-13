import os from 'node:os';
import { logger } from './logger.js';

export interface SystemResources {
  memoryUsage: {
    total: number;
    free: number;
    used: number;
    usedPercent: number;
  };
  cpuUsage: number[];
  loadAverage: number[];
}

export function getSystemResources(): SystemResources {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  
  return {
    memoryUsage: {
      total: Math.round(totalMem / 1024 / 1024), // MB
      free: Math.round(freeMem / 1024 / 1024),   // MB
      used: Math.round(usedMem / 1024 / 1024),   // MB
      usedPercent: Math.round((usedMem / totalMem) * 100)
    },
    cpuUsage: os.cpus().map(cpu => {
      const total = Object.values(cpu.times).reduce((acc, time) => acc + time, 0);
      const idle = cpu.times.idle;
      return Math.round(((total - idle) / total) * 100);
    }),
    loadAverage: os.loadavg()
  };
}

export function logSystemResources(prefix = '🖥️ System') {
  const resources = getSystemResources();
  logger.info(`${prefix}: RAM ${resources.memoryUsage.used}MB/${resources.memoryUsage.total}MB (${resources.memoryUsage.usedPercent}%), Load: ${resources.loadAverage[0].toFixed(2)}`);
}

export function checkSystemHealth(): { healthy: boolean; warnings: string[] } {
  const resources = getSystemResources();
  const warnings: string[] = [];
  
  // Memory warnings
  if (resources.memoryUsage.usedPercent > 90) {
    warnings.push(`Critical memory usage: ${resources.memoryUsage.usedPercent}%`);
  } else if (resources.memoryUsage.usedPercent > 80) {
    warnings.push(`High memory usage: ${resources.memoryUsage.usedPercent}%`);
  }
  
  // Load average warnings (for 1-minute average)
  const cpuCount = os.cpus().length;
  const loadRatio = resources.loadAverage[0] / cpuCount;
  if (loadRatio > 2.0) {
    warnings.push(`Critical system load: ${resources.loadAverage[0].toFixed(2)} (${(loadRatio * 100).toFixed(0)}% of capacity)`);
  } else if (loadRatio > 1.5) {
    warnings.push(`High system load: ${resources.loadAverage[0].toFixed(2)} (${(loadRatio * 100).toFixed(0)}% of capacity)`);
  }
  
  return {
    healthy: warnings.length === 0,
    warnings
  };
}

export function shouldRejectLargeFile(fileSizeMB: number): { reject: boolean; reason?: string } {
  // Check if running in production (AWS Fargate) - be more permissive
  const isProduction = process.env.NODE_ENV === 'production';
  const resources = getSystemResources();
  
  if (isProduction) {
    // In production (AWS Fargate), only reject if system is critically overloaded
    if (resources.memoryUsage.usedPercent > 95) {
      return {
        reject: true,
        reason: `System critically overloaded (${resources.memoryUsage.usedPercent}% memory). Please try again in a moment.`
      };
    }
    
    // Allow much larger files in production with dedicated resources
    const availableMemoryMB = resources.memoryUsage.free;
    const estimatedProcessingMemoryMB = fileSizeMB * 3; // Less conservative in production
    
    if (estimatedProcessingMemoryMB > availableMemoryMB * 0.9) {
      return {
        reject: true,
        reason: `Insufficient memory for processing ${fileSizeMB.toFixed(1)}MB file. Available: ${availableMemoryMB}MB, Required: ~${estimatedProcessingMemoryMB.toFixed(1)}MB.`
      };
    }
    
    return { reject: false };
  }
  
  // Development environment - keep some restrictions for local stability
  if (resources.memoryUsage.usedPercent > 80) {
    return {
      reject: true,
      reason: `Development environment memory usage high (${resources.memoryUsage.usedPercent}%). Try on production or use a smaller file.`
    };
  }
  
  const availableMemoryMB = resources.memoryUsage.free;
  const estimatedProcessingMemoryMB = fileSizeMB * 4;
  
  if (estimatedProcessingMemoryMB > availableMemoryMB * 0.7) {
    return {
      reject: true,
      reason: `Development environment: Insufficient memory for ${fileSizeMB.toFixed(1)}MB file. Available: ${availableMemoryMB}MB. Deploy to production for large files.`
    };
  }
  
  return { reject: false };
}
