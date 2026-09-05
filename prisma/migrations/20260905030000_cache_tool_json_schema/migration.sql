-- Hand-written per CLEANROOM.md (never `db push`, never generated from
-- another project's migrations). Additive: caches the JSON Schema derived
-- from Tool.paramsZod at registration time, instead of re-deriving it
-- (spinning a fresh QuickJS runtime per attached tool) on every run.
-- Mirrors prisma/schema.prisma exactly.

-- AlterTable
-- DEFAULT '{}' only satisfies any pre-existing rows during the ALTER; the
-- application always supplies a real derived schema on every future
-- insert (Tool has no update path), so the default is dropped immediately
-- after and never relied upon going forward.
ALTER TABLE "Tool" ADD COLUMN "jsonSchema" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "Tool" ALTER COLUMN "jsonSchema" DROP DEFAULT;
