import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { ifcConverter } from '../services/ifcConverter.js';
import { logger } from '../utils/logger.js';

interface WorkerData {
  modelId: string;
  projectId: number;
  tempFilePath: string;
  originalFilename: string;
  uploadedByUserId: string;
}

function post(type: string, payload: any) {
  parentPort?.postMessage({ type, ...payload });
}

async function updateProgress(modelId: string, status: 'PROCESSING' | 'READY' | 'FAILED', progress: number, errorMessage?: string) {
  try {
    await prisma.model.update({
      where: { id: modelId },
      data: {
        status,
        processingProgress: progress,
        ...(errorMessage ? { errorMessage } : {}),
      },
    });
  } catch (err) {
    logger.warn('Failed to update model progress', err);
  }
}

async function run() {
  const data = workerData as WorkerData;
  const isIfc = data.originalFilename.toLowerCase().endsWith('.ifc');
  const isFrag = data.originalFilename.toLowerCase().endsWith('.frag');

  // Monitor memory usage
  const initialMemory = process.memoryUsage();
  post('log', { message: `Starting background processing for model ${data.modelId} (${isIfc ? 'IFC' : 'FRAG'})` });
  post('log', { message: `Initial memory: ${(initialMemory.heapUsed / 1024 / 1024).toFixed(1)}MB` });

  // Set up memory monitoring - different limits for production vs development
  const isProduction = process.env.NODE_ENV === 'production';
  const warningLimitMB = isProduction ? 8192 : 2048;  // 8GB in prod, 2GB in dev
  const criticalLimitMB = isProduction ? 12288 : 3072; // 12GB in prod, 3GB in dev
  
  let memoryCheckInterval: NodeJS.Timeout | null = setInterval(() => {
    const mem = process.memoryUsage();
    const heapUsedMB = mem.heapUsed / 1024 / 1024;
    if (heapUsedMB > warningLimitMB) {
      post('log', { message: `⚠️ High memory usage: ${heapUsedMB.toFixed(1)}MB` });
    }
    if (heapUsedMB > criticalLimitMB) {
      if (memoryCheckInterval) clearInterval(memoryCheckInterval);
      const env = isProduction ? 'production' : 'development';
      throw new Error(`Memory limit exceeded: ${heapUsedMB.toFixed(1)}MB in ${env} environment`);
    }
  }, isProduction ? 5000 : 3000); // Less frequent monitoring in production

  try {
    await updateProgress(data.modelId, 'PROCESSING', 1);

    // Get the model to read precomputed storageKey
    const model = await prisma.model.findUnique({
      where: { id: data.modelId },
      select: { storageKey: true }
    });

    if (!model) throw new Error('Model not found');

    if (isIfc) {
      // Read IFC file from temp path
      const ifcBuffer = await fs.readFile(data.tempFilePath);
      post('log', { message: `Read IFC temp file (${(ifcBuffer.length / 1024 / 1024).toFixed(2)} MB)` });

      // Convert to FRAG with progress updates
      const result = await ifcConverter.convertIfcToFragments(ifcBuffer, async (p, message) => {
        const pct = Math.max(2, Math.min(98, Math.floor(p)));
        post('progress', { value: pct, message });
        await updateProgress(data.modelId, 'PROCESSING', pct);
      });

      const fragBuffer = Buffer.from(result.fragmentsBuffer);
      post('log', { message: `FRAG buffer size ${(fragBuffer.length / 1024 / 1024).toFixed(2)} MB` });

      // Upload FRAG to storage using precomputed key
      await storageService.uploadFile(model.storageKey, fragBuffer, 'application/octet-stream');

      // Convert IFC metadata to DB structures (store spatialStructure, create panels)
      const extractedMetadata = result.metadata || { storeys: [], totalElements: 0 };

      // Save minimal metadata on model
      await prisma.model.update({
        where: { id: data.modelId },
        data: {
          elementCount: extractedMetadata.totalElements || 0,
          spatialStructure: (extractedMetadata.storeys || []).map((storey: any, index: number) => ({
            id: `${data.modelId.slice(-8)}_storey_${index}`,
            name: storey.name,
            type: 'IfcBuildingStorey',
            elementCount: storey.elementCount,
            properties: {
              description: `Building storey: ${storey.name}`,
              elevation: index * 3000,
              elementIds: storey.elements ? storey.elements.map((e: any) => e.id) : []
            },
            children: storey.elements ? storey.elements.map((element: any) => ({
              id: element.id,
              name: element.name,
              type: element.type,
              material: element.material,
              properties: {
                storey: storey.name,
                material: element.material
              }
            })) : []
          })),
          sizeBytes: BigInt(fragBuffer.length),
        }
      });

      // Create panels based on IFC elements (optional, simplified)
      if (Array.isArray(extractedMetadata.storeys)) {
        const panels: any[] = [];
        for (const storey of extractedMetadata.storeys) {
          if (storey.elements && storey.elements.length) {
            for (const element of storey.elements) {
              panels.push({
                projectId: data.projectId,
                modelId: data.modelId,
                name: element.name,
                tag: element.name,
                objectType: element.type,
                location: storey.name,
                material: element.material && element.material !== 'N/A' ? element.material : null,
                metadata: {
                  extractedFromIFC: true,
                  storeyName: storey.name,
                  elementType: element.type,
                  ifcElementId: element.id,
                  material: element.material
                }
              });
            }
          }
        }
        if (panels.length) {
          await prisma.panel.createMany({ data: panels, skipDuplicates: true });
        }
      }

      await updateProgress(data.modelId, 'READY', 100);
    } else if (isFrag) {
      // Upload FRAG file directly
      const fragBuffer = await fs.readFile(data.tempFilePath);
      await storageService.uploadFile(model.storageKey, fragBuffer, 'application/octet-stream');

      await prisma.model.update({
        where: { id: data.modelId },
        data: {
          status: 'READY',
          processingProgress: 100,
          sizeBytes: BigInt(fragBuffer.length)
        }
      });
    } else {
      throw new Error('Unsupported file type');
    }

    // Cleanup temp file
    try {
      await fs.unlink(data.tempFilePath);
      post('log', { message: `Deleted temp file ${data.tempFilePath}` });
    } catch (e) {
      post('log', { message: `Failed to delete temp file: ${String(e)}` });
    }

  } catch (err: any) {
    post('log', { message: `Error: ${err?.message || String(err)}` });
    await updateProgress(workerData.modelId, 'FAILED', 0, err?.message || 'Processing failed');
  } finally {
    // Clean up memory monitoring
    if (memoryCheckInterval) {
      clearInterval(memoryCheckInterval);
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      const finalMemory = process.memoryUsage();
      post('log', { message: `Final memory: ${(finalMemory.heapUsed / 1024 / 1024).toFixed(1)}MB` });
    }
  }
}

run().finally(async () => {
  try { await prisma.$disconnect(); } catch {}
});
