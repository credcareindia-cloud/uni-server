-- CreateEnum
CREATE TYPE "BuildSystem" AS ENUM ('LGS', 'PRECAST', 'HYBRID');

-- CreateEnum
CREATE TYPE "ComponentType" AS ENUM (
  'LGS_WALL_LB',
  'LGS_WALL_NLB',
  'LGS_FLOOR_TRUSS',
  'LGS_ROOF_TRUSS',
  'PRECAST_WALL',
  'PRECAST_FOOTING',
  'HOLLOWCORE_SLAB',
  'TIE_BEAM',
  'LEVELING_PAD',
  'POD',
  'CONNECTOR',
  'OTHER'
);

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "build_system" "BuildSystem" NOT NULL DEFAULT 'LGS';

-- AlterTable
ALTER TABLE "panels" ADD COLUMN "component_type" "ComponentType";
