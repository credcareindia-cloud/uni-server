# Uniqube 3D Backend

A robust backend API for 3D FRAG file management and instant viewing, built with Node.js, Express, and TypeScript.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- Docker & Docker Compose
- Git

### 1. Setup Environment
```bash
cd backend
cp .env.example .env
# Edit .env with your configuration
```

### 2. Start Services
```bash
# Start PostgreSQL, Redis, and MinIO
docker-compose up -d

# Install dependencies
npm install

# Generate Prisma client
npm run db:generate

# Run database migrations
npm run db:migrate

# Seed sample data
npm run db:seed
```

### 3. Start Development
```bash
# Start API server
npm run dev

# In another terminal, start worker
npm run worker
```

The API will be available at `http://localhost:4000`

## 📋 Sample Accounts

After seeding, you can use these accounts:
- **Admin**: `admin@uniqube.com` / `admin123`
- **Demo**: `demo@uniqube.com` / `demo123`

## 🏗️ Architecture

### Core Services
- **PostgreSQL**: Primary database for metadata, users, projects
- **Redis**: Job queue for background processing
- **MinIO**: S3-compatible storage for IFC/FRAG files (local dev)
- **Express API**: RESTful API with JWT authentication
- **BullMQ Worker**: Background IFC processing

### Key Features
- **Real-time IFC Processing**: Extract metadata, spatial structure, and properties
- **Progressive Upload**: Support for large files (up to 5GB)
- **Live Progress Updates**: SSE endpoints for real-time status
- **Type-safe Database**: Prisma ORM with full TypeScript support
- **AWS-Ready**: Easy migration to RDS, S3, SQS

## 📡 API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user
- `PUT /api/auth/profile` - Update profile
- `POST /api/auth/change-password` - Change password

### Projects
- `GET /api/projects` - List user projects
- `POST /api/projects` - Create project
- `GET /api/projects/:id` - Get project details
- `PUT /api/projects/:id` - Update project
- `DELETE /api/projects/:id` - Delete project

### Models
- `GET /api/models/:id` - Get model details
- `GET /api/models/:id/elements` - List model elements
- `GET /api/models/:id/elements/:expressId` - Get element details
- `GET /api/models/:id/summary` - Get model summary
- `GET /api/models/:id/progress` - Real-time progress (SSE)
- `DELETE /api/models/:id` - Delete model

### File Upload
- `POST /api/uploads/initiate` - Start file upload
- `POST /api/uploads/complete` - Complete upload & start processing
- `POST /api/uploads/multipart/initiate` - Multipart upload (large files)
- `GET /api/uploads/status/:modelId` - Upload status

### Notifications
- `GET /api/notifications` - List notifications
- `PATCH /api/notifications/mark-read` - Mark as read
- `DELETE /api/notifications/:id` - Delete notification
- `GET /api/notifications/unread-count` - Unread count

## 🔧 Configuration

### Environment Variables
```bash
# Database
DATABASE_URL="postgresql://postgres:postgres123@localhost:5432/uniqube3d"

# Redis
REDIS_URL="redis://localhost:6379"

# JWT
JWT_SECRET="your-super-secret-jwt-key"
JWT_EXPIRES_IN="7d"

# Storage (MinIO local, S3 production)
STORAGE_ENDPOINT="http://localhost:9000"  # Empty for AWS S3
STORAGE_REGION="us-east-1"
STORAGE_ACCESS_KEY="minio"
STORAGE_SECRET_KEY="minio123"
STORAGE_BUCKET="models"
STORAGE_FORCE_PATH_STYLE="true"  # false for AWS S3

# Server
PORT=4000
NODE_ENV="development"
CORS_ORIGIN="http://localhost:3000"
```

### Docker Services
- **PostgreSQL**: `localhost:5432`
- **Redis**: `localhost:6379`
- **MinIO**: `localhost:9000` (API), `localhost:9001` (Console)
- **pgAdmin**: `localhost:5050` (optional, use `--profile tools`)

## 🔄 Development Workflow

### Database Changes
```bash
# Create migration
npx prisma migrate dev --name your-migration-name

# Reset database
npx prisma migrate reset

# View database
npm run db:studio
```

### File Processing
1. **Upload**: Client gets signed URL, uploads to MinIO/S3
2. **Processing**: Worker extracts IFC metadata in batches
3. **Progress**: Real-time updates via SSE
4. **Completion**: Model marked as ready, notification sent

### Queue Management
```bash
# Monitor Redis
redis-cli monitor

# View queue status
# Access BullMQ dashboard at http://localhost:3000/admin/queues (if installed)
```

## 🚀 Production Deployment

### AWS Migration
1. **Database**: PostgreSQL → RDS Postgres
2. **Storage**: MinIO → S3
3. **Queue**: Redis → ElastiCache Redis
4. **Compute**: Docker → ECS/Fargate

### Environment Changes
```bash
# Production .env
DATABASE_URL="postgresql://user:pass@rds-endpoint:5432/uniqube3d"
REDIS_URL="redis://elasticache-endpoint:6379"
STORAGE_ENDPOINT=""  # Empty for S3
STORAGE_BUCKET="uniqube-models-prod"
STORAGE_FORCE_PATH_STYLE="false"
```

### Scaling Considerations
- **Connection Pooling**: Use PgBouncer for database connections
- **Worker Scaling**: Run multiple worker instances
- **CDN**: CloudFront for model file delivery
- **Monitoring**: CloudWatch, Datadog, or similar

## 🧪 Testing

```bash
# Run tests
npm test

# Test API endpoints
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@uniqube.com","password":"demo123"}'
```

## 📊 Monitoring

### Health Checks
- `GET /health` - API health status
- Database connection status
- Redis connection status
- Storage service status

### Logging
- Structured JSON logs
- Different log levels (ERROR, WARN, INFO, DEBUG)
- File logging in production
- Request/response logging with Morgan

## 🔒 Security

- **JWT Authentication**: Secure token-based auth
- **Password Hashing**: bcrypt with salt rounds
- **Rate Limiting**: Express rate limiter
- **CORS**: Configurable origins
- **Helmet**: Security headers
- **Input Validation**: Zod schemas
- **File Upload**: Size limits and type validation

## 🐛 Troubleshooting

### Common Issues
1. **Database Connection**: Check PostgreSQL is running
2. **Redis Connection**: Verify Redis service
3. **File Upload**: Check MinIO credentials and bucket
4. **Worker Not Processing**: Ensure Redis connection and worker running
5. **Large Files**: Increase timeout and memory limits

### Debug Mode
```bash
LOG_LEVEL=DEBUG npm run dev
```

## 📚 Additional Resources

- [Prisma Documentation](https://www.prisma.io/docs/)
- [BullMQ Documentation](https://docs.bullmq.io/)
- [web-ifc Documentation](https://github.com/ThatOpen/engine_web-ifc)
- [MinIO Documentation](https://docs.min.io/)

## 🤝 Contributing

1. Fork the repository
2. Create feature branch
3. Make changes with tests
4. Submit pull request

## 📄 License

MIT License - see LICENSE file for details
