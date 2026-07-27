import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contract = path.join(root, "contracts", "mailbox-v1-draft");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const pairs = [
  ["message.valid.json", "message.schema.json"],
  ["ready.valid.json", "ready.schema.json"],
  ["response.valid.json", "response.schema.json"],
  ["claim.valid.json", "claim.schema.json"],
  ["config.valid.json", "config.schema.json"],
];

const legacy = loadContractVersion(contract);
validateExamples(legacy);
validateLegacyVectors(legacy);

const active = loadContractVersion(path.join(contract, "v2"));
validateExamples(active);
validateActiveVectors(active);

const current = loadContractVersion(path.join(contract, "v3"));
validateExamples(current);
validateCurrentVectors(current);

console.log(`MAILBOX CONTRACT SCHEMAS PASSED: legacy v1 ${legacy.schemas.length}; historical v2 ${active.schemas.length}; current v3 ${current.schemas.length} schemas; ${pairs.length} examples/version; provider, WEB node, destination, and hash semantic vectors`);

function loadContractVersion(directory) {
  const schemaDirectory = path.join(directory, "schemas");
  const exampleDirectory = path.join(directory, "examples");
  const schemas = fs.readdirSync(schemaDirectory)
    .filter((name) => name.endsWith(".schema.json"))
    .map((name) => read(path.join(schemaDirectory, name)));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of schemas) {
    assert.equal(ajv.validateSchema(schema), true, JSON.stringify(ajv.errors));
    ajv.addSchema(schema);
  }
  return { ajv, schemas, exampleDirectory };
}

function validateExamples(version) {
  for (const [exampleName, schemaName] of pairs) {
    const schema = version.schemas.find((candidate) => candidate.$id.endsWith(`/${schemaName}`));
    const validate = version.ajv.getSchema(schema.$id);
    assert.equal(
      validate(read(path.join(version.exampleDirectory, exampleName))),
      true,
      `${exampleName}: ${JSON.stringify(validate.errors)}`,
    );
  }
}

function validateLegacyVectors(version) {
  const message = read(path.join(version.exampleDirectory, "message.valid.json"));
  const validateMessage = validator(version, "message.schema.json");
  const wrongUseCount = structuredClone(message);
  wrongUseCount.dispatchAuthorization.useCount = 2;
  assert.equal(validateMessage(wrongUseCount), false, "legacy multi-use browser dispatch was accepted");
  assert.equal(legacyMessageSemantics(message), true);
  const providerSwap = structuredClone(message);
  providerSwap.dispatchAuthorization.provider = message.recipient === "chatgpt" ? "gemini" : "chatgpt";
  assert.equal(legacyMessageSemantics(providerSwap), false, "legacy cross-provider authorization was accepted");
  const changedPrompt = structuredClone(message);
  changedPrompt.prompt = "Changed after approval.";
  assert.equal(legacyMessageSemantics(changedPrompt), false, "legacy prompt hash mismatch was accepted");

  const response = read(path.join(version.exampleDirectory, "response.valid.json"));
  assert.equal(new URL(response.conversationUrl).origin, response.provider === "chatgpt" ? "https://chatgpt.com" : "https://gemini.google.com");
}

function validateActiveVectors(version) {
  const message = read(path.join(version.exampleDirectory, "message.valid.json"));
  const validateMessage = validator(version, "message.schema.json");
  assert.equal(message.schemaVersion, "bridge-mailbox-v2");
  assert.equal(message.recipient, "antigravity");
  assert.deepEqual(message.dispatchAuthorization.destination, { kind: "local-mcp", surface: "antigravity" });
  assert.equal(activeMessageSemantics(message), true);

  const wrongUseCount = structuredClone(message);
  wrongUseCount.dispatchAuthorization.useCount = 2;
  assert.equal(validateMessage(wrongUseCount), false, "active multi-use dispatch was accepted");
  const retiredProvider = structuredClone(message);
  retiredProvider.recipient = "gemini";
  assert.equal(validateMessage(retiredProvider), false, "retired Gemini provider was accepted by v2");
  const authorizationSwap = structuredClone(message);
  authorizationSwap.dispatchAuthorization.provider = "chatgpt";
  assert.equal(validateMessage(authorizationSwap), false, "cross-provider v2 authorization was accepted");
  const destinationSwap = structuredClone(message);
  destinationSwap.dispatchAuthorization.destination = { kind: "browser-origin", origin: "https://chatgpt.com" };
  assert.equal(validateMessage(destinationSwap), false, "Antigravity message accepted a ChatGPT browser destination");
  assert.equal(activeMessageSemantics(destinationSwap), false, "cross-surface dispatch destination was accepted");
  const changedPrompt = structuredClone(message);
  changedPrompt.prompt = "Changed after approval.";
  assert.equal(activeMessageSemantics(changedPrompt), false, "active prompt hash mismatch was accepted");

  const claim = read(path.join(version.exampleDirectory, "claim.valid.json"));
  claim.deliveryToken = "short";
  assert.equal(validator(version, "claim.schema.json")(claim), false, "short delivery token was accepted");

  const retiredClaim = read(path.join(version.exampleDirectory, "claim.valid.json"));
  retiredClaim.message.recipient = "gemini";
  assert.equal(validator(version, "claim.schema.json")(retiredClaim), false, "claim accepted a retired Gemini message");

  const response = read(path.join(version.exampleDirectory, "response.valid.json"));
  const validateResponse = validator(version, "response.schema.json");
  assert.equal(response.provider, "antigravity");
  assert.equal("conversationUrl" in response, false);
  response.conversationUrl = "https://antigravity.google/synthetic";
  assert.equal(validateResponse(response), false, "Antigravity response accepted a fabricated browser conversation origin");

  const retiredResponse = read(path.join(version.exampleDirectory, "response.valid.json"));
  retiredResponse.provider = "gemini";
  assert.equal(validateResponse(retiredResponse), false, "response accepted retired Gemini provider");

  const config = read(path.join(version.exampleDirectory, "config.valid.json"));
  const validateConfig = validator(version, "config.schema.json");
  config.providers.gemini = config.providers.antigravity;
  assert.equal(validateConfig(config), false, "config accepted retired Gemini provider");
}

function validateCurrentVectors(version) {
  const message = read(path.join(version.exampleDirectory, "message.valid.json"));
  const validateMessage = validator(version, "message.schema.json");
  assert.equal(message.schemaVersion, "bridge-mailbox-v3");
  assert.equal(message.recipient, "web");
  assert.equal(message.webNodeId, "perplexity");
  assert.deepEqual(message.dispatchAuthorization.destination, {
    kind: "browser-origin",
    origin: "https://www.perplexity.ai",
    webNodeId: "perplexity",
  });
  assert.equal(currentMessageSemantics(message), true);

  const missingNode = structuredClone(message);
  delete missingNode.webNodeId;
  assert.equal(validateMessage(missingNode), false, "WEB message without node id was accepted");
  const providerSwap = structuredClone(message);
  providerSwap.dispatchAuthorization.provider = "chatgpt";
  assert.equal(validateMessage(providerSwap), false, "WEB message with cross-provider approval was accepted");
  const nodeSwap = structuredClone(message);
  nodeSwap.dispatchAuthorization.destination.webNodeId = "other-node";
  assert.equal(currentMessageSemantics(nodeSwap), false, "WEB message with cross-node approval was accepted");
  const originSwap = structuredClone(message);
  originSwap.dispatchAuthorization.destination.origin = "https://example.com";
  assert.equal(currentMessageSemantics(originSwap), false, "WEB message with wrong configured origin was accepted");
  const changedPrompt = structuredClone(message);
  changedPrompt.prompt = "Changed after approval.";
  assert.equal(currentMessageSemantics(changedPrompt), false, "WEB prompt hash mismatch was accepted");
  const wrongUseCount = structuredClone(message);
  wrongUseCount.dispatchAuthorization.useCount = 2;
  assert.equal(validateMessage(wrongUseCount), false, "WEB multi-use browser dispatch was accepted");

  const claim = read(path.join(version.exampleDirectory, "claim.valid.json"));
  claim.deliveryToken = "short";
  assert.equal(validator(version, "claim.schema.json")(claim), false, "short v3 delivery token was accepted");

  const response = read(path.join(version.exampleDirectory, "response.valid.json"));
  const validateResponse = validator(version, "response.schema.json");
  assert.equal(response.provider, "web");
  assert.equal(validateResponse(response), true);
  response.conversationUrl = "http://www.perplexity.ai/insecure";
  assert.equal(validateResponse(response), false, "insecure WEB conversation URL was accepted");

  const config = read(path.join(version.exampleDirectory, "config.valid.json"));
  const validateConfig = validator(version, "config.schema.json");
  assert.equal(validateConfig(config), true);
  const scriptProfile = structuredClone(config);
  scriptProfile.webNodes.perplexity.script = "document.body.innerHTML";
  assert.equal(validateConfig(scriptProfile), false, "executable WEB node profile property was accepted");
  const broadOrigin = structuredClone(config);
  broadOrigin.webNodes.perplexity.origin = "https://www.perplexity.ai/path";
  assert.equal(validateConfig(broadOrigin), false, "WEB node origin with a path was accepted");
}

function validator(version, schemaName) {
  const schema = version.schemas.find((candidate) => candidate.$id.endsWith(`/${schemaName}`));
  return version.ajv.getSchema(schema.$id);
}

function legacyMessageSemantics(value) {
  const expectedOrigin = value.recipient === "chatgpt" ? "https://chatgpt.com" : "https://gemini.google.com";
  return value.dispatchAuthorization.provider === value.recipient &&
    value.dispatchAuthorization.origin === expectedOrigin &&
    commonMessageSemantics(value);
}

function activeMessageSemantics(value) {
  const destinationMatches = value.recipient === "chatgpt"
    ? value.dispatchAuthorization.destination?.kind === "browser-origin" &&
      value.dispatchAuthorization.destination.origin === "https://chatgpt.com"
    : value.recipient === "antigravity" &&
      value.dispatchAuthorization.destination?.kind === "local-mcp" &&
      value.dispatchAuthorization.destination.surface === "antigravity";
  return value.dispatchAuthorization.provider === value.recipient &&
    destinationMatches &&
    commonMessageSemantics(value);
}

function currentMessageSemantics(value) {
  const destination = value.dispatchAuthorization.destination;
  return value.recipient === "web" &&
    value.webNodeId === "perplexity" &&
    value.dispatchAuthorization.provider === "web" &&
    destination?.kind === "browser-origin" &&
    destination.webNodeId === value.webNodeId &&
    destination.origin === "https://www.perplexity.ai" &&
    commonMessageSemantics(value);
}

function commonMessageSemantics(value) {
  return value.dispatchAuthorization.expiresAt === value.expiresAt &&
    crypto.createHash("sha256").update(value.prompt, "utf8").digest("hex") === value.promptSha256 &&
    Date.parse(value.expiresAt) > Date.parse(value.createdAt);
}
