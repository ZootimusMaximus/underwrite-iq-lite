const test = require("node:test");
const assert = require("node:assert/strict");

// Mock Redis before requiring module
let mockRedisStore = {};
let mockQueueList = [];

const mockRedis = {
  get: async key => mockRedisStore[key] || null,
  set: async (key, value) => {
    mockRedisStore[key] = value;
    return "OK";
  },
  del: async key => {
    delete mockRedisStore[key];
    return 1;
  },
  lpush: async (key, value) => {
    if (!mockQueueList[key]) mockQueueList[key] = [];
    mockQueueList[key].unshift(value);
    return mockQueueList[key].length;
  },
  rpop: async key => {
    if (!mockQueueList[key] || mockQueueList[key].length === 0) return null;
    return mockQueueList[key].pop();
  },
  llen: async key => (mockQueueList[key] || []).length
};

// Mock the dedupe-store module
const dedupeStore = require("../dedupe-store");
const originalCreateRedisClient = dedupeStore.createRedisClient;
dedupeStore.createRedisClient = () => mockRedis;

const { enqueueTask, processQueue, getQueueLength } = require("../background-queue");

function resetMocks() {
  mockRedisStore = {};
  mockQueueList = {};
}

// ============================================================================
// enqueueTask tests
// ============================================================================

test("enqueueTask stores task data and pushes to queue", async () => {
  resetMocks();

  const result = await enqueueTask("ghl_sync", { email: "test@test.com" });

  assert.equal(result.ok, true);
  assert.ok(result.taskId);
  assert.ok(result.taskId.startsWith("task_"));

  // Verify task data stored in Redis
  const taskKey = `uwiq:task:${result.taskId}`;
  const stored = JSON.parse(mockRedisStore[taskKey]);
  assert.equal(stored.type, "ghl_sync");
  assert.equal(stored.payload.email, "test@test.com");
  assert.equal(stored.attempts, 0);

  // Verify added to queue
  const queueLen = await mockRedis.llen("uwiq:taskq");
  assert.equal(queueLen, 1);
});

test("enqueueTask creates unique task IDs", async () => {
  resetMocks();

  const r1 = await enqueueTask("ghl_sync", { a: 1 });
  const r2 = await enqueueTask("ghl_sync", { a: 2 });

  assert.notEqual(r1.taskId, r2.taskId);
});

test("enqueueTask handles deliver_letters type", async () => {
  resetMocks();

  const result = await enqueueTask("deliver_letters", {
    contactId: null,
    contactData: { email: "test@test.com" },
    bureaus: null,
    underwrite: { fundable: true },
    personal: { name: "John Doe" }
  });

  assert.equal(result.ok, true);
  const stored = JSON.parse(mockRedisStore[`uwiq:task:${result.taskId}`]);
  assert.equal(stored.type, "deliver_letters");
  assert.equal(stored.payload.personal.name, "John Doe");
});

test("enqueueTask handles airtable_sync type", async () => {
  resetMocks();

  const result = await enqueueTask("airtable_sync", {
    result: { outcome: "FULL_FUNDING" },
    recordId: "rec123"
  });

  assert.equal(result.ok, true);
  const stored = JSON.parse(mockRedisStore[`uwiq:task:${result.taskId}`]);
  assert.equal(stored.type, "airtable_sync");
  assert.equal(stored.payload.recordId, "rec123");
});

// ============================================================================
// processQueue tests
// ============================================================================

test("processQueue returns zeros when queue is empty", async () => {
  resetMocks();

  const result = await processQueue(10);

  assert.equal(result.processed, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.requeued, 0);
});

test("processQueue skips tasks with missing data", async () => {
  resetMocks();

  // Push a task ID with no data
  await mockRedis.lpush("uwiq:taskq", "task_orphan123");

  const result = await processQueue(10);

  // Should not count as processed or failed — just skipped
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 0);
});

test("processQueue respects maxTasks limit", async () => {
  resetMocks();

  // Enqueue 5 tasks but only process 2
  for (let i = 0; i < 5; i++) {
    const taskId = `task_limit_${i}`;
    const task = {
      taskId,
      type: "ghl_sync",
      payload: { email: `test${i}@test.com` },
      attempts: 0
    };
    await mockRedis.set(`uwiq:task:${taskId}`, JSON.stringify(task));
    await mockRedis.lpush("uwiq:taskq", taskId);
  }

  // Mock the GHL function to succeed
  const ghlService = require("../ghl-contact-service");
  const originalCreate = ghlService.createOrUpdateContact;
  ghlService.createOrUpdateContact = async () => ({ ok: true, contactId: "c123" });

  const result = await processQueue(2);

  assert.equal(result.processed, 2);

  // 3 remaining
  const remaining = await mockRedis.llen("uwiq:taskq");
  assert.equal(remaining, 3);

  ghlService.createOrUpdateContact = originalCreate;
});

// ============================================================================
// getQueueLength tests
// ============================================================================

test("getQueueLength returns current queue size", async () => {
  resetMocks();

  assert.equal(await getQueueLength(), 0);

  await enqueueTask("ghl_sync", { email: "a@b.com" });
  assert.equal(await getQueueLength(), 1);

  await enqueueTask("ghl_sync", { email: "c@d.com" });
  assert.equal(await getQueueLength(), 2);
});

// ============================================================================
// Redis unavailable fallback tests
// ============================================================================

test("enqueueTask falls back to inline when Redis unavailable", async () => {
  // Temporarily make Redis unavailable
  dedupeStore.createRedisClient = () => null;

  // Mock the GHL function
  const ghlService = require("../ghl-contact-service");
  const originalCreate = ghlService.createOrUpdateContact;
  ghlService.createOrUpdateContact = async () => ({ ok: true, contactId: "c_inline" });

  const result = await enqueueTask("ghl_sync", { email: "inline@test.com" });

  assert.equal(result.ok, true);
  assert.equal(result.inline, true);

  // Restore
  dedupeStore.createRedisClient = () => mockRedis;
  ghlService.createOrUpdateContact = originalCreate;
});

test("processQueue handles Redis unavailable gracefully", async () => {
  dedupeStore.createRedisClient = () => null;

  const result = await processQueue(10);

  assert.equal(result.processed, 0);
  assert.equal(result.failed, 0);

  dedupeStore.createRedisClient = () => mockRedis;
});

// ============================================================================
// Retry logic tests
// ============================================================================

test("failed task is requeued with incremented attempt count", async () => {
  resetMocks();

  // Create a task that will fail
  const taskId = "task_retry_test";
  const task = {
    taskId,
    type: "ghl_sync",
    payload: { email: "fail@test.com" },
    attempts: 0
  };
  await mockRedis.set(`uwiq:task:${taskId}`, JSON.stringify(task));
  await mockRedis.lpush("uwiq:taskq", taskId);

  // Mock GHL to fail
  const ghlService = require("../ghl-contact-service");
  const originalCreate = ghlService.createOrUpdateContact;
  ghlService.createOrUpdateContact = async () => {
    throw new Error("GHL down");
  };

  const result = await processQueue(1);

  assert.equal(result.processed, 0);
  assert.equal(result.requeued, 1);

  // Check attempt count incremented
  const updated = JSON.parse(mockRedisStore[`uwiq:task:${taskId}`]);
  assert.equal(updated.attempts, 1);
  assert.equal(updated.lastError, "GHL down");

  // Task should be back in queue
  const qLen = await mockRedis.llen("uwiq:taskq");
  assert.equal(qLen, 1);

  ghlService.createOrUpdateContact = originalCreate;
});

test("task is dead-lettered after max retries", async () => {
  resetMocks();

  // Create a task already at max retries - 1
  const taskId = "task_deadletter";
  const task = {
    taskId,
    type: "ghl_sync",
    payload: { email: "dead@test.com" },
    attempts: 2 // Will become 3 (max)
  };
  await mockRedis.set(`uwiq:task:${taskId}`, JSON.stringify(task));
  await mockRedis.lpush("uwiq:taskq", taskId);

  // Mock GHL to fail
  const ghlService = require("../ghl-contact-service");
  const originalCreate = ghlService.createOrUpdateContact;
  ghlService.createOrUpdateContact = async () => {
    throw new Error("still down");
  };

  const result = await processQueue(1);

  assert.equal(result.failed, 1);
  assert.equal(result.requeued, 0);

  // Task data should be cleaned up
  assert.equal(mockRedisStore[`uwiq:task:${taskId}`], undefined);

  // Queue should be empty
  const qLen = await mockRedis.llen("uwiq:taskq");
  assert.equal(qLen, 0);

  ghlService.createOrUpdateContact = originalCreate;
});

// ============================================================================
// Cleanup
// ============================================================================

test("cleanup: restore original createRedisClient", () => {
  dedupeStore.createRedisClient = originalCreateRedisClient;
  assert.ok(true);
});
