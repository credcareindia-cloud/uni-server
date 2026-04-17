import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { logger } from '../utils/logger.js';

export interface IfcJobData {
  modelId: string;
  projectId: number;
  tempFilePath: string; // Local temp file path created by express-fileupload
  originalFilename: string;
  uploadedByUserId: string;
}

// Handle multi-file processing status updates
function handleMultiFileStatusUpdate(msg: any) {
  logger.info(`🔄 Received multi-file status update: jobId=${msg.jobId}, fileIndex=${msg.fileIndex}, status=${msg.status}, progress=${msg.progress}`);
  try {
    import('../routes/multi-file-upload.js').then(module => {
      if (module.updateMultiFileStatus) {
        logger.info(`📊 Calling updateMultiFileStatus for jobId=${msg.jobId}`);
        module.updateMultiFileStatus(
          msg.jobId,
          msg.fileIndex,
          msg.status,
          msg.progress,
          msg.message,
          msg.modelData,
          msg.error
        );
      } else {
        logger.error('❌ updateMultiFileStatus function not found in module');
      }
    }).catch(err => {
      logger.error('❌ Failed to import multi-file-upload module:', err);
    });
  } catch (err) {
    logger.warn('Failed to update multi-file status:', err);
  }
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
  // Multi-file context (optional)
  isMultiFile?: boolean;
  multiFileJobId?: string;
  fileIndex?: number;
  category?: string;
}

interface InternalJob extends IfcJobData {
  id: string;
}

interface ProcessFirstInternalJob extends ProcessFirstJobData {
  id: string;
  type: 'process-first';
}

interface ProjectDeletionInternalJob extends ProjectDeletionJobData {
  id: string;
  type: 'deletion';
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

const PENDING: (InternalJob | ProcessFirstInternalJob | ProjectDeletionInternalJob)[] = [];
const ACTIVE = new Map<string, Worker>();

let started = false;

function resolveWorkerUrl(jobType: 'legacy' | 'process-first' | 'deletion' = 'legacy') {
  const file =
    jobType === 'process-first'
      ? 'processFirst.worker.js'
      : jobType === 'deletion'
        ? 'projectDeletion.worker.js'
        : 'modelProcessor.worker.js';
  // Worker threads load plain Node ESM from dist (tsx does not resolve .js→.ts inside workers).
  const abs = join(process.cwd(), 'dist', 'queue', file);
  if (!existsSync(abs)) {
    throw new Error(
      `Missing compiled worker: ${abs}. Run "npm run build" once (or use a dev script that builds before watch).`
    );
  }
  return pathToFileURL(abs);
}

function spawnWorker(job: InternalJob | ProcessFirstInternalJob | ProjectDeletionInternalJob) {
  const isProcessFirst = 'type' in job && job.type === 'process-first';
  const isDeletion = 'type' in job && job.type === 'deletion';

  const workerUrl = resolveWorkerUrl(isProcessFirst ? 'process-first' : (isDeletion ? 'deletion' : 'legacy'));

  let jobId: string;
  if (isProcessFirst) {
    jobId = (job as ProcessFirstInternalJob).processingId;
  } else if (isDeletion) {
    jobId = (job as ProjectDeletionInternalJob).jobId;
  } else {
    jobId = (job as InternalJob).modelId;
  }

  logger.info(
    `🧵 Spawning ${isProcessFirst ? 'process-first' : (isDeletion ? 'deletion' : 'legacy')} worker for ${jobId} (active=${ACTIVE.size}, pending=${PENDING.length})`
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
      isMultiFile: pfJob.isMultiFile,
      multiFileJobId: pfJob.multiFileJobId,
      fileIndex: pfJob.fileIndex,
      category: pfJob.category,
    };
  } else if (isDeletion) {
    const delJob = job as ProjectDeletionInternalJob;
    workerData = {
      jobId: delJob.jobId,
      projectId: delJob.projectId,
      userId: delJob.userId
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
        handleProcessingStatusUpdate(msg);
      } else if (msg.type === 'multi_status_update' && isProcessFirst) {
        handleMultiFileStatusUpdate(msg);
      } else if (msg.type === 'deletion_status_update' && isDeletion) {
        handleDeletionStatusUpdate(msg);
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

// Handle deletion status updates
function handleDeletionStatusUpdate(msg: any) {
  try {
    import('../routes/projects-simple.js').then(module => {
      if (module.updateDeletionStatus) {
        module.updateDeletionStatus(
          msg.jobId,
          msg.status,
          msg.progress,
          msg.message,
          msg.error
        );
      }
    });
  } catch (err) {
    logger.warn('Failed to update deletion status:', err);
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

export interface ProjectDeletionJobData {
  jobId: string;
  projectId: number;
  userId: string;
}

interface ProjectDeletionInternalJob extends ProjectDeletionJobData {
  id: string;
  type: 'deletion';
}

export function enqueueDeletion(jobData: ProjectDeletionJobData) {
  const job: ProjectDeletionInternalJob = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    type: 'deletion',
    ...jobData
  };
  PENDING.push(job);
  logger.info(
    `📥 Enqueued deletion job for project ${job.projectId} (pending=${PENDING.length}, active=${ACTIVE.size})`
  );
  processQueue();
  return job.id;
}
