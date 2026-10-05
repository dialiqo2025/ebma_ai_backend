import "dotenv/config";
import pg from "pg";

const client = new pg.Client({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASS,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
});

await client.connect();
await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "microsoft_id" varchar(255)`);
await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "apple_id" varchar(255)`);
await client.query(
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_microsoft_id_unique" ON "users" ("microsoft_id")`,
);
await client.query(
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_apple_id_unique" ON "users" ("apple_id")`,
);
console.log("microsoft/apple oauth columns ready");
await client.end();
