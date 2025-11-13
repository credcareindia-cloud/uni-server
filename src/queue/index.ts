import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { logger } from '../utils/logger.js';

export interface IfcJobData {
  modelId: string;
  projectId: number;
  tempFilePath: string; // Local temp file path created by express-fileupload
  originalFilename: string;
  uploadedByUserId: string;
}

// New interface for process-first workflow
export interface ProcessFirstJobData {
  processingId: string;
  tempFilePath: string;
  originalFilename: string;
  finalFragName: string;
  uploadedByUserId: string;
  projectData: {
    name: string;
    description: string;
    status: string;
  };
}

interface InternalJob extends IfcJobData {
  id: string;
}

interface ProcessFirstInternalJob extends ProcessFirstJobData {
  id: string;
  type: 'process-first';
}

const MAX_CONCURRENCY = Math.max(
  1,
  Math.min(
    Number(process.env.BACKGROUND_WORKERS || 0) || 
    (process.env.NODE_ENV === 'production' 
      ? Math.max(2, Math.floor(os.cpus().length * 0.75)) // More workers in production
      : Math.max(1, Math.floor(os.cpus().length / 2))    // Conservative in development
    ),
    process.env.NODE_ENV === 'production' ? 16 : 8 // Higher limit in production
  )
);

const PENDING: (InternalJob | ProcessFirstInternalJob)[] = [];
const ACTIVE = new Map<string, Worker>();

let started = false;

function resolveWorkerUrl(jobType: 'legacy' | 'process-first' = 'legacy') {
  // Always target compiled JS worker in dist to avoid TS loader in workers
  if (jobType === 'process-first') {
    return new URL('../../dist/queue/processFirst.worker.js', import.meta.url);
  }
  return new URL('../../dist/queue/modelProcessor.worker.js', import.meta.url);
}

function spawnWorker(job: InternalJob | ProcessFirstInternalJob) {
  const isProcessFirst = 'type' in job && job.type === 'process-first';
  const workerUrl = resolveWorkerUrl(isProcessFirst ? 'process-first' : 'legacy');
  
  const jobId = isProcessFirst ? (job as ProcessFirstInternalJob).processingId : (job as InternalJob).modelId;
  
  logger.info(
    `🧵 Spawning ${isProcessFirst ? 'process-first' : 'legacy'} worker for ${jobId} (active=${ACTIVE.size}, pending=${PENDING.length})`
  );

  let workerData: any;
  if (isProcessFirst) {
    const pfJob = job as ProcessFirstInternalJob;
    workerData = {
      processingId: pfJob.processingId,
      tempFilePath: pfJob.tempFilePath,
      originalFilename: pfJob.originalFilename,
      finalFragName: pfJob.finalFragName,
      uploadedByUserId: pfJob.uploadedByUserId,
      projectData: pfJob.projectData,
    };
  } else {
    const legacyJob = job as InternalJob;
    workerData = {
      modelId: legacyJob.modelId,
      projectId: legacyJob.projectId,
      tempFilePath: legacyJob.tempFilePath,
      originalFilename: legacyJob.originalFilename,
      uploadedByUserId: legacyJob.uploadedByUserId,
    };
  }

  const worker = new Worker(workerUrl, { workerData });
  ACTIVE.set(job.id, worker);

  worker.on('message', (msg) => {
    if (typeof msg === 'object' && msg) {
      if (msg.type === 'log') {
        logger.info(`👷 Worker[${jobId}]: ${msg.message}`);
      } else if (msg.type === 'progress') {
        logger.info(`👷 Worker[${jobId}] progress: ${msg.value}% - ${msg.message || ''}`);
      } else if (msg.type === 'status_update' && isProcessFirst) {
        // Handle process-first status updates
        handleProcessingStatusUpdate(msg);
      }
    }
  });

  worker.on('error', (err) => {
    logger.error(`❌ Worker error for ${jobId}:`, err);
  });

  worker.on('exit', (code) => {
    ACTIVE.delete(job.id);
    if (code === 0) {
      logger.info(`✅ Worker finished for ${jobId}`);
    } else {
      logger.error(`❌ Worker exited with code ${code} for ${jobId}`);
    }
    processQueue();
  });
}

// Handle processing status updates from process-first workers
function handleProcessingStatusUpdate(msg: any) {
  // Import the status update function dynamically to avoid circular imports
  try {
    import('../routes/upload-process.js').then(module => {
      if (module.updateProcessingStatus) {
        module.updateProcessingStatus(
          msg.processingId,
          msg.status,
          msg.progress,
          msg.message,
          msg.projectData,
          msg.error
        );
      }
    });
  } catch (err) {
    logger.warn('Failed to update processing status:', err);
  }
}

function processQueue() {
  if (!started) return;
  while (ACTIVE.size < MAX_CONCURRENCY && PENDING.length > 0) {
    const job = PENDING.shift()!;
    spawnWorker(job);
  }
}

export function startModelProcessingQueue() {
  if (started) return;
  started = true;
  logger.info(`🚚 Background queue started with concurrency=${MAX_CONCURRENCY}`);
  processQueue();
}

export function enqueueIfcConversion(jobData: IfcJobData | ProcessFirstJobData) {
  // Check if this is the new process-first workflow
  if ('processingId' in jobData) {
    const processFirstJob = jobData as ProcessFirstJobData;
    const job: ProcessFirstInternalJob = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      type: 'process-first',
      ...processFirstJob,
    };
    PENDING.push(job);
    logger.info(
      `📥 Enqueued process-first job for ${job.processingId} (pending=${PENDING.length}, active=${ACTIVE.size})`
    );
    processQueue();
    return job.id;
  } else {
    // Legacy workflow
    const legacyJobData = jobData as IfcJobData;
    const job: InternalJob = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
      ...legacyJobData,
    };
    PENDING.push(job);
    logger.info(
      `📥 Enqueued IFC conversion for model ${job.modelId} (pending=${PENDING.length}, active=${ACTIVE.size})`
    );
    processQueue();
    return job.id;
  }
}
