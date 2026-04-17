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

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envFlagOff(name: string): boolean {
  const raw = (process.env[name] || '').toLowerCase();
  return raw === 'off' || raw === 'false' || raw === '0' || raw === 'disabled';
}

export function shouldRejectLargeFile(fileSizeMB: number): { reject: boolean; reason?: string } {
  // Escape hatch: allow fully disabling the guard (useful on dev machines where
  // macOS reports high "used" memory for file cache / other apps).
  if (envFlagOff('UPLOAD_MEMORY_GUARD')) {
    return { reject: false };
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const resources = getSystemResources();

  if (isProduction) {
    const prodMaxUsedPercent = envNumber('UPLOAD_PROD_MAX_MEMORY_PERCENT', 95);
    if (resources.memoryUsage.usedPercent > prodMaxUsedPercent) {
      return {
        reject: true,
        reason: `System critically overloaded (${resources.memoryUsage.usedPercent}% memory). Please try again in a moment.`
      };
    }

    const availableMemoryMB = resources.memoryUsage.free;
    const multiplier = envNumber('UPLOAD_PROD_MEMORY_MULTIPLIER', 3);
    const availableRatio = envNumber('UPLOAD_PROD_AVAILABLE_RATIO', 0.9);
    const estimatedProcessingMemoryMB = fileSizeMB * multiplier;

    if (estimatedProcessingMemoryMB > availableMemoryMB * availableRatio) {
      return {
        reject: true,
        reason: `Insufficient memory for processing ${fileSizeMB.toFixed(1)}MB file. Available: ${availableMemoryMB}MB, Required: ~${estimatedProcessingMemoryMB.toFixed(1)}MB.`
      };
    }

    return { reject: false };
  }

  // Development environment - configurable ceilings.
  const devMaxUsedPercent = envNumber('UPLOAD_DEV_MAX_MEMORY_PERCENT', 80);
  if (resources.memoryUsage.usedPercent > devMaxUsedPercent) {
    return {
      reject: true,
      reason: `Development memory guard tripped: ${resources.memoryUsage.usedPercent}% used > ${devMaxUsedPercent}% allowed. Close other apps or set UPLOAD_MEMORY_GUARD=off (or raise UPLOAD_DEV_MAX_MEMORY_PERCENT).`
    };
  }

  const availableMemoryMB = resources.memoryUsage.free;
  const multiplier = envNumber('UPLOAD_DEV_MEMORY_MULTIPLIER', 4);
  const availableRatio = envNumber('UPLOAD_DEV_AVAILABLE_RATIO', 0.7);
  const estimatedProcessingMemoryMB = fileSizeMB * multiplier;

  if (estimatedProcessingMemoryMB > availableMemoryMB * availableRatio) {
    return {
      reject: true,
      reason: `Dev memory guard: estimated ${estimatedProcessingMemoryMB.toFixed(1)}MB > ${(availableMemoryMB * availableRatio).toFixed(1)}MB allowed for ${fileSizeMB.toFixed(1)}MB file. Set UPLOAD_MEMORY_GUARD=off or raise UPLOAD_DEV_AVAILABLE_RATIO / UPLOAD_DEV_MEMORY_MULTIPLIER.`
    };
  }

  return { reject: false };
}
