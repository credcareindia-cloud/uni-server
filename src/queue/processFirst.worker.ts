import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../config/database.js';
import { storageService } from '../config/storage.js';
import { ifcConverter } from '../services/ifcConverter.js';
import { logger } from '../utils/logger.js';

interface WorkerData {
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

function post(type: string, payload: any) {
  parentPort?.postMessage({ type, ...payload });
}

async function updateProcessingStatus(
  processingId: string,
  status: 'processing' | 'completed' | 'failed',
  progress: number,
  message: string,
  projectData?: any,
  error?: string
) {
  post('status_update', {
    processingId,
    status,
    progress,
    message,
    projectData,
    error
  });
}

async function run() {
  const data = workerData as WorkerData;
  const isIfc = data.originalFilename.toLowerCase().endsWith('.ifc');
  const isFrag = data.originalFilename.toLowerCase().endsWith('.frag');

  // Monitor memory usage
  const initialMemory = process.memoryUsage();
  post('log', { message: `🚀 Starting processing for ${data.processingId} (${isIfc ? 'IFC' : 'FRAG'})` });
  post('log', { message: `Initial memory: ${(initialMemory.heapUsed / 1024 / 1024).toFixed(1)}MB` });

  // Set up memory monitoring
  const isProduction = process.env.NODE_ENV === 'production';
  const warningLimitMB = isProduction ? 8192 : 2048;
  const criticalLimitMB = isProduction ? 12288 : 3072;
  
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
  }, isProduction ? 5000 : 3000);

  try {
    await updateProcessingStatus(
      data.processingId,
      'processing',
      30,
      isIfc ? 'Converting IFC to FRAG format...' : 'Processing FRAG file...'
    );

    let fragBuffer: Buffer;
    let extractedMetadata: any = null;

    if (isIfc) {
      // Read IFC file from temp path
      const ifcBuffer = await fs.readFile(data.tempFilePath);
      post('log', { message: `📖 Read IFC temp file (${(ifcBuffer.length / 1024 / 1024).toFixed(2)} MB)` });

      await updateProcessingStatus(
        data.processingId,
        'processing',
        40,
        'Extracting IFC metadata and converting to FRAG...'
      );

      // Convert to FRAG with progress updates
      const result = await ifcConverter.convertIfcToFragments(ifcBuffer, async (p, message) => {
        const pct = Math.max(40, Math.min(80, Math.floor(40 + (p * 0.4))));
        await updateProcessingStatus(
          data.processingId,
          'processing',
          pct,
          message || 'Converting IFC to FRAG...'
        );
      });

      fragBuffer = Buffer.from(result.fragmentsBuffer);
      extractedMetadata = result.metadata || { storeys: [], totalElements: 0 };
      
      post('log', { message: `✅ FRAG conversion complete (${(fragBuffer.length / 1024 / 1024).toFixed(2)} MB)` });

    } else if (isFrag) {
      // Read FRAG file directly
      fragBuffer = await fs.readFile(data.tempFilePath);
      post('log', { message: `📖 Read FRAG file (${(fragBuffer.length / 1024 / 1024).toFixed(2)} MB)` });

      await updateProcessingStatus(
        data.processingId,
        'processing',
        60,
        'FRAG file ready for processing...'
      );
    } else {
      throw new Error('Unsupported file type');
    }

    await updateProcessingStatus(
      data.processingId,
      'processing',
      85,
      'Creating project and uploading model...'
    );

    // NOW CREATE THE PROJECT - Only after successful processing
    const result = await prisma.$transaction(async (tx) => {
      // Create the project first
      const project = await tx.project.create({
        data: {
          name: data.projectData.name,
          description: data.projectData.description,
          status: data.projectData.status as any,
          metadata: {
            createdFromModel: true,
            originalFilename: data.originalFilename,
            convertedFromIfc: isIfc,
            modelFirst: true,
            processedSuccessfully: true
          },
          createdBy: data.uploadedByUserId
        }
      });

      // Generate storage key for the FRAG
      const storageKey = storageService.generateStorageKey(String(project.id), 'temp_model_id', data.finalFragName);

      // Create the model record
      const model = await tx.model.create({
        data: {
          projectId: project.id,
          type: 'FRAG',
          originalFilename: data.finalFragName,
          storageKey: 'temp_key', // Will be updated below
          sizeBytes: BigInt(fragBuffer.length),
          status: 'READY', // Already processed successfully!
          processingProgress: 100,
          version: 1,
          isActive: true,
          elementCount: extractedMetadata?.totalElements || 0,
          spatialStructure: extractedMetadata ? (extractedMetadata.storeys || []).map((storey: any, index: number) => ({
            id: `${project.id}_storey_${index}`,
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
          })) : null
        }
      });

      // Update project to set current model
      const updatedProject = await tx.project.update({
        where: { id: project.id },
        data: {
          currentModelId: model.id
        }
      });

      // Update storage key with real model ID
      const finalStorageKey = storageService.generateStorageKey(String(project.id), model.id, data.finalFragName);
      await tx.model.update({ 
        where: { id: model.id }, 
        data: { storageKey: finalStorageKey } 
      });

      return { project: updatedProject, model: { ...model, storageKey: finalStorageKey } };
    });

    post('log', { message: `🎉 Project created: ${result.project.name} with model ${result.model.id}` });

    await updateProcessingStatus(
      data.processingId,
      'processing',
      95,
      'Uploading model to storage...'
    );

    // Upload FRAG to storage
    await storageService.uploadFile(result.model.storageKey, fragBuffer, 'application/octet-stream');

    // Create panels based on IFC elements (if IFC was converted)
    if (isIfc && extractedMetadata && Array.isArray(extractedMetadata.storeys)) {
      const panels: any[] = [];
      for (const storey of extractedMetadata.storeys) {
        if (storey.elements && storey.elements.length) {
          for (const element of storey.elements) {
            panels.push({
              projectId: result.project.id,
              modelId: result.model.id,
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
        post('log', { message: `📋 Created ${panels.length} panels from IFC elements` });
      }
    }

    // Processing completed successfully!
    await updateProcessingStatus(
      data.processingId,
      'completed',
      100,
      'Project created successfully!',
      {
        project: {
          id: result.project.id,
          name: result.project.name,
          description: result.project.description,
          status: result.project.status.toLowerCase().replace('_', '-'),
          createdAt: result.project.createdAt,
          updatedAt: result.project.updatedAt
        },
        model: {
          id: result.model.id,
          originalFilename: result.model.originalFilename,
          status: 'ready',
          sizeBytes: Number(result.model.sizeBytes),
          processingProgress: 100
        }
      }
    );

    post('log', { message: `✅ Processing completed successfully for ${data.processingId}` });

    // Cleanup temp file
    try {
      await fs.unlink(data.tempFilePath);
      post('log', { message: `🗑️ Deleted temp file ${data.tempFilePath}` });
    } catch (e) {
      post('log', { message: `⚠️ Failed to delete temp file: ${String(e)}` });
    }

  } catch (err: any) {
    post('log', { message: `❌ Processing failed: ${err?.message || String(err)}` });
    
    await updateProcessingStatus(
      data.processingId,
      'failed',
      0,
      'Processing failed',
      undefined,
      err?.message || 'Unknown error occurred'
    );

    // Cleanup temp file on error
    try {
      await fs.unlink(data.tempFilePath);
      post('log', { message: `🗑️ Cleaned up temp file after error` });
    } catch (e) {
      post('log', { message: `⚠️ Failed to cleanup temp file: ${String(e)}` });
    }
  } finally {
    // Clean up memory monitoring
    if (memoryCheckInterval) {
      clearInterval(memoryCheckInterval);
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      const finalMemory = process.memoryUsage();
      post('log', { message: `💾 Final memory: ${(finalMemory.heapUsed / 1024 / 1024).toFixed(1)}MB` });
    }
  }
}

run().finally(async () => {
  try { await prisma.$disconnect(); } catch {}
});
