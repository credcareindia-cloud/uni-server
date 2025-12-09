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
    const BATCH_SIZE = 50;

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
            sendUpdate('IN_PROGRESS', progress, msg);
        };

        // Step 1: Delete panel-status relationships
        updateStepProgress('Deleting panel status assignments...');
        while (true) {
            const batch = await prisma.panelStatus.findMany({
                where: { panel: { projectId } },
                take: BATCH_SIZE,
                select: { id: true }
            });
            if (batch.length === 0) break;
            await prisma.panelStatus.deleteMany({
                where: { id: { in: batch.map(ps => ps.id) } }
            });
        }

        // Step 2: Delete panel-group relationships
        updateStepProgress('Deleting panel group assignments...');
        while (true) {
            const batch = await prisma.panelGroup.findMany({
                where: { panel: { projectId } },
                take: BATCH_SIZE,
                select: { id: true }
            });
            if (batch.length === 0) break;
            await prisma.panelGroup.deleteMany({
                where: { id: { in: batch.map(pg => pg.id) } }
            });
        }

        // Step 3: Delete status history
        updateStepProgress('Deleting status history...');
        while (true) {
            const batch = await prisma.statusHistory.findMany({
                where: { panel: { projectId } },
                take: BATCH_SIZE,
                select: { id: true }
            });
            if (batch.length === 0) break;
            await prisma.statusHistory.deleteMany({
                where: { id: { in: batch.map(sh => sh.id) } }
            });
        }

        // Step 4: Delete panels
        updateStepProgress('Deleting panels...');
        while (true) {
            const batch = await prisma.panel.findMany({
                where: { projectId },
                take: BATCH_SIZE,
                select: { id: true }
            });
            if (batch.length === 0) break;
            await prisma.panel.deleteMany({
                where: { id: { in: batch.map(p => p.id) } }
            });
        }

        // Step 5: Delete groups
        updateStepProgress('Deleting groups...');
        await prisma.group.deleteMany({ where: { projectId } });

        // Step 6: Delete statuses
        updateStepProgress('Deleting statuses...');
        await prisma.status.deleteMany({ where: { projectId } });

        // Step 7: Delete model elements
        updateStepProgress('Deleting model elements...');
        const models = await prisma.model.findMany({
            where: { projectId },
            select: { id: true }
        });

        let deletedModelElements = 0;
        for (const model of models) {
            while (true) {
                const batch = await prisma.modelElement.findMany({
                    where: { modelId: model.id },
                    take: BATCH_SIZE,
                    select: { id: true }
                });

                if (batch.length === 0) break;

                await prisma.modelElement.deleteMany({
                    where: { id: { in: batch.map(me => me.id) } }
                });

                deletedModelElements += batch.length;

                // Send intermediate progress updates for large model deletions
                if (deletedModelElements % 500 === 0) {
                    // Keep status as IN_PROGRESS but update message
                    sendUpdate('IN_PROGRESS', 70, `Deleting model elements (${deletedModelElements} deleted)...`);
                }
            }
        }

        // Step 8: Delete models
        updateStepProgress('Deleting models...');
        await prisma.model.deleteMany({ where: { projectId } });

        // Step 9: Delete project members
        updateStepProgress('Deleting project members...');
        await prisma.projectMember.deleteMany({ where: { projectId } });

        // Step 10: Delete project
        updateStepProgress('Finalizing deletion...');
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
