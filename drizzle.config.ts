/**
 * drizzle-kit config for the invocation log store. Used ONLY at
 * development time to generate SQL migrations from `src/logs/schema.ts`:
 *
 *   npx drizzle-kit generate            # diff schema → new migration
 *   npx drizzle-kit generate --custom   # empty migration for hand-written SQL
 *
 * The gateway applies the generated `drizzle/` folder at boot; nothing
 * here runs in production.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/logs/schema.ts",
  out: "./drizzle",
});
