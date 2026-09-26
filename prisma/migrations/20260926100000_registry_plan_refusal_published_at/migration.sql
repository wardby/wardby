-- Additive: a too-new plan refusal keeps the version's publish time, so the
-- answer re-checks the age at answer time and the refusal lapses.

-- AlterTable
ALTER TABLE "RegistryPlanRefusal" ADD COLUMN     "publishedAt" TIMESTAMP(3);
