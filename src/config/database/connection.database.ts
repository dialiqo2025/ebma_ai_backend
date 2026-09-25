import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import "dotenv/config";
import schema from "../database/schema";

// Create PostgreSQL pool
export const pool = new Pool({
  user: process.env.DATABASE_USER,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASS,
  port: Number(process.env.DATABASE_PORT),
  ssl: {
    rejectUnauthorized: false, // Aiven
  },
});

// Drizzle instance
export const db = drizzle(pool, { schema });

/**
 * Explicit DB authentication check
 */
export const connectDB = async () => {
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    console.log("✅ Database authenticated successfully");
  } catch (error) {
    console.error("❌ Database authentication failed");
    console.error(error);
    process.exit(1);
  }
};

// Pool events (optional but fine)
pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL error", err);
  process.exit(1);
});
