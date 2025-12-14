const test = require("node:test");
const assert = require("node:assert/strict");
const { logger, logError, logInfo, logWarn, logDebug, createChildLogger } = require("../logger");

// ============================================================================
// Logger instance tests
// ============================================================================
test("logger is a pino instance", () => {
  assert.ok(logger);
  assert.equal(typeof logger.info, "function");
  assert.equal(typeof logger.error, "function");
  assert.equal(typeof logger.warn, "function");
  assert.equal(typeof logger.debug, "function");
});

test("logger has correct base configuration", () => {
  // Logger should have bindings with service name
  const bindings = logger.bindings();
  assert.equal(bindings.service, "underwrite-iq-lite");
});

// ============================================================================
// logError tests
// ============================================================================
test("logError handles Error objects", () => {
  // Should not throw
  assert.doesNotThrow(() => {
    logError("TEST_ERROR", new Error("Test error message"), "test context");
  });
});

test("logError handles string errors", () => {
  assert.doesNotThrow(() => {
    logError("STRING_ERROR", "String error message", "test context");
  });
});

test("logError handles errors without context", () => {
  assert.doesNotThrow(() => {
    logError("NO_CONTEXT", new Error("Error without context"));
  });
});

test("logError handles null error", () => {
  assert.doesNotThrow(() => {
    logError("NULL_ERROR", null);
  });
});

test("logError handles undefined error", () => {
  assert.doesNotThrow(() => {
    logError("UNDEFINED_ERROR", undefined);
  });
});

// ============================================================================
// logInfo tests
// ============================================================================
test("logInfo logs message", () => {
  assert.doesNotThrow(() => {
    logInfo("Test info message");
  });
});

test("logInfo logs message with data", () => {
  assert.doesNotThrow(() => {
    logInfo("Test info with data", { key: "value", count: 42 });
  });
});

test("logInfo handles empty data object", () => {
  assert.doesNotThrow(() => {
    logInfo("Test info empty data", {});
  });
});

// ============================================================================
// logWarn tests
// ============================================================================
test("logWarn logs warning message", () => {
  assert.doesNotThrow(() => {
    logWarn("Test warning message");
  });
});

test("logWarn logs warning with data", () => {
  assert.doesNotThrow(() => {
    logWarn("Test warning with data", { warning: "something wrong" });
  });
});

// ============================================================================
// logDebug tests
// ============================================================================
test("logDebug logs debug message", () => {
  assert.doesNotThrow(() => {
    logDebug("Test debug message");
  });
});

test("logDebug logs debug with data", () => {
  assert.doesNotThrow(() => {
    logDebug("Test debug with data", { debug: true, details: "verbose" });
  });
});

// ============================================================================
// createChildLogger tests
// ============================================================================
test("createChildLogger creates child logger", () => {
  const child = createChildLogger({ requestId: "123" });
  assert.ok(child);
  assert.equal(typeof child.info, "function");
});

test("createChildLogger child inherits parent bindings", () => {
  const child = createChildLogger({ requestId: "456" });
  const bindings = child.bindings();
  assert.equal(bindings.requestId, "456");
  assert.equal(bindings.service, "underwrite-iq-lite");
});

test("createChildLogger child can log messages", () => {
  const child = createChildLogger({ module: "test" });
  assert.doesNotThrow(() => {
    child.info("Child logger test message");
    child.error("Child logger error");
    child.warn("Child logger warning");
  });
});

// ============================================================================
// Edge cases
// ============================================================================
test("logInfo handles complex nested data", () => {
  assert.doesNotThrow(() => {
    logInfo("Complex data", {
      nested: { deep: { value: 123 } },
      array: [1, 2, 3],
      date: new Date().toISOString()
    });
  });
});

test("logError handles error with extra properties", () => {
  const err = new Error("Custom error");
  err.code = "ERR_CUSTOM";
  err.statusCode = 500;

  assert.doesNotThrow(() => {
    logError("CUSTOM_ERROR", err, { additional: "context" });
  });
});
