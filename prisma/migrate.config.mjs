// Prisma CLI configuration shipped in the npm package for `wardby quickstart`
// and `wardby doctor` (src/quickstart/migrate.ts). The installed package has
// no Prisma CLI -- it is a devDependency -- so quickstart runs the pinned CLI
// on demand (`npx --yes prisma@<version> migrate deploy|status --config
// <this file>`).
//
// Deliberately import-free: the CLI loads this file from the installed
// package, where neither `prisma/config` nor dotenv-flow is resolvable. A plain
// object is accepted in place of defineConfig(). Paths are resolved relative
// to this file, so they point at the schema and migrations shipped beside it.
//
// The URL comes from the environment quickstart passes to the child process
// (never from argv): the .wardby/.env DATABASE_URL.
export default {
  schema: "schema.prisma",
  migrations: { path: "migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
};
