import dotenvFlow from "dotenv-flow";

// dotenv-flow omits .env.local for NODE_ENV=test by default. Tests opt into
// local settings while retaining dedicated test files as the final override.
dotenvFlow.config({
  files: [".env", ".env.local", ".env.test", ".env.test.local"],
});
