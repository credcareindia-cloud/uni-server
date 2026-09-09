import { parentPort, workerData } from 'node:worker_threads';
import { PrismaClient } from '@prisma/client';

// Extended socket_timeout so that large raw SQL deletes never get cut off.
function buildDatabaseUrl(): string {
    const base = process.env.DATABASE_URL || '';
    try {
        const url = new URL(base);
        url.searchParams.set('socket_timeout', '300');
        url.searchParams.set('connect_timeout', '60');
        return url.toString();
    } catch {
        return base;
    }
}

const prisma = new PrismaClient({
    datasources: { db: { url: buildDatabaseUrl() } },
});

interface DeletionWorkerData {
    jobId: string;
    projectId: number;
    userId: string;
}

const data = workerData as DeletionWorkerData;

const ELEMENT_BATCH = 2000;

const sendUpdate = (
    status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED',
    progress: number,
    message: string,
    error?: string
) => {
    if (parentPort) {
        parentPort.postMessage({
            type: 'deletion_status_update',
            jobId: data.jobId,
            status,
            progress,
            message,
            error,
        });
    }
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Delete model_elements in bounded batches.
 * A single DELETE WHERE model_id = ? times out on large IFC models (P2010 / statement timeout).
 */
async function deleteModelElementsBatched(projectId: number, modelId: string): Promise<number> {
    let total = 0;
    for (;;) {
        // LIMIT must be interpolated — Prisma tagged templates cannot bind LIMIT reliably.
        const deleted = await prisma.$executeRawUnsafe(
            `DELETE FROM "model_elements"
             WHERE "id" IN (
               SELECT "id" FROM "model_elements"
               WHERE "model_id" = $1
               LIMIT ${ELEMENT_BATCH}
             )`,
            modelId
        );
        const n = Number(deleted) || 0;
        total += n;
        if (n === 0) break;
        console.log(`[Delete ${projectId}] model ${modelId}: deleted ${total} elements so far`);
        await sleep(25);
    }
    return total;
}

async function deleteProject() {
    const { jobId, projectId } = data;

    try {
        // Cap individual statements; batches keep each DELETE under this budget.
        await prisma.$executeRawUnsafe(`SET statement_timeout = '120s'`).catch(() => {});

        sendUpdate('IN_PROGRESS', 2, 'Starting project deletion...');

        const project = await prisma.project.findUnique({
            where: { id: projectId },
            select: { name: true },
        });

        if (!project) {
            console.log(`[Delete ${projectId}] Project already deleted or does not exist. Marking COMPLETED.`);
            sendUpdate('COMPLETED', 100, 'Project already deleted');
            await prisma.$disconnect();
            process.exit(0);
        }

        console.log(`[Delete ${projectId}] Deleting "${project.name}"`);

        sendUpdate('IN_PROGRESS', 10, 'Deleting QR codes...');
        await prisma.qRCode.deleteMany({ where: { projectId } }).catch(() => {});
        console.log(`[Delete ${projectId}] QR codes deleted`);

        sendUpdate('IN_PROGRESS', 20, 'Deleting user panel views...');
        const panelRows = await prisma.panel.findMany({ where: { projectId }, select: { id: true } });
        const panelIds = panelRows.map(p => p.id);

        if (panelIds.length > 0) {
            for (let i = 0; i < panelIds.length; i += 1000) {
                const batch = panelIds.slice(i, i + 1000);
                await prisma.userPanelView.deleteMany({ where: { panelId: { in: batch } } }).catch(() => {});
            }
        }
        console.log(`[Delete ${projectId}] User panel views deleted`);

        sendUpdate('IN_PROGRESS', 30, 'Preparing model references...');
        await prisma.project.update({
            where: { id: projectId },
            data: { currentModelId: null },
        }).catch(() => {});

        // Panels before model_elements — avoids FK SET NULL scans on every element delete.
        sendUpdate('IN_PROGRESS', 40, `Deleting ${panelIds.length} panels...`);
        if (panelIds.length > 0) {
            console.log(`[Delete ${projectId}] Deleting ${panelIds.length} panels in chunks...`);
            for (let i = 0; i < panelIds.length; i += 1000) {
                const chunk = panelIds.slice(i, i + 1000);
                await prisma.panel.deleteMany({ where: { id: { in: chunk } } }).catch(() => {});
                await sleep(50);
            }
            console.log(`[Delete ${projectId}] Panels deleted`);
        }

        await prisma.group.deleteMany({ where: { projectId } }).catch(() => {});
        await prisma.status.deleteMany({ where: { projectId } }).catch(() => {});
        await prisma.projectDocument.deleteMany({ where: { projectId } }).catch(() => {});
        await prisma.projectDrawing.deleteMany({ where: { projectId } }).catch(() => {});
        await prisma.projectBrowserRevision.deleteMany({ where: { projectId } }).catch(() => {});

        const modelRows = await prisma.model.findMany({
            where: { projectId },
            select: { id: true },
        });

        const totalModels = modelRows.length;
        console.log(`[Delete ${projectId}] Found ${totalModels} models to delete`);

        for (let i = 0; i < totalModels; i++) {
            const modelId = modelRows[i].id;
            const modelProgress = 55 + Math.round(((i + 1) / (totalModels || 1)) * 30);
            sendUpdate('IN_PROGRESS', modelProgress, `Deleting model ${i + 1}/${totalModels}...`);

            const deleted = await deleteModelElementsBatched(projectId, modelId);
            console.log(`[Delete ${projectId}] Model ${i + 1}/${totalModels}: deleted ${deleted} elements`);

            await prisma.model.delete({ where: { id: modelId } }).catch(() => {});
            await sleep(30);
        }

        await prisma.projectMember.deleteMany({ where: { projectId } }).catch(() => {});

        await prisma.project.delete({ where: { id: projectId } });
        console.log(`[Delete ${projectId}] Project record deleted`);

        await prisma.projectDeletion.deleteMany({
            where: { projectId, id: { not: jobId } },
        }).catch(() => {});

        sendUpdate('COMPLETED', 100, 'Project deleted successfully');
        console.log(`[Delete ${projectId}] ✅ Completed successfully`);

        await prisma.$disconnect();
        process.exit(0);

    } catch (error) {
        console.error(`[Delete ${data.projectId}] ❌ Deletion failed:`, error);
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
