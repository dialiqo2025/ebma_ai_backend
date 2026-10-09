import { z } from "zod";
import { playgroundTtsMaxChars } from "./playground.limits";

export const playgroundApiParam = z.enum(["tts", "stt"]);

export const playgroundStatusQuery = z.object({
  api: playgroundApiParam,
});

export const playgroundTtsBody = z.object({
  text: z
    .string()
    .trim()
    .min(1, "Text is required")
    .max(playgroundTtsMaxChars(), `Text must be at most ${playgroundTtsMaxChars()} characters`),
  language: z.string().trim().min(2).max(16).optional().default("en"),
});
