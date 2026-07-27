#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeRuntime } from "../runtime.js";
import { decryptFile, encryptFile, keyFromEnvironment } from "../recovery/encryption.js";
import { ContractSchemaRegistry } from "../core/schema-registry.js";
import { restoreDirtyWorktree, verifyBackupManifest } from "../recovery/backup-service.js";
import { executeOfflineRestore } from "../recovery/restore-service.js";
import { verifyPackagedContractCompatibility } from "../recovery/contract-compatibility.js";
import { initializeCutover, readCutover, switchCutover } from "../recovery/cutover-service.js";
import {
  createKeyCapsule,
  createRecoveryKeyCopies,
  dataKeyFromFile,
  readKeyCapsule,
  unwrapKeyCapsule,
  validateCapsuleBinding,
  verifyRecoveryKeyCopies,
  writeUnwrappedDataKey,
} from "../recovery/key-capsule.js";
import { runStdioServer } from "../transports/stdio.js";
import { runA2AServer } from "../a2a/serve.js";
import { getConfig } from "../../config.js";
import { LegacyBridgeFacade } from "../compat/legacy-core.js";
import { resolveLane } from "../compat/lanes.js";

interface Arguments {
  command?: string;
  options: Map<string, string | true>;
}

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function parse(argv: string[]): Arguments {
  const [command, ...rest] = argv;
  const options = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected_argument:${token}`);
    const name = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(name, next);
      index += 1;
    } else {
      options.set(name, true);
    }
  }
  return { command, options };
}

function required(args: Arguments, name: string): string {
  const value = args.options.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_option:${name}`);
  return value;
}

function optional(args: Arguments, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function jsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as T;
}

function runtime(args: Arguments, extra: { initialize?: boolean; readOnly?: boolean } = {}): BridgeRuntime {
  return new BridgeRuntime({
    databasePath: required(args, "db"),
    auditMirrorPath: optional(args, "audit"),
    initialize: extra.initialize,
    readOnly: extra.readOnly,
  });
}

function currentSchemas(): ContractSchemaRegistry {
  return new ContractSchemaRegistry(fileURLToPath(new URL("../../../contracts/v0.1.0-draft.4/schemas", import.meta.url)));
}

function encryptionKey(args: Arguments): Buffer {
  const keyFile = optional(args, "key-file");
  const keyEnvironment = optional(args, "key-env");
  if (Boolean(keyFile) === Boolean(keyEnvironment)) throw new Error("exactly_one_key_source_required");
  return keyFile ? dataKeyFromFile(keyFile) : keyFromEnvironment(keyEnvironment!);
}

function restoreKey(args: Arguments, config: any, schemas: ContractSchemaRegistry): Buffer | undefined {
  const capsulePath = optional(args, "capsule");
  const privateKeyPath = optional(args, "private-key");
  if (Boolean(capsulePath) !== Boolean(privateKeyPath)) throw new Error("capsule_and_private_key_required_together");
  if (capsulePath && privateKeyPath) {
    const manifest = verifyBackupManifest(config.manifestPath, schemas);
    const metadata = manifest.encryption.wrappedKeyCapsule;
    if (!metadata) throw new Error("encrypted_backup_capsule_metadata_required");
    validateCapsuleBinding(capsulePath, {
      backupId: manifest.backupId,
      keyRef: manifest.encryption.keyRef!,
      recipientKeyFingerprint: metadata.recipientKeyFingerprint,
      capsuleSha256: metadata.capsuleSha256,
    }, schemas);
    return unwrapKeyCapsule(capsulePath, privateKeyPath, schemas, PACKAGE_ROOT);
  }
  if (optional(args, "key-file") || optional(args, "key-env")) return encryptionKey(args);
  return undefined;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  switch (args.command) {
    case "init": {
      const config = jsonFile<any>(required(args, "config"));
      const bridge = runtime(args, { initialize: true });
      try {
        const actor = bridge.identity.bootstrapOwner(config);
        output({ ok: true, projectId: config.projectId, actor });
      } finally { bridge.close(); }
      return;
    }
    case "doctor": {
      const config = jsonFile<any>(required(args, "config"));
      const bridge = runtime(args, { readOnly: true });
      try { output(bridge.doctor.run(config)); }
      finally { bridge.close(); }
      return;
    }
    case "backup": {
      const config = jsonFile<any>(required(args, "config"));
      if (config.encryption) {
        config.encryption.key = encryptionKey(args);
        const capsulePath = required(args, "capsule");
        const metadata = config.encryption.wrappedKeyCapsule;
        if (!metadata) throw new Error("encrypted_backup_capsule_metadata_required");
        validateCapsuleBinding(capsulePath, {
          backupId: config.backupId,
          keyRef: config.encryption.keyRef,
          recipientKeyFingerprint: metadata.recipientKeyFingerprint,
          capsuleSha256: metadata.capsuleSha256,
          dataKey: config.encryption.key,
        }, currentSchemas());
      }
      const bridge = runtime(args);
      try { output(bridge.backups.create(config)); }
      finally { bridge.close(); }
      return;
    }
    case "verify-backup": {
      output(verifyBackupManifest(required(args, "manifest"), currentSchemas()));
      return;
    }
    case "restore": {
      const config = jsonFile<any>(required(args, "config"));
      const schemas = currentSchemas();
      config.decryptionKey = restoreKey(args, config, schemas);
      config.runContractTests = (): boolean => {
        try { return verifyPackagedContractCompatibility(PACKAGE_ROOT).ok; }
        catch { return false; }
      };
      const bridge = runtime(args);
      try { output(bridge.restores.execute(config)); }
      finally { bridge.close(); }
      return;
    }
    case "recover-offline":
    case "restore-offline": {
      const config = jsonFile<any>(required(args, "config"));
      const schemas = currentSchemas();
      config.decryptionKey = restoreKey(args, config, schemas);
      config.runContractTests = (): boolean => {
        try { return verifyPackagedContractCompatibility(PACKAGE_ROOT).ok; }
        catch { return false; }
      };
      output(executeOfflineRestore(config, {
        schemas,
        migrationsDir: fileURLToPath(new URL("../../../migrations", import.meta.url)),
      }));
      return;
    }
    case "recovery-key-init": {
      const result = createRecoveryKeyCopies({
        localDirectory: required(args, "local-dir"),
        driveDirectory: required(args, "drive-dir"),
        keyName: required(args, "key-name"),
        forbiddenSourceRoot: PACKAGE_ROOT,
      });
      output(result);
      return;
    }
    case "recovery-key-verify": {
      output(verifyRecoveryKeyCopies({
        localDirectory: required(args, "local-dir"),
        driveDirectory: required(args, "drive-dir"),
        keyName: required(args, "key-name"),
        forbiddenSourceRoot: PACKAGE_ROOT,
      }));
      return;
    }
    case "capsule-create": {
      const result = createKeyCapsule({
        backupId: required(args, "backup-id"),
        keyRef: required(args, "key-ref"),
        publicKeyPath: required(args, "public-key"),
        capsulePath: required(args, "capsule"),
        dataKeyPath: required(args, "data-key"),
        schemas: currentSchemas(),
        forbiddenSourceRoot: PACKAGE_ROOT,
      });
      output({
        ok: true,
        capsuleId: result.capsule.capsuleId,
        capsulePath: result.capsulePath,
        capsuleSha256: result.capsuleSha256,
        dataKeyPath: result.dataKeyPath,
        backupId: result.capsule.backupId,
        keyRef: result.capsule.keyRef,
        recipientKeyFingerprint: result.capsule.recipientKeyFingerprint,
        wrappingAlgorithmId: result.capsule.wrappingAlgorithmId,
      });
      return;
    }
    case "capsule-unwrap": {
      const schemas = currentSchemas();
      const capsulePath = required(args, "capsule");
      const { capsule, capsuleSha256 } = readKeyCapsule(capsulePath, schemas);
      const dataKeyPath = writeUnwrappedDataKey(
        capsulePath,
        required(args, "private-key"),
        required(args, "data-key"),
        schemas,
        PACKAGE_ROOT,
      );
      output({
        ok: true,
        capsuleId: capsule.capsuleId,
        backupId: capsule.backupId,
        capsuleSha256,
        recipientKeyFingerprint: capsule.recipientKeyFingerprint,
        dataKeyPath,
      });
      return;
    }
    case "migration-plan": {
      const bridge = runtime(args, { readOnly: true });
      try { output(bridge.migrations.plan()); }
      finally { bridge.close(); }
      return;
    }
    case "migrate": {
      const config = jsonFile<any>(required(args, "config"));
      const bridge = runtime(args);
      try { output(bridge.migrations.apply(config)); }
      finally { bridge.close(); }
      return;
    }
    case "takeover": {
      const config = jsonFile<any>(required(args, "config"));
      const bridge = runtime(args);
      try { output({ generation: bridge.jobs.advanceGeneration(config) }); }
      finally { bridge.close(); }
      return;
    }
    case "reconcile-takeover": {
      const config = jsonFile<any>(required(args, "config"));
      const bridge = runtime(args);
      try { output(bridge.jobs.reconcileTakeover(config)); }
      finally { bridge.close(); }
      return;
    }
    case "audit-project": {
      const bridge = runtime(args);
      try {
        bridge.store.flushAuditMirror();
        output({ ok: true, auditMirrorPath: bridge.store.auditMirrorPath });
      } finally { bridge.close(); }
      return;
    }
    case "encrypt": {
      const aad = optional(args, "aad") ? jsonFile<unknown>(required(args, "aad")) : { purpose: "bridge2-manual-recovery" };
      output(encryptFile(required(args, "input"), required(args, "output"), keyFromEnvironment(required(args, "key-env")), aad));
      return;
    }
    case "decrypt": {
      const aad = optional(args, "aad") ? jsonFile<unknown>(required(args, "aad")) : { purpose: "bridge2-manual-recovery" };
      decryptFile(required(args, "input"), required(args, "output"), keyFromEnvironment(required(args, "key-env")), aad);
      output({ ok: true, output: path.resolve(required(args, "output")) });
      return;
    }
    case "restore-dirty-worktree": {
      output(restoreDirtyWorktree(required(args, "archive"), required(args, "destination")));
      return;
    }
    case "cutover-init": {
      output(initializeCutover(jsonFile<any>(required(args, "config"))));
      return;
    }
    case "cutover-status": {
      output(readCutover(required(args, "state")));
      return;
    }
    case "cutover-switch": {
      const config = jsonFile<any>(required(args, "config"));
      output(switchCutover(config));
      return;
    }
    case "serve-stdio": {
      const context = jsonFile<any>(required(args, "context"));
      const bridge = runtime(args);
      process.once("exit", () => bridge.close());
      await runStdioServer(bridge, context);
      process.stderr.write(`[bridge-v2] stdio ready for project=${context.projectId}\n`);
      return;
    }
    case "serve-a2a": {
      const context = jsonFile<any>(required(args, "context"));
      const bridge = runtime(args);
      process.once("exit", () => bridge.close());
      const portOption = optional(args, "port");
      const projectPath = optional(args, "project-path") ?? context.projectPath;
      const server = await runA2AServer(bridge, context, {
        ...(portOption ? { port: Number(portOption) } : {}),
        ...(projectPath ? { projectPath: String(projectPath) } : {}),
      });
      process.stderr.write(`[bridge-v2] a2a ready on ${server.url} project=${context.projectId}\n`);
      return;
    }
    case "legacy-import": {
      const config = getConfig();
      const facade = new LegacyBridgeFacade({
        config,
        stateRoot: optional(args, "state-root"),
        recoveryRoot: optional(args, "recovery-root"),
        lane: () => resolveLane({
          configuredAgent: config.agent,
          configuredLane: process.env.BRIDGE_LANE,
          clientName: "bridge-v2-cli",
        }),
      });
      try { output(await facade.importLegacyRegistry(required(args, "registry"))); }
      finally { facade.close(); }
      return;
    }
    default:
      throw new Error("usage: bridge-v2 <init|doctor|backup|verify-backup|restore|recover-offline|restore-offline|recovery-key-init|recovery-key-verify|capsule-create|capsule-unwrap|migration-plan|migrate|takeover|reconcile-takeover|audit-project|encrypt|decrypt|restore-dirty-worktree|cutover-init|cutover-status|cutover-switch|serve-stdio|serve-a2a|legacy-import> [options]");
  }
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error && typeof error === "object" && "details" in error ? { details: (error as { details?: unknown }).details } : {}),
  })}\n`);
  process.exitCode = 1;
});
