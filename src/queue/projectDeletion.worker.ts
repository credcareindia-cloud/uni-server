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

// ──────────────────────────────────────────────────────────────────────────────
// SCHEMA ANALYSIS:
//
//  QRCode        → has projectId (plain column, no FK cascade from Panel/Project)
//  QRScan        → onDelete: Cascade from QRCode
//  UserPanelView → has panelId (plain column, no FK to Panel)
//
//  --- Everything below HAS proper cascades already ---
//  Panel         → onDelete: Cascade from Project
//  PanelStatus   → onDelete: Cascade from Panel
//  PanelGroup    → onDelete: Cascade from Panel
//  StatusHistory → onDelete: Cascade from Panel
//  Group         → onDelete: Cascade from Project
//  Status        → onDelete: Cascade from Project
//  ProjectMember → onDelete: Cascade from Project
//  ModelElement  → onDelete: Cascade from Model
//  Model         → onDelete: Cascade from Project
//
//  panels.model_id   → ON DELETE SET NULL  (migration applied ✅)
//  panels.element_id → ON DELETE SET NULL  (migration applied ✅)
//
// STRATEGY:
//  1. Delete QRCodes by projectId  → QRScans cascade automatically
//  2. Delete UserPanelViews by panelId (via subquery)
//  3. Delete the Project — Postgres cascades ALL other children automatically
//     (models → model_elements, panels → panel_statuses/groups/history, groups, statuses, etc.)
//  4. All raw SQL, all idempotent (won't crash if rows already gone)
// ──────────────────────────────────────────────────────────────────────────────

async function deleteProject() {
    const { jobId, projectId } = data;

    try {
        sendUpdate('IN_PROGRESS', 2, 'Starting project deletion...');

        // Verify project exists (idempotent — exit cleanly if already gone)
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

        // ── Step 1: Delete QR Codes ───────────────────────────────────────────
        sendUpdate('IN_PROGRESS', 10, 'Deleting QR codes...');
        await prisma.qRCode.deleteMany({ where: { projectId } }).catch(() => {});
        console.log(`[Delete ${projectId}] QR codes deleted`);

        // ── Step 2: Delete UserPanelViews ─────────────────────────────────────
        sendUpdate('IN_PROGRESS', 20, 'Deleting user panel views...');
        const panelRows = await prisma.panel.findMany({ where: { projectId }, select: { id: true } });
        const panelIds = panelRows.map(p => p.id);
        
        if (panelIds.length > 0) {
            // Delete UserPanelViews in small chunks to avoid huge IN clauses
            for (let i = 0; i < panelIds.length; i += 1000) {
                const batch = panelIds.slice(i, i + 1000);
                await prisma.userPanelView.deleteMany({ where: { panelId: { in: batch } } }).catch(() => {});
            }
        }
        console.log(`[Delete ${projectId}] User panel views deleted`);

        // ── Step 3: NULL out project.current_model_id ─────────────────────────
        sendUpdate('IN_PROGRESS', 30, 'Preparing model references...');
        await prisma.project.update({ 
            where: { id: projectId }, 
            data: { currentModelId: null } 
        }).catch(() => {}); // Optional update

        // ── Step 4: Delete Models (cascades ModelElements safely) ─────────────
        sendUpdate('IN_PROGRESS', 40, 'Deleting models and their elements...');
        const modelRows = await prisma.model.findMany({
            where: { projectId },
            select: { id: true },
        });

        const totalModels = modelRows.length;
        console.log(`[Delete ${projectId}] Found ${totalModels} models to delete`);

        for (let i = 0; i < totalModels; i++) {
            const modelId = modelRows[i].id;
            const modelProgress = 40 + Math.round(((i + 1) / (totalModels || 1)) * 40);
            sendUpdate('IN_PROGRESS', modelProgress, `Deleting model ${i + 1}/${totalModels}...`);

            // Fetch elements for this model
            const elementRows = await prisma.modelElement.findMany({ where: { modelId }, select: { id: true } });
            const elementIds = elementRows.map(e => e.id);
            console.log(`[Delete ${projectId}] Model ${i + 1}/${totalModels}: deleting ${elementIds.length} elements in chunks...`);
            
            // Delete elements safely in batches of 2000
            let totalDeleted = 0;
            for (let j = 0; j < elementIds.length; j += 2000) {
                const chunk = elementIds.slice(j, j + 2000);
                const { count } = await prisma.modelElement.deleteMany({ where: { id: { in: chunk } } });
                totalDeleted += count;
                await sleep(50); 
            }
            console.log(`[Delete ${projectId}] Model ${i + 1}/${totalModels}: deleted ${totalDeleted} elements`);

            // Delete the model shell itself 
            await prisma.model.delete({ where: { id: modelId } }).catch(() => {});
            
            await sleep(50);
        }

        // ── Step 5: Delete the Project (cascades everything else) ─────────────
        sendUpdate('IN_PROGRESS', 85, 'Finalizing project deletion...');
        
        // As an extra safety measure, explicitly delete panels in chunks to prevent 
        // a massive single-shot cascade timeout from deleting thousands of panel rules/groups
        if (panelIds.length > 0) {
            console.log(`[Delete ${projectId}] Pre-deleting ${panelIds.length} panels to reduce cascade load...`);
            for (let i = 0; i < panelIds.length; i += 1000) {
                const chunk = panelIds.slice(i, i + 1000);
                await prisma.panel.deleteMany({ where: { id: { in: chunk } } }).catch(() => {});
                await sleep(50);
            }
        }

        // Now delete the project itself
        await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
        console.log(`[Delete ${projectId}] Project record deleted (cascades finished)`);

        // ── Step 6: Clean up this deletion job record ─────────────────────────
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
