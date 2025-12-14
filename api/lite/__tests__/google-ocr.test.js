const test = require("node:test");
const assert = require("node:assert/strict");
const { googleOCR } = require("../google-ocr");

test("googleOCR returns ok:true response", async () => {
  const buffer = Buffer.from("test content");
  const result = await googleOCR(buffer);
  assert.equal(result.ok, true);
});

test("googleOCR returns empty pages array", async () => {
  const buffer = Buffer.from("test content");
  const result = await googleOCR(buffer);
  assert.deepEqual(result.pages, []);
});

test("googleOCR returns note about not being wired", async () => {
  const buffer = Buffer.from("test content");
  const result = await googleOCR(buffer);
  assert.ok(result.note.includes("not wired"));
});

test("googleOCR handles empty buffer", async () => {
  const buffer = Buffer.alloc(0);
  const result = await googleOCR(buffer);
  assert.equal(result.ok, true);
});

test("googleOCR handles large buffer", async () => {
  const buffer = Buffer.alloc(1024 * 1024); // 1MB
  const result = await googleOCR(buffer);
  assert.equal(result.ok, true);
});
