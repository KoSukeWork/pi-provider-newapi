/** Verifies ratio lookup fallbacks and cache-cost conversion. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { calcCacheCost, findRatio } from "../src/models.ts";

test("findRatio: exact match wins", () => {
	assert.equal(findRatio("gpt-4o", { "gpt-4o": 2.5, gpt: 1 }), 2.5);
});

test("findRatio: case-insensitive match", () => {
	assert.equal(findRatio("GPT-4O", { "gpt-4o": 3 }), 3);
});

test("findRatio: prefix match as fallback", () => {
	assert.equal(findRatio("claude-3-5-sonnet-20241022", { "claude-3-5-sonnet": 4 }), 4);
});

test("findRatio: no match returns undefined", () => {
	assert.equal(findRatio("unknown", { other: 1 }), undefined);
});

test("calcCacheCost applies cache ratio", () => {
	assert.equal(calcCacheCost(2, 0.25), 1);
});
