import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

async function main() {
  logger.info('Starting database seeding...');

  const org = await prisma.organization.upsert({
    where: { slug: 'uniqube-default' },
    update: {},
    create: {
      name: 'Uniqube Default Organization',
      slug: 'uniqube-default',
      description: 'Default organization for Uniqube 3D platform',
    },
  });

  const adminPassword = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@uniqube.com' },
    update: { passwordHash: adminPassword },
    create: {
      email: 'admin@uniqube.com',
      passwordHash: adminPassword,
      name: 'Admin User',
      role: 'ADMIN',
      organizationId: org.id,
      createdBy: null,
    },
  });

  const demoPassword = await bcrypt.hash('demo123', 12);
  const demoUser = await prisma.user.upsert({
    where: { email: 'demo@uniqube.com' },
    update: { passwordHash: demoPassword },
    create: {
      email: 'demo@uniqube.com',
      passwordHash: demoPassword,
      name: 'Demo User',
      role: 'VIEWER',
      organizationId: org.id,
      createdBy: null,
    },
  });

  const project1 = await prisma.project.upsert({
    where: {
      organizationId_displayNumber: {
        organizationId: org.id,
        displayNumber: 1,
      },
    },
    update: {},
    create: {
      displayNumber: 1,
      name: 'Office Building Complex',
      description: 'Modern office building with sustainable design features',
      status: 'ACTIVE',
      createdBy: demoUser.id,
      organizationId: org.id,
      metadata: {
        location: 'San Francisco, CA',
        architect: 'Green Design Studio',
        contractor: 'BuildCorp Inc',
        startDate: '2024-01-15',
        expectedCompletion: '2024-12-31',
      },
    },
  });

  const project2 = await prisma.project.upsert({
    where: {
      organizationId_displayNumber: {
        organizationId: org.id,
        displayNumber: 2,
      },
    },
    update: {},
    create: {
      displayNumber: 2,
      name: 'Residential Tower',
      description: 'High-rise residential building with mixed-use ground floor',
      status: 'PLANNING',
      createdBy: demoUser.id,
      organizationId: org.id,
      metadata: {
        location: 'New York, NY',
        architect: 'Urban Living Designs',
        contractor: 'Metro Construction',
        startDate: '2024-06-01',
        expectedCompletion: '2025-08-31',
      },
    },
  });

  await prisma.projectMember.upsert({
    where: {
      projectId_userId: { projectId: project1.id, userId: demoUser.id },
    },
    update: {},
    create: {
      projectId: project1.id,
      userId: demoUser.id,
      role: 'OWNER',
    },
  });

  await prisma.projectMember.upsert({
    where: {
      projectId_userId: { projectId: project2.id, userId: demoUser.id },
    },
    update: {},
    create: {
      projectId: project2.id,
      userId: demoUser.id,
      role: 'OWNER',
    },
  });

  await prisma.projectMember.upsert({
    where: {
      projectId_userId: { projectId: project1.id, userId: admin.id },
    },
    update: {},
    create: {
      projectId: project1.id,
      userId: admin.id,
      role: 'OWNER',
    },
  });

  await prisma.projectMember.upsert({
    where: {
      projectId_userId: { projectId: project2.id, userId: admin.id },
    },
    update: {},
    create: {
      projectId: project2.id,
      userId: admin.id,
      role: 'OWNER',
    },
  });

  const groups = [
    {
      id: 'group-structural',
      projectId: project1.id,
      name: 'Structural Elements',
      description: 'All structural components including beams, columns, and slabs',
      status: 'COMPLETED' as const,
      color: '#3B82F6',
      metadata: {
        category: 'Structure',
        priority: 'High',
        responsible: 'Structural Team',
      },
    },
    {
      id: 'group-mep',
      projectId: project1.id,
      name: 'MEP Systems',
      description: 'Mechanical, Electrical, and Plumbing systems',
      status: 'IN_PROGRESS' as const,
      color: '#10B981',
      metadata: {
        category: 'MEP',
        priority: 'Medium',
        responsible: 'MEP Team',
      },
    },
    {
      id: 'group-facade',
      projectId: project1.id,
      name: 'Facade Elements',
      description: 'Exterior facade components and glazing systems',
      status: 'PENDING' as const,
      color: '#F59E0B',
      metadata: {
        category: 'Architecture',
        priority: 'Medium',
        responsible: 'Facade Team',
      },
    },
  ];

  for (const group of groups) {
    await prisma.group.upsert({
      where: { id: group.id },
      update: {},
      create: group,
    });
  }

  const existingNotifications = await prisma.notification.count({
    where: { organizationId: org.id },
  });
  if (existingNotifications === 0) {
    await prisma.notification.createMany({
      data: [
        {
          userId: demoUser.id,
          organizationId: org.id,
          type: 'SYSTEM',
          title: 'Welcome to Uniqube 3D',
          message:
            'Your account has been set up successfully. Start by uploading your first IFC model.',
          metadata: { category: 'welcome', actionUrl: '/projects' },
        },
        {
          userId: demoUser.id,
          organizationId: org.id,
          type: 'PROJECT_UPDATE',
          title: 'Project Status Updated',
          message: 'Office Building Complex project status changed to Active',
          metadata: {
            projectId: project1.id,
            projectName: project1.name,
            oldStatus: 'planning',
            newStatus: 'active',
          },
        },
        {
          userId: demoUser.id,
          organizationId: org.id,
          type: 'GROUP_STATUS_CHANGE',
          title: 'Group Completed',
          message: 'Structural Elements group has been marked as completed',
          read: true,
          metadata: {
            projectId: project1.id,
            groupId: 'group-structural',
            groupName: 'Structural Elements',
            status: 'completed',
          },
        },
        {
          userId: admin.id,
          organizationId: org.id,
          type: 'SYSTEM',
          title: 'System Initialized',
          message:
            'Uniqube 3D backend system has been successfully initialized with sample data.',
          metadata: {
            category: 'system',
            users: 2,
            projects: 2,
            groups: 3,
          },
        },
      ],
    });
  }

  logger.info('Database seeding completed successfully.');
  logger.info('Sample accounts: admin@uniqube.com / admin123, demo@uniqube.com / demo123');
}

main()
  .catch((e) => {
    logger.error('Error seeding database:', e);
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
