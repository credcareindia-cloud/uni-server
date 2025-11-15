// import { PrismaClient } from '@prisma/client';
// import bcrypt from 'bcryptjs';
// import { logger } from '../utils/logger.js';

// const prisma = new PrismaClient();

// async function main() {
//   logger.info('🌱 Starting database seeding...');

//   try {
//     // Create organization
//     const org = await prisma.organization.upsert({
//       where: { slug: 'uniqube-default' },
//       update: {},
//       create: {
//         name: 'Uniqube Default Organization',
//         slug: 'uniqube-default',
//         description: 'Default organization for Uniqube 3D platform'
//       }
//     });

//     logger.info(`✅ Organization created: ${org.name}`);

//     // Create admin user
//     const adminPassword = await bcrypt.hash('admin123', 12);
//     const admin = await prisma.user.upsert({
//       where: { email: 'admin@uniqube.com' },
//       update: {},
//       create: {
//         email: 'admin@uniqube.com',
//         passwordHash: adminPassword,
//         name: 'Admin User',
//         role: 'ADMIN',
//         organizationId: org.id,
//       },
//     });

//     logger.info(`✅ Admin user created: ${admin.email}`);

//     // Create demo user
//     const demoPassword = await bcrypt.hash('demo123', 12);
//     const demoUser = await prisma.user.upsert({
//       where: { email: 'demo@uniqube.com' },
//       update: {},
//       create: {
//         email: 'demo@uniqube.com',
//         passwordHash: demoPassword,
//         name: 'Demo User',
//         role: 'VIEWER',
//         organizationId: org.id,
//       },
//     });

//     logger.info(`✅ Demo user created: ${demoUser.email}`);

//     // Create sample projects
//     const project1 = await prisma.project.upsert({
//       where: { id: 1 },
//       update: {},
//       create: {
//         name: 'Office Building Complex',
//         description: 'Modern office building with sustainable design features',
//         status: 'ACTIVE',
//         createdBy: demoUser.id,
//         organizationId: org.id,
//         metadata: {
//           location: 'San Francisco, CA',
//           architect: 'Green Design Studio',
//           contractor: 'BuildCorp Inc',
//           startDate: '2024-01-15',
//           expectedCompletion: '2024-12-31'
//         }
//       },
//     });

//     const project2 = await prisma.project.upsert({
//       where: { id: 2 },
//       update: {},
//       create: {
//         name: 'Residential Tower',
//         description: 'High-rise residential building with mixed-use ground floor',
//         status: 'PLANNING',
//         createdBy: demoUser.id,
//         organizationId: org.id,
//         metadata: {
//           location: 'New York, NY',
//           architect: 'Urban Living Designs',
//           contractor: 'Metro Construction',
//           startDate: '2024-06-01',
//           expectedCompletion: '2025-08-31'
//         }
//       },
//     });

//     logger.info(`✅ Sample projects created: ${project1.name}, ${project2.name}`);

//     // Add demo user as project member (OWNER role)
//     await prisma.projectMember.upsert({
//       where: {
//         projectId_userId: {
//           projectId: project1.id,
//           userId: demoUser.id
//         }
//       },
//       update: {},
//       create: {
//         projectId: project1.id,
//         userId: demoUser.id,
//         role: 'OWNER'
//       }
//     });

//     await prisma.projectMember.upsert({
//       where: {
//         projectId_userId: {
//           projectId: project2.id,
//           userId: demoUser.id
//         }
//       },
//       update: {},
//       create: {
//         projectId: project2.id,
//         userId: demoUser.id,
//         role: 'OWNER'
//       }
//     });

//     // Add admin user as project member (OWNER role)
//     await prisma.projectMember.upsert({
//       where: {
//         projectId_userId: {
//           projectId: project1.id,
//           userId: admin.id
//         }
//       },
//       update: {},
//       create: {
//         projectId: project1.id,
//         userId: admin.id,
//         role: 'OWNER'
//       }
//     });

//     await prisma.projectMember.upsert({
//       where: {
//         projectId_userId: {
//           projectId: project2.id,
//           userId: admin.id
//         }
//       },
//       update: {},
//       create: {
//         projectId: project2.id,
//         userId: admin.id,
//         role: 'OWNER'
//       }
//     });

//     logger.info(`✅ Demo user and Admin user added as project members`);

//     // Create sample groups for project 1
//     const groups = [
//       {
//         id: 'group-structural',
//         projectId: project1.id,
//         name: 'Structural Elements',
//         description: 'All structural components including beams, columns, and slabs',
//         status: 'COMPLETED' as const,
//         metadata: {
//           category: 'Structure',
//           priority: 'High',
//           responsible: 'Structural Team'
//         }
//       },
//       {
//         id: 'group-mep',
//         projectId: project1.id,
//         name: 'MEP Systems',
//         description: 'Mechanical, Electrical, and Plumbing systems',
//         status: 'IN_PROGRESS' as const,
//         metadata: {
//           category: 'MEP',
//           priority: 'Medium',
//           responsible: 'MEP Team'
//         }
//       },
//       {
//         id: 'group-facade',
//         projectId: project1.id,
//         name: 'Facade Elements',
//         description: 'Exterior facade components and glazing systems',
//         status: 'PENDING' as const,
//         metadata: {
//           category: 'Architecture',
//           priority: 'Medium',
//           responsible: 'Facade Team'
//         }
//       }
//     ];

//     for (const group of groups) {
//       await prisma.group.upsert({
//         where: { id: group.id },
//         update: {},
//         create: group,
//       });
//     }

//     logger.info(`✅ Sample groups created: ${groups.length} groups`);

//     // Create sample notifications
//     const notifications = [
//       {
//         userId: demoUser.id,
//         type: 'SYSTEM' as const,
//         title: 'Welcome to Uniqube 3D',
//         message: 'Your account has been set up successfully. Start by uploading your first IFC model.',
//         metadata: {
//           category: 'welcome',
//           actionUrl: '/projects'
//         }
//       },
//       {
//         userId: demoUser.id,
//         type: 'PROJECT_UPDATE' as const,
//         title: 'Project Status Updated',
//         message: 'Office Building Complex project status changed to Active',
//         metadata: {
//           projectId: project1.id,
//           projectName: project1.name,
//           oldStatus: 'planning',
//           newStatus: 'active'
//         }
//       },
//       {
//         userId: demoUser.id,
//         type: 'GROUP_STATUS_CHANGE' as const,
//         title: 'Group Completed',
//         message: 'Structural Elements group has been marked as completed',
//         read: true,
//         metadata: {
//           projectId: project1.id,
//           groupId: 'group-structural',
//           groupName: 'Structural Elements',
//           status: 'completed'
//         }
//       }
//     ];

//     for (const notification of notifications) {
//       await prisma.notification.create({
//         data: notification,
//       });
//     }

//     logger.info(`✅ Sample notifications created: ${notifications.length} notifications`);

//     // Create admin notifications
//     await prisma.notification.create({
//       data: {
//         userId: admin.id,
//         type: 'SYSTEM',
//         title: 'System Initialized',
//         message: 'Uniqube 3D backend system has been successfully initialized with sample data.',
//         metadata: {
//           category: 'system',
//           users: 2,
//           projects: 2,
//           groups: 3
//         }
//       },
//     });

//     logger.info('🎉 Database seeding completed successfully!');
//     logger.info('');
//     logger.info('📋 Sample Accounts:');
//     logger.info('   Admin: admin@uniqube.com / admin123');
//     logger.info('   Demo:  demo@uniqube.com / demo123');
//     logger.info('');
//     logger.info('📁 Sample Projects:');
//     logger.info('   - Office Building Complex (Active)');
//     logger.info('   - Residential Tower (Planning)');
//     logger.info('');

//   } catch (error) {
//     logger.error('❌ Error seeding database:', error);
//     throw error;
//   } finally {
//     await prisma.$disconnect();
//   }
// }

// main()
//   .catch((e) => {
//     console.error(e);
//     process.exit(1);
//   });
