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
await client.query(`ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL`);
await client.query(`ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "google_id" varchar(255)`);
await client.query(
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_provider" varchar(32) DEFAULT 'email' NOT NULL`,
);
await client.query(
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_google_id_unique" ON "users" ("google_id")`,
);
console.log("OAuth schema applied");
await client.end();
