import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authenticateToken } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

console.log('🔄 Loading QR Code Routes...');

/**
 * POST /api/qr-codes/generate
 * Generate or retrieve existing QR code for a panel
 */
router.post('/generate', authenticateToken, async (req: Request, res: Response) => {
    try {
        const { panelId, projectId } = req.body;

        if (!panelId || !projectId) {
            return res.status(400).json({
                error: 'Missing required fields',
                message: 'panelId and projectId are required'
            });
        }

        // Try to find panel by ID (CUID)
        let panel = await prisma.panel.findUnique({
            where: { id: panelId },
            select: { id: true, projectId: true, name: true, tag: true }
        });

        // If not found by CUID, try to find by Express ID (via ModelElement)
        if (!panel) {
            const expressId = parseInt(panelId);
            if (!isNaN(expressId)) {
                // Try via ModelElement relation first
                panel = await prisma.panel.findFirst({
                    where: {
                        projectId: parseInt(projectId),
                        element: {
                            expressId: expressId
                        }
                    },
                    select: { id: true, projectId: true, name: true, tag: true }
                });

                // If still not found, try via metadata.ifcElementId (JSON field)
                if (!panel) {
                    panel = await prisma.panel.findFirst({
                        where: {
                            projectId: parseInt(projectId),
                            metadata: {
                                path: ['ifcElementId'],
                                equals: panelId.toString()
                            }
                        },
                        select: { id: true, projectId: true, name: true, tag: true }
                    });
                }
            }
        }

        if (!panel) {
            return res.status(404).json({
                error: 'Panel not found',
                message: `Panel with ID ${panelId} does not exist in the database. Please ensure the model is fully processed.`
            });
        }

        if (panel.projectId !== parseInt(projectId)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: 'Panel does not belong to the specified project'
            });
        }

        // Use the CUID from the found panel
        const targetPanelId = panel.id;

        // Check if QR code already exists for this panel
        let qrCode = await prisma.qRCode.findUnique({
            where: { panelId: targetPanelId }
        });

        // If QR code doesn't exist, create a new one
        if (!qrCode) {
            qrCode = await prisma.qRCode.create({
                data: {
                    panelId: targetPanelId,
                    projectId: parseInt(projectId),
                    isActive: true,
                    scanCount: 0
                }
            });

            console.log(`✅ Created new QR code for panel ${targetPanelId}: ${qrCode.id}`);
        } else {
            console.log(`♻️ Retrieved existing QR code for panel ${targetPanelId}: ${qrCode.id}`);
        }

        return res.status(200).json({
            success: true,
            qrCode: {
                id: qrCode.id,
                panelId: qrCode.panelId,
                projectId: qrCode.projectId,
                isActive: qrCode.isActive,
                scanCount: qrCode.scanCount,
                createdAt: qrCode.createdAt
            },
            panel: {
                name: panel.name,
                tag: panel.tag
            }
        });

    } catch (error) {
        console.error('Error generating QR code:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: 'Failed to generate QR code'
        });
    }
});

/**
 * GET /api/qr-codes/panel/:panelId
 * Get QR code for a specific panel
 */
router.get('/panel/:panelId', authenticateToken, async (req: Request, res: Response) => {
    try {
        const { panelId } = req.params;

        const qrCode = await prisma.qRCode.findUnique({
            where: { panelId: panelId }
        });

        if (!qrCode) {
            return res.status(404).json({
                error: 'QR code not found',
                message: `No QR code exists for panel ${panelId}`
            });
        }

        return res.status(200).json({
            success: true,
            qrCode: {
                id: qrCode.id,
                panelId: qrCode.panelId,
                projectId: qrCode.projectId,
                isActive: qrCode.isActive,
                scanCount: qrCode.scanCount,
                createdAt: qrCode.createdAt
            }
        });

    } catch (error) {
        console.error('Error fetching QR code:', error);
        return res.status(500).json({
            error: 'Internal server error',
            message: 'Failed to fetch QR code'
        });
    }
});

/**
 * GET /qr/:qrCodeId
 * Public redirect endpoint - logs scan and redirects to element report
 * This endpoint is PUBLIC (no authentication required)
 */
router.get('/:qrCodeId', async (req: Request, res: Response) => {
    try {
        const { qrCodeId } = req.params;

        // Find the QR code
        const qrCode = await prisma.qRCode.findUnique({
            where: { id: qrCodeId },
            include: {
                scans: {
                    orderBy: { scannedAt: 'desc' },
                    take: 1
                }
            }
        });

        if (!qrCode) {
            return res.status(404).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>QR Code Not Found</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              h1 { color: #e74c3c; }
            </style>
          </head>
          <body>
            <h1>QR Code Not Found</h1>
            <p>This QR code does not exist or has been deleted.</p>
          </body>
        </html>
      `);
        }

        // Check if QR code is active
        if (!qrCode.isActive) {
            return res.status(410).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>QR Code Inactive</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              h1 { color: #f39c12; }
            </style>
          </head>
          <body>
            <h1>QR Code Inactive</h1>
            <p>This QR code has been deactivated.</p>
          </body>
        </html>
      `);
        }

        // Check if QR code has expired
        if (qrCode.expiresAt && new Date() > qrCode.expiresAt) {
            return res.status(410).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>QR Code Expired</title>
            <style>
              body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
              h1 { color: #f39c12; }
            </style>
          </head>
          <body>
            <h1>QR Code Expired</h1>
            <p>This QR code has expired.</p>
          </body>
        </html>
      `);
        }

        // Log the scan
        const userAgent = req.headers['user-agent'] || 'Unknown';
        const ipAddress = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
            req.socket.remoteAddress ||
            'Unknown';

        await prisma.qRScan.create({
            data: {
                qrCodeId: qrCode.id,
                userAgent: userAgent,
                ipAddress: ipAddress
            }
        });

        // Increment scan count
        await prisma.qRCode.update({
            where: { id: qrCode.id },
            data: { scanCount: { increment: 1 } }
        });

        console.log(`📱 QR code scanned: ${qrCode.id} | Panel: ${qrCode.panelId} | IP: ${ipAddress}`);

        // Get panel details to find the correct ID for redirection (frontend expects local ID/express ID)
        const panel = await prisma.panel.findUnique({
            where: { id: qrCode.panelId },
            include: { element: true }
        });

        let redirectId = qrCode.panelId; // Default to CUID

        if (panel) {
            // Prefer metadata.ifcElementId (as string) - this matches what frontend expects
            if ((panel.metadata as any)?.ifcElementId) {
                redirectId = (panel.metadata as any).ifcElementId;
            }
            // Or element.expressId
            else if (panel.element?.expressId) {
                redirectId = panel.element.expressId.toString();
            }
        }

        // Redirect to element report page
        const redirectUrl = `${process.env.CORS_ORIGIN}/projects/${qrCode.projectId}/element-report/${redirectId}`;
        res.redirect(redirectUrl);

    } catch (error) {
        console.error('Error processing QR code scan:', error);
        return res.status(500).send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Error</title>
          <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
            h1 { color: #e74c3c; }
          </style>
        </head>
        <body>
          <h1>Error</h1>
          <p>An error occurred while processing this QR code.</p>
        </body>
      </html>
    `);
    }
});

export default router;
