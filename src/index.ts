import express from "express";
import cors from "cors";
import "dotenv/config";
import http from "http";
import multer from "multer";
import { connectDB } from "./config/database/connection.database";
import router from "./services/route";
import { ZodError } from "zod";
import { BillingController } from "./services/billing/billing.controller";

const app = express();
const server = http.createServer(app);

const port = Number(process.env.PORT ?? 5002);

app.use("/api/v1/billing/webhook", express.raw({ type: "application/json" }));
app.post("/api/v1/billing/webhook", (req, res) => void BillingController.webhook(req, res));
app.use("/api/v1/billing/webhook/razorpay", express.raw({ type: "application/json" }));
app.post("/api/v1/billing/webhook/razorpay", (req, res) =>
  void BillingController.razorpayWebhook(req, res),
);
// Needed so req.ip / X-Forwarded-For resolve correctly behind proxies.
app.set("trust proxy", 1);

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

const corsOrigins = [
  process.env.CORS_ORIGINS,
  process.env.SITE_URL,
  process.env.PORTAL_URL,
  process.env.NEXT_PUBLIC_SITE_URL,
  process.env.NEXT_PUBLIC_PORTAL_URL,
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
]
  .filter(Boolean)
  .join(",")
  .split(",")
  .map((value) => value.trim().replace(/\/$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser tools (no Origin) and allowlisted marketing/portal origins.
      if (!origin || corsOrigins.includes(origin.replace(/\/$/, ""))) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  }),
);

app.get("/api/v1/health", (_req, res) => {
  return res.status(200).json({
    success: true,
    message: "Server is running",
    data: null,
  });
});

app.use("/api/v1", router);

app.use((
  error: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) => {
  if (error instanceof ZodError) {
    return res.status(422).json({
      success: false,
      message: "Validation failed",
      data: error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  if (error instanceof multer.MulterError) {
    const tooLarge = error.code === "LIMIT_FILE_SIZE";
    return res.status(tooLarge ? 413 : 400).json({
      success: false,
      message: tooLarge
        ? "Uploaded file exceeds the size limit"
        : error.message || "File upload failed",
      data: { code: error.code },
    });
  }

  console.error("Unhandled request error:", error);
  return res.status(500).json({
    success: false,
    message: "Internal server error",
    data: null,
  });
});

server.listen(port, async () => {
  try {
    await connectDB();
    console.log(`Server is running on ${port}`);
  } catch (error) {
    console.log("Getting error for server start :", process.env.PORT);
  }
});

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}
