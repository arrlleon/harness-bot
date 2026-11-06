import { test } from "node:test";
import assert from "node:assert/strict";
import { scrubKnownSecrets, scrubSecretShapes, scrubSecrets } from "./secretScrub.js";

test("replaces a known secret value with a named placeholder", () => {
  const result = scrubKnownSecrets("token: s3cr3t-value-123 in the log", { GITLAB_TOKEN: "s3cr3t-value-123" });
  assert.equal(result, "token: ***cred:GITLAB_TOKEN*** in the log");
});

test("replaces every occurrence of a known secret, not just the first", () => {
  const result = scrubKnownSecrets("a=tok123456 b=tok123456", { JIRA_PAT: "tok123456" });
  assert.equal(result, "a=***cred:JIRA_PAT*** b=***cred:JIRA_PAT***");
});

test("skips secrets shorter than the minimum length (unset var, trivial placeholder)", () => {
  const result = scrubKnownSecrets("the word is on", { TELEGRAM_BOT_TOKEN: "on" });
  assert.equal(result, "the word is on");
});

test("skips an empty secret value entirely", () => {
  const result = scrubKnownSecrets("nothing configured here", { GITLAB_TOKEN: "" });
  assert.equal(result, "nothing configured here");
});

test("text with no matching secret passes through unchanged", () => {
  const result = scrubKnownSecrets("ordinary review text, no secrets here", { GITLAB_TOKEN: "glpat-abcdef123456" });
  assert.equal(result, "ordinary review text, no secrets here");
});

test("redacts a Bearer token shape even when the value isn't a known secret", () => {
  const result = scrubSecretShapes("curl -H 'Authorization: Bearer abcDEF123456.ghiJKL789'");
  assert.match(result, /\*\*\*redacted:bearer-token\*\*\*/);
  assert.doesNotMatch(result, /abcDEF123456/);
});

test("redacts a PEM private key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
  const result = scrubSecretShapes(`found this in a fixture:\n${pem}`);
  assert.equal(result, "found this in a fixture:\n***redacted:pem-block***");
});

test("redacts a JWT shape", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ";
  const result = scrubSecretShapes(`sample token: ${jwt}`);
  assert.equal(result, "sample token: ***redacted:jwt***");
});

test("redacts an AWS access key id", () => {
  const result = scrubSecretShapes("key = AKIAIOSFODNN7EXAMPLE in the test fixture");
  assert.equal(result, "key = ***redacted:aws-access-key*** in the test fixture");
});

test("does not touch ordinary prose mentioning 'password' without a rigid secret shape", () => {
  const text = "renamed the password field on the login form to passwordHash";
  assert.equal(scrubSecretShapes(text), text);
});

test("scrubSecrets applies the known-value pass before the shape pass", () => {
  // A configured secret that happens to look like a JWT gets redacted by name,
  // not swallowed by the generic jwt pattern.
  const jwtShapedSecret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ";
  const result = scrubSecrets(`token: ${jwtShapedSecret}`, { JIRA_PAT: jwtShapedSecret });
  assert.equal(result, "token: ***cred:JIRA_PAT***");
});

test("scrubSecrets still catches an unrelated secret shape alongside a known secret", () => {
  const result = scrubSecrets("gitlab=glpat-knownvalue, aws key AKIAIOSFODNN7EXAMPLE", {
    GITLAB_TOKEN: "glpat-knownvalue",
  });
  assert.equal(result, "gitlab=***cred:GITLAB_TOKEN***, aws key ***redacted:aws-access-key***");
});
