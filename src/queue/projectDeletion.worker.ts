import { parentPort, workerData } from 'node:worker_threads';
import { PrismaClient } from '@prisma/client';

// Initialize Prisma Client
const prisma = new PrismaClient();

interface DeletionWorkerData {
    jobId: string;
    projectId: number;
    userId: string;
}

const data = workerData as DeletionWorkerData;

// Helper to send updates to main thread
const sendUpdate = (status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED', progress: number, message: string, error?: string) => {
    if (parentPort) {
        parentPort.postMessage({
            type: 'deletion_status_update',
            jobId: data.jobId,
            status,
            progress,
            message,
            error
        });
    }
};

async function deleteProject() {
    const { jobId, projectId, userId } = data;
    const BATCH_SIZE = 500;

    try {
        sendUpdate('IN_PROGRESS', 0, 'Starting project deletion...');

        // Get project details for logging
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: {
                name: true,
                _count: {
                    select: {
                        panels: true,
                        groups: true,
                        statuses: true,
                        modelHistory: true
                    }
                }
            }
        });

        if (!project) {
            throw new Error(`Project ${projectId} not found`);
        }

        // Calculate total items for progress estimation
        // This is a rough estimate: panels + groups + statuses + models + (models * ~1000 elements avg)
        // We'll update progress based on steps completed
        const totalSteps = 10; // 10 distinct steps in the process
        let currentStep = 0;

        const updateStepProgress = (msg: string) => {
            currentStep++;
            const progress = Math.round((currentStep / totalSteps) * 100);
            sendUpdate('IN_PROGRESS', Math.min(progress, 99), msg);
            console.log(`[Delete Project ${projectId}] Step ${currentStep}/${totalSteps}: ${msg}`);
        };

        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        // Step 1: Query all Panel IDs and Model IDs upfront (Fast & avoids JOINs later)
        updateStepProgress('Fetching project structure...');
        const panels = await prisma.panel.findMany({
            where: { projectId },
            select: { id: true }
        });
        const panelIds = panels.map(p => p.id);

        const models = await prisma.model.findMany({
            where: { projectId },
            select: { id: true }
        });
        const modelIds = models.map(m => m.id);

        const deleteInBatches = async (ids: string[], deleteFn: (batchIds: string[]) => Promise<any>, label: string) => {
            for (let i = 0; i < ids.length; i += BATCH_SIZE) {
                const batch = ids.slice(i, i + BATCH_SIZE);
                await deleteFn(batch);
                if (i % 500 === 0 && i > 0) {
                    sendUpdate('IN_PROGRESS', 40, `Deleting ${label} (${i}/${ids.length})...`);
                }
                await sleep(10); // Give database breathing room
            }
        };

        // Step 2: Delete QR Codes and UserPanelViews (these don't have Prisma relations set up so no automatic cascade)
        updateStepProgress('Deleting orphaned QR codes and views...');
        
        // Delete QRCodes by projectId
        await prisma.qRCode.deleteMany({ where: { projectId } }).catch(() => {});
        
        if (panelIds.length > 0) {
            // Delete UserPanelViews by panelIds
            await deleteInBatches(panelIds, async (batchIds) => {
                await prisma.userPanelView.deleteMany({ where: { panelId: { in: batchIds } } }).catch(() => {});
            }, "panel views");
        }

        // Step 3-4: Delete Panels directly (Prisma will automatically cascade delete PanelStatus, PanelGroup, and StatusHistory)
        updateStepProgress('Deleting panels and assignments...');
        if (panelIds.length > 0) {
            await deleteInBatches(panelIds, async (batchIds) => {
                await prisma.panel.deleteMany({ where: { id: { in: batchIds } } });
            }, "panels");
        }

        // Step 5: Delete groups
        updateStepProgress('Deleting groups...');
        await prisma.group.deleteMany({ where: { projectId } });

        // Step 6: Delete statuses
        updateStepProgress('Deleting statuses...');
        await prisma.status.deleteMany({ where: { projectId } });

        // Step 7: Delete model elements
        updateStepProgress('Deleting 3D model elements...');
        let deletedModelElements = 0;
        for (const modelId of modelIds) {
            // 🚀 FAST PATH: Raw SQL delete bypasses Prisma memory overhead 🚀
            // Delete all elements for this model in one instant query
            const result = await prisma.$executeRaw`DELETE FROM "model_elements" WHERE "model_id" = ${modelId}`;
            
            deletedModelElements += result;
            sendUpdate('IN_PROGRESS', 70, `Deleted ${result} elements for model ${modelId} (Total: ${deletedModelElements})...`);
            
            await sleep(50);
        }

        // Step 8: Delete models
        updateStepProgress('Deleting models...');
        if (modelIds.length > 0) {
            await prisma.model.deleteMany({ where: { projectId } });
        }

        // Step 9: Delete project members
        updateStepProgress('Deleting project members...');
        await prisma.projectMember.deleteMany({ where: { projectId } });

        // Step 10: Delete project
        updateStepProgress('Finalizing deletion...');
        await prisma.projectDeletion.deleteMany({ where: { projectId, id: { not: jobId } } }).catch(() => {}); // Clean up old jobs except this one
        await prisma.project.delete({ where: { id: projectId } });

        sendUpdate('COMPLETED', 100, 'Project deleted successfully');

        // Disconnect Prisma
        await prisma.$disconnect();

        // Exit success
        process.exit(0);

    } catch (error) {
        console.error('Deletion worker error:', error);
        sendUpdate('FAILED', 0, 'Deletion failed', error instanceof Error ? error.message : 'Unknown error');
        await prisma.$disconnect();
        process.exit(1);
    }
}

deleteProject();
