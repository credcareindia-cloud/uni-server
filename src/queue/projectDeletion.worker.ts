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

        // ── Step 1: Delete QR Codes (no cascade from project, must be manual) ─
        sendUpdate('IN_PROGRESS', 10, 'Deleting QR codes...');
        const qrDeleted = await prisma.$executeRaw`
            DELETE FROM "qr_codes" WHERE "project_id" = ${projectId}
        `;
        console.log(`[Delete ${projectId}] QR codes deleted: ${qrDeleted}`);

        // ── Step 2: Delete UserPanelViews (no cascade from panel/project) ─────
        sendUpdate('IN_PROGRESS', 20, 'Deleting user panel views...');
        const viewsDeleted = await prisma.$executeRaw`
            DELETE FROM "user_panel_views"
            WHERE "panel_id" IN (
                SELECT "id" FROM "panels" WHERE "project_id" = ${projectId}
            )
        `;
        console.log(`[Delete ${projectId}] User panel views deleted: ${viewsDeleted}`);

        // ── Step 3: NULL out project.current_model_id to allow project delete ─
        // The Project has a @unique FK to Model via current_model_id.
        // We must null it out first so the cascading delete of models doesn't
        // conflict with the unique constraint.
        sendUpdate('IN_PROGRESS', 30, 'Preparing model references...');
        await prisma.$executeRaw`
            UPDATE "projects" SET "current_model_id" = NULL WHERE "id" = ${projectId}
        `;

        // ── Step 4: Delete Models (cascades ModelElements automatically) ──────
        // We delete models one by one so large projects don't hit a single
        // massive cascade. Each model may have 20k+ elements.
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

            // Delete model elements first (bypasses cascade, instant indexed delete)
            const elementsDeleted = await prisma.$executeRaw`
                DELETE FROM "model_elements" WHERE "model_id" = ${modelId}
            `;
            console.log(`[Delete ${projectId}] Model ${i + 1}/${totalModels}: deleted ${elementsDeleted} elements`);

            // Delete the model shell itself (idempotent — ignore if already gone)
            await prisma.$executeRaw`
                DELETE FROM "models" WHERE "id" = ${modelId}
            `;

            await sleep(30); // Breathing room between models
        }

        // ── Step 5: Delete the Project (cascades everything else) ─────────────
        // At this point: QRCodes, UserPanelViews, and ModelElements/Models are gone.
        // Postgres will now cascade-delete: Panels → PanelStatuses/Groups/History,
        // Groups, Statuses, ProjectMembers, etc.
        sendUpdate('IN_PROGRESS', 85, 'Finalizing project deletion...');
        const projectDeleted = await prisma.$executeRaw`
            DELETE FROM "projects" WHERE "id" = ${projectId}
        `;
        console.log(`[Delete ${projectId}] Project deleted: ${projectDeleted} row(s)`);

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
