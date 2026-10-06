import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, "../drizzle/0023_enterprise_custom_plans.sql");
const sql = fs.readFileSync(sqlPath, "utf8");

const client = new pg.Client({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASS,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

await client.connect();
for (const statement of sql.split("--> statement-breakpoint")) {
  const trimmed = statement.trim();
  if (trimmed) await client.query(trimmed);
}
console.log("enterprise custom plans migration applied");
await client.end();
