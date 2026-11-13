import test from "node:test";
import assert from "node:assert/strict";

import { buildGeminiBody, isGemmaModel } from "../llm/llm.model";
import {
  applySpeakerRoles,
  buildRoleDialogue,
  classifyAgentCaller,
  distinctSpeakerIds,
  parseRoleReply,
} from "./stt.speaker-roles";

const twoSpeakers = {
  text: "…",
  segments: [
    { start: 0, end: 2, speaker: "SPEAKER_00", text: "Thank you for calling EBMA support, how can I help?" },
    { start: 2, end: 5, speaker: "SPEAKER_01", text: "My internet is not working since morning." },
    { start: 5, end: 7, speaker: "SPEAKER_00", text: "Sorry about that, can I have your account number?" },
  ],
  speakers: [{ id: "SPEAKER_00", talkTimeSeconds: 4 }, { id: "SPEAKER_01", talkTimeSeconds: 3 }],
};

test("distinctSpeakerIds keeps first-appearance order", () => {
  assert.deepEqual(distinctSpeakerIds(twoSpeakers), ["SPEAKER_00", "SPEAKER_01"]);
  assert.deepEqual(distinctSpeakerIds({ segments: [{ speaker: "A", text: "x" }] }), ["A"]);
  assert.deepEqual(distinctSpeakerIds({ speakers: [{ id: 1 }, { id: 2 }, { id: 3 }] }), ["1", "2", "3"]);
});

test("buildRoleDialogue maps raw ids to S1/S2", () => {
  const dialogue = buildRoleDialogue(twoSpeakers, distinctSpeakerIds(twoSpeakers));
  assert.match(dialogue, /^S1: Thank you/);
  assert.match(dialogue, /\nS2: My internet/);
});

test("parseRoleReply tolerates fences and prose", () => {
  assert.deepEqual(parseRoleReply('```json\n{"agent":"S2","confidence":0.9}\n```'), { agent: "S2", confidence: 0.9 });
  assert.deepEqual(parseRoleReply('Sure! {"agent": "s1", "confidence": "0.75"} done'), { agent: "S1", confidence: 0.75 });
  assert.equal(parseRoleReply("I think speaker one"), null);
  assert.equal(parseRoleReply('{"agent":"S3","confidence":1}'), null);
});

test("applySpeakerRoles relabels segments and speakers, keeping raw ids", () => {
  const out = applySpeakerRoles(twoSpeakers, {
    roles: { SPEAKER_00: "agent", SPEAKER_01: "caller" },
    model: "gemma-4-26b-a4b-it",
    confidence: 0.9,
  }) as any;
  assert.equal(out.segments[0].speaker, "Agent");
  assert.equal(out.segments[0].speakerId, "SPEAKER_00");
  assert.equal(out.segments[1].speaker, "Caller");
  assert.equal(out.speakers[0].label, "Agent");
  assert.equal(out.speakers[1].label, "Caller");
  assert.equal(out.speaker_roles.model, "gemma-4-26b-a4b-it");
  assert.equal((twoSpeakers.segments[0] as any).speakerId, undefined, "input is not mutated");
});

test("classifyAgentCaller skips 1 and 3+ speakers and missing key without calling the LLM", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("should not be called"); }) as typeof fetch;
  try {
    process.env.STT_ROLE_LLM_API_KEY = "test-key";
    assert.equal(await classifyAgentCaller({ segments: [{ speaker: "A", text: "hi" }] }), null);
    assert.equal(await classifyAgentCaller({
      segments: [{ speaker: "A", text: "a" }, { speaker: "B", text: "b" }, { speaker: "C", text: "c" }],
    }), null);
    delete process.env.STT_ROLE_LLM_API_KEY;
    assert.equal(await classifyAgentCaller(twoSpeakers), null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifyAgentCaller maps the model reply and honours min confidence", async () => {
  const originalFetch = globalThis.fetch;
  let reply = '{"agent":"S1","confidence":0.92}';
  let sentBody: any;
  let sentUrl = "";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sentUrl = String(url);
    sentBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    process.env.STT_ROLE_LLM_API_KEY = "test-key";
    process.env.STT_ROLE_LLM_MODEL = "gemma-4-26b-a4b-it";
    const roles = await classifyAgentCaller(twoSpeakers);
    assert.deepEqual(roles?.roles, { SPEAKER_00: "agent", SPEAKER_01: "caller" });
    assert.match(sentUrl, /models\/gemma-4-26b-a4b-it:generateContent\?key=test-key/);
    assert.equal(sentBody.systemInstruction, undefined);
    assert.match(sentBody.contents[0].parts[0].text, /call-center AGENT/);

    reply = '{"agent":"S2","confidence":0.4}';
    assert.equal(await classifyAgentCaller(twoSpeakers), null);

    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    assert.equal(await classifyAgentCaller(twoSpeakers), null);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.STT_ROLE_LLM_API_KEY;
    delete process.env.STT_ROLE_LLM_MODEL;
  }
});

test("Gemma body has no systemInstruction or JSON mode; Gemini keeps them", () => {
  assert.equal(isGemmaModel("gemma-4-26b-a4b-it"), true);
  assert.equal(isGemmaModel("gemini-2.5-flash"), false);
  const input = { system: "SYS", turns: [{ role: "user" as const, text: "hello" }], json: true };
  const gemma: any = buildGeminiBody(input, { model_name: "gemma-4-26b-a4b-it" } as any);
  assert.equal(gemma.systemInstruction, undefined);
  assert.equal(gemma.generationConfig.responseMimeType, undefined);
  assert.equal(gemma.contents[0].parts[0].text, "SYS\n\nhello");
  const gemini: any = buildGeminiBody(input, { model_name: "gemini-2.5-flash" } as any);
  assert.equal(gemini.systemInstruction.parts[0].text, "SYS");
  assert.equal(gemini.generationConfig.responseMimeType, "application/json");
});
