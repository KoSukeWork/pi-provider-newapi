/** Verifies that configured gateway URLs cannot smuggle credentials or non-HTTP schemes. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeBaseUrl } from "../src/urls.ts";

test("normalizeBaseUrl: trims trailing slashes and whitespace", () => {
	assert.equal(normalizeBaseUrl("  https://gw.example.com///  "), "https://gw.example.com");
});

test("normalizeBaseUrl: accepts HTTP for explicitly local gateways", () => {
	assert.equal(normalizeBaseUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
});

test("normalizeBaseUrl: rejects non-HTTP schemes", () => {
	assert.throws(() => normalizeBaseUrl("file:///etc/passwd"), /http:\/\/ or https:\/\//);
	assert.throws(() => normalizeBaseUrl("data:text/plain,secret"), /http:\/\/ or https:\/\//);
});

test("normalizeBaseUrl: rejects userinfo, query, fragment, and control characters", () => {
	assert.throws(() => normalizeBaseUrl("https://user:password@evil.example"), /username or password/);
	assert.throws(() => normalizeBaseUrl("https://gw.example.com?redirect=evil"), /query or fragment/);
	assert.throws(() => normalizeBaseUrl("https://gw.example.com/#fragment"), /query or fragment/);
	assert.throws(() => normalizeBaseUrl("https://gw.example.com/\u001b[2J"), /control characters/);
});
