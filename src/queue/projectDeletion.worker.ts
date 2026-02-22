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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Delete items in small chunks to never hit the 30s DB timeout
async function deleteInChunks(
    ids: string[],
    deleteFn: (batchIds: string[]) => Promise<any>,
    chunkSize = 1000
) {
    for (let i = 0; i < ids.length; i += chunkSize) {
        const batch = ids.slice(i, i + chunkSize);
        await deleteFn(batch);
        await sleep(20);
    }
}

async function deleteProject() {
    const { jobId, projectId } = data;

    try {
        sendUpdate('IN_PROGRESS', 2, 'Starting project deletion...');

        // ── Step 1: Fetch project structure upfront ──────────────────────────
        sendUpdate('IN_PROGRESS', 5, 'Fetching project structure...');

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { name: true }
        });

        if (!project) {
            throw new Error(`Project ${projectId} not found`);
        }

        const panelRows = await prisma.panel.findMany({
            where: { projectId },
            select: { id: true }
        });
        const panelIds = panelRows.map(p => p.id);

        const modelRows = await prisma.model.findMany({
            where: { projectId },
            select: { id: true }
        });
        const modelIds = modelRows.map(m => m.id);

        console.log(`[Delete ${projectId}] panels=${panelIds.length}, models=${modelIds.length}`);

        // ── Step 2: Delete QR codes (no Prisma cascade on this) ─────────────
        sendUpdate('IN_PROGRESS', 10, 'Deleting QR codes...');
        await prisma.qRCode.deleteMany({ where: { projectId } }).catch(() => {});

        // ── Step 3: Delete UserPanelViews ────────────────────────────────────
        sendUpdate('IN_PROGRESS', 15, 'Deleting user panel views...');
        if (panelIds.length > 0) {
            await deleteInChunks(panelIds, async (batch) => {
                await prisma.userPanelView.deleteMany({
                    where: { panelId: { in: batch } }
                }).catch(() => {});
            });
        }

        // ── Step 4: Delete Panels (cascades PanelStatus, PanelGroup, StatusHistory) ──
        sendUpdate('IN_PROGRESS', 25, `Deleting ${panelIds.length} panels...`);
        if (panelIds.length > 0) {
            await deleteInChunks(panelIds, async (batch) => {
                await prisma.panel.deleteMany({ where: { id: { in: batch } } });
            });
        }

        // ── Step 5: Delete Groups ────────────────────────────────────────────
        sendUpdate('IN_PROGRESS', 40, 'Deleting groups...');
        await prisma.group.deleteMany({ where: { projectId } });

        // ── Step 6: Delete Statuses ──────────────────────────────────────────
        sendUpdate('IN_PROGRESS', 45, 'Deleting statuses...');
        await prisma.status.deleteMany({ where: { projectId } });

        // ── Step 7: Delete Model Elements + Models ───────────────────────────
        // We MUST delete elements manually BEFORE each model to avoid the 30s
        // cascade timeout. Even a single model can have 100k+ elements.
        const totalModels = modelIds.length;
        for (let i = 0; i < modelIds.length; i++) {
            const modelId = modelIds[i];
            const modelProgress = 50 + Math.round((i / totalModels) * 40);

            sendUpdate('IN_PROGRESS', modelProgress, `Deleting model ${i + 1}/${totalModels} elements...`);

            // Fetch element IDs for this model
            const elementRows = await prisma.modelElement.findMany({
                where: { modelId },
                select: { id: true }
            });
            const elementIds = elementRows.map(e => e.id);

            console.log(`[Delete ${projectId}] Model ${i + 1}/${totalModels}: ${elementIds.length} elements`);

            // Delete elements in chunks of 1000 at a time
            // 1000 rows per query ~1-2s each, well under the 30s timeout
            await deleteInChunks(elementIds, async (batch) => {
                await prisma.modelElement.deleteMany({ where: { id: { in: batch } } });
            }, 1000);

            // Now delete the (now-empty) model shell
            await prisma.model.delete({ where: { id: modelId } });

            await sleep(50);
        }

        // ── Step 8: Delete project members ───────────────────────────────────
        sendUpdate('IN_PROGRESS', 92, 'Deleting project members...');
        await prisma.projectMember.deleteMany({ where: { projectId } });

        // ── Step 9: Delete the project itself ────────────────────────────────
        sendUpdate('IN_PROGRESS', 97, 'Finalizing...');
        await prisma.projectDeletion.deleteMany({
            where: { projectId, id: { not: jobId } }
        }).catch(() => {});
        await prisma.project.delete({ where: { id: projectId } });

        sendUpdate('COMPLETED', 100, 'Project deleted successfully');
        await prisma.$disconnect();
        process.exit(0);

    } catch (error) {
        console.error('Deletion worker error:', error);
        sendUpdate(
            'FAILED',
            0,
            'Deletion failed',
            error instanceof Error ? error.message : 'Unknown error'
        );
        await prisma.$disconnect();
        process.exit(1);
    }
}

deleteProject();
