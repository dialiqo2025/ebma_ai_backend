import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLlmPrompt,
  normalizeLlmText,
  isLlmConfigured,
} from "./llm.model";

test("normalizeLlmText removes repeated whitespace and trims punctuation", () => {
  assert.equal(
    normalizeLlmText("  hello    world   !  "),
    "hello world!",
  );
});

test("buildLlmPrompt includes the language and transcript", () => {
  const prompt = buildLlmPrompt({
    text: "hello world",
    language: "hi",
    style: "natural",
  });

  assert.match(prompt, /hello world/);
  assert.match(prompt, /hi/);
  assert.match(prompt, /natural/);
});

test("isLlmConfigured is false when no API key is set", () => {
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_MODEL;
  assert.equal(isLlmConfigured(), false);
});
