// reasoned | script-rendered-from-reasoned-data | script-generated
import test from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../../').replace(/\\$/, '');
const installScript = join(repoRoot, 'scripts/caps/Install-BridgeCapsSchedule.ps1');
const invokeScript = join(repoRoot, 'scripts/caps/Invoke-BridgeCapsRefresh.ps1');
const tmpDirRoot = fs.mkdtempSync(join(os.tmpdir(), 'caps-test-'));

function createTestEnv(testName) {
    const testDir = join(tmpDirRoot, testName.replace(/[^a-z0-9]/gi, '_'));
    fs.mkdirSync(testDir, { recursive: true });

    const logPath = join(testDir, 'fake-schtasks-log.txt');
    const testExistsPath = join(testDir, 'fake-task-exists.txt');
    const fakeSchtasks = join(testDir, 'fake-schtasks.ps1');
    const fakeSchtasksCmd = join(testDir, 'fake-schtasks.cmd');
    const capsStateDir = join(testDir, 'fake-caps-state');

    fs.mkdirSync(capsStateDir, { recursive: true });

    fs.writeFileSync(fakeSchtasksCmd, `@echo off\npowershell -NoProfile -ExecutionPolicy Bypass -File "${fakeSchtasks}" %*\nexit /b %ERRORLEVEL%`);

    fs.writeFileSync(fakeSchtasks, `
        $argsStr = $args -join ' '
        Add-Content -Path '${logPath}' -Value "$argsStr\`n"
        if ($argsStr -match 'CodexConnector-CatalogSync') {
            Write-Output "<Task><Audit>true</Audit></Task>"
            exit 0
        }
        if ($argsStr -match 'Bridge Caps Daily Refresh') {
            if ($argsStr -match '/query') {
                if (Test-Path '${testExistsPath}') {
                    Write-Output "<Task><Test>true</Test></Task>"
                    exit 0
                }
                exit 1
            }
            exit 0
        }
        exit 0
    `);

    return { testDir, logPath, testExistsPath, fakeSchtasksCmd, capsStateDir };
}

function runInstall(envContext, args = '') {
    try {
        const env = { ...process.env, BRIDGE_CAPS_STATE_DIR: envContext.capsStateDir };
        const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${installScript}" -SchedulerCmd "${envContext.fakeSchtasksCmd}" ${args}`, { cwd: __dirname, encoding: 'utf8', env });
        return { stdout: result, exitCode: 0 };
    } catch (e) {
        return { stdout: e.stdout, stderr: e.stderr, exitCode: e.status };
    }
}

test('1. dry-run mode (Audit) executes with no mutation', () => {
    const env = createTestEnv('audit_no_mutation');
    const result = runInstall(env);
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /Dry-run \(Audit\) complete/);
    if (fs.existsSync(env.logPath)) {
        const log = fs.readFileSync(env.logPath, 'utf8');
        assert.doesNotMatch(log, /\/create/i);
        assert.doesNotMatch(log, /\/delete/i);
    }
});

test('2. apply plan creates task with correct name', () => {
    const env = createTestEnv('apply_plan');
    const result = runInstall(env, '-Apply');
    assert.strictEqual(result.exitCode, 0);
    const log = fs.readFileSync(env.logPath, 'utf8');
    assert.match(log, /\/create.*\/tn.*Bridge Caps Daily Refresh.*\/xml/i);
});

test('3. remove scope deletes the specific task', () => {
    const env = createTestEnv('remove_scope');
    fs.writeFileSync(env.testExistsPath, 'true');
    const result = runInstall(env, '-Remove');
    assert.strictEqual(result.exitCode, 0);
    const log = fs.readFileSync(env.logPath, 'utf8');
    assert.match(log, /\/delete.*\/tn.*Bridge Caps Daily Refresh/i);
});

test('4. absolute action points to powershell bypassing profile invoking the wrapper', () => {
    const env = createTestEnv('absolute_action');
    runInstall(env, '-Apply');
    const log = fs.readFileSync(env.logPath, 'utf8');
    const xmlMatch = log.match(/\/xml "?([^"\s]+\.xml)"?/i);
    assert.ok(xmlMatch, 'Should pass /xml with an xml path');
    const xmlContent = fs.readFileSync(xmlMatch[1], 'utf16le'); // PS writes Unicode
    assert.match(xmlContent, /<Command>.*powershell\.exe<\/Command>/i);
    assert.match(xmlContent, /<Arguments>-NoProfile -ExecutionPolicy Bypass -File ".*Invoke-BridgeCapsRefresh\.ps1"<\/Arguments>/i);
    assert.match(xmlContent, new RegExp(`<WorkingDirectory>${repoRoot.replace(/\\/g, '\\\\')}</WorkingDirectory>`, 'i'));
});

test('5. 06:30 trigger is scheduled daily', () => {
    const env = createTestEnv('trigger');
    runInstall(env, '-Apply');
    const log = fs.readFileSync(env.logPath, 'utf8');
    const xmlMatch = log.match(/\/xml "?([^"\s]+\.xml)"?/i);
    assert.ok(xmlMatch);
    const xmlContent = fs.readFileSync(xmlMatch[1], 'utf16le');
    assert.match(xmlContent, /<StartBoundary>.*T06:30:00<\/StartBoundary>/i);
    assert.match(xmlContent, /<DaysInterval>1<\/DaysInterval>/i);
    assert.match(xmlContent, /<StartWhenAvailable>true<\/StartWhenAvailable>/i);
});

test('6. backup is created before apply replaces', () => {
    const env = createTestEnv('backup_before_apply');
    fs.writeFileSync(env.testExistsPath, 'true');
    const result = runInstall(env, '-Apply');
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /Backed up existing task/i);
});

test('7. refusal to replace if manifest is missing or invalid', () => {
    const env = createTestEnv('refuse_invalid_manifest');
    fs.writeFileSync(env.testExistsPath, 'true');

    // Break the XML writing by making fake schtasks return empty XML when queried
    fs.writeFileSync(env.fakeSchtasksCmd, `@echo off\nexit /b 0`);

    const result = runInstall(env, '-Apply');
    assert.notStrictEqual(result.exitCode, 0);
    assert.match(result.stderr || result.stdout, /Failed to backup and verify manifest/);
});

test('8. audit-only catalog task is queried but never replaced or removed', () => {
    const env = createTestEnv('audit_catalog');
    runInstall(env);
    const log = fs.readFileSync(env.logPath, 'utf8');
    assert.match(log, /\/query.*CodexConnector-CatalogSync/i);
    assert.doesNotMatch(log, /\/delete.*CodexConnector-CatalogSync/i);
    assert.doesNotMatch(log, /\/create.*CodexConnector-CatalogSync/i);
});

test('9. no real scheduler mutation is performed in tests', () => {
    const env = createTestEnv('no_real_mutation');
    const result = runInstall(env, '-Apply');
    assert.strictEqual(result.exitCode, 0);
    const log = fs.readFileSync(env.logPath, 'utf8');
    assert.ok(log.length > 0);
});

test('10. already_running exit code handled gracefully', () => {
    const env = createTestEnv('invoke_already_running');
    const fakeNodeCmd = join(env.testDir, 'node.cmd');
    fs.writeFileSync(fakeNodeCmd, `@echo off\necho {"schema":"bridge-caps-refresh-report-v1","lifecycle_status":"already_running","held_lock":{"error":"malformed"}}\nexit /b 0`);
    const pathEnv = `${env.testDir};${process.env.PATH}`;
    const penv = { ...process.env, PATH: pathEnv, BRIDGE_CAPS_STATE_DIR: env.capsStateDir };

    let result;
    try {
        result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${invokeScript}"`, { cwd: __dirname, encoding: 'utf8', env: penv });
    } catch(e) {
        result = e;
    }

    const logsDir = join(env.capsStateDir, 'scheduler/logs');
    const logs = fs.readdirSync(logsDir).filter(f => !f.endsWith('.tmp'));
    const receipt = JSON.parse(fs.readFileSync(join(logsDir, logs[0]), 'utf8'));
    assert.strictEqual(receipt.ResultClass, 'already_running');
    assert.strictEqual(receipt.WrapperExit, 0);
    assert.strictEqual(receipt.LifecycleStatus, 'already_running');
    assert.strictEqual(receipt.NodeExe.toLowerCase(), fakeNodeCmd.toLowerCase());
    assert.strictEqual(result.status || 0, 0);
});

test('11. stderr is bounded', () => {
    const env = createTestEnv('invoke_stderr_bounded');
    const fakeNodeCmd = join(env.testDir, 'node.cmd');

    // Generate lots of stderr
    let lotsOfStderr = '';
    for(let i=0; i<100; i++) lotsOfStderr += `echo error line ${i} 1>&2\n`;
    fs.writeFileSync(fakeNodeCmd, `@echo off\n${lotsOfStderr}echo {"schema":"bridge-caps-refresh-report-v1","lifecycle_status":"terminal-success","refresh_run_id":"stderr-bounded"}\nexit /b 0`);

    const pathEnv = `${env.testDir};${process.env.PATH}`;
    const penv = { ...process.env, PATH: pathEnv, BRIDGE_CAPS_STATE_DIR: env.capsStateDir };

    try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${invokeScript}"`, { cwd: __dirname, encoding: 'utf8', env: penv });
    } catch(e) {}

    const logsDir = join(env.capsStateDir, 'scheduler/logs');
    const logs = fs.readdirSync(logsDir).filter(f => !f.endsWith('.tmp'));
    const receipt = JSON.parse(fs.readFileSync(join(logsDir, logs[0]), 'utf8'));
    assert.strictEqual(receipt.ResultClass, 'success');
    assert.strictEqual(receipt.NodeExe.toLowerCase(), fakeNodeCmd.toLowerCase());
    const stderrLines = receipt.BoundedStderr.split('\n');
    assert.strictEqual(stderrLines.length, 50);
});

test('12. entrypoint absence throws error', () => {
    const env = createTestEnv('invoke_missing_entrypoint');
    const isolatedRepo = join(env.testDir, 'isolated-repo');
    const isolatedScriptDir = join(isolatedRepo, 'scripts', 'caps');
    const isolatedInvokeScript = join(isolatedScriptDir, 'Invoke-BridgeCapsRefresh.ps1');
    fs.mkdirSync(isolatedScriptDir, { recursive: true });
    fs.copyFileSync(invokeScript, isolatedInvokeScript);

    let errorMsg = '';
    try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${isolatedInvokeScript}"`, { cwd: env.testDir, encoding: 'utf8', env: process.env });
    } catch (e) {
        errorMsg = e.stderr || e.stdout || e.message;
    }
    assert.match(errorMsg, /Built entrypoint dist\\cli\.js not found/);
    assert.ok(fs.existsSync(join(repoRoot, 'dist', 'cli.js')), 'shared built entrypoint must remain untouched');
});

test('13. invoke passes exactly quoted arguments and parses JSON report ID', () => {
    const env = createTestEnv('invoke_arguments');
    const fakeNodeCmd = join(env.testDir, 'node.cmd');
    const fakeNodeLog = join(env.testDir, 'node-args.txt');
    const stateEnvLog = join(env.testDir, 'state-env.txt');
    fs.writeFileSync(fakeNodeCmd, `@echo off\necho %* > "${fakeNodeLog}"\necho %BRIDGE_CAPS_STATE_DIR% > "${stateEnvLog}"\necho {"schema":"bridge-caps-refresh-report-v1","lifecycle_status":"terminal-success","refresh_run_id":"test-abc-123"}\nexit /b 0`);

    const pathEnv = `${env.testDir};${process.env.PATH}`;
    const penv = { ...process.env, PATH: pathEnv, BRIDGE_CAPS_STATE_DIR: env.capsStateDir };

    // Fake dist/cli.js if it doesn't exist
    const distDir = join(repoRoot, 'dist');
    if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
    const cliPath = join(distDir, 'cli.js');
    let createdCli = false;
    if (!fs.existsSync(cliPath)) {
        fs.writeFileSync(cliPath, '');
        createdCli = true;
    }

    try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${invokeScript}"`, { cwd: __dirname, encoding: 'utf8', env: penv });

        const argsLog = fs.readFileSync(fakeNodeLog, 'utf8').trim();
        assert.match(argsLog, /"([^"]+dist\\cli\.js)" caps refresh --lane all/);
        assert.strictEqual(fs.readFileSync(stateEnvLog, 'utf8').trim().toLowerCase(), env.capsStateDir.toLowerCase());

        const logsDir = join(env.capsStateDir, 'scheduler/logs');
        const logs = fs.readdirSync(logsDir).filter(f => !f.endsWith('.tmp'));
        const receipt = JSON.parse(fs.readFileSync(join(logsDir, logs[0]), 'utf8'));

        assert.strictEqual(receipt.RefreshReportId, 'test-abc-123');
        assert.strictEqual(receipt.ResultClass, 'success');
        assert.strictEqual(receipt.WrapperExit, 0);
        assert.strictEqual(receipt.LifecycleStatus, 'terminal-success');
        assert.strictEqual(receipt.NodeExe.toLowerCase(), fakeNodeCmd.toLowerCase());
    } finally {
        if (createdCli) fs.unlinkSync(cliPath);
    }
});

test('14. limited privilege (/RL LIMITED) is requested', () => {
    const env = createTestEnv('limited_priv');
    runInstall(env, '-Apply');
    const log = fs.readFileSync(env.logPath, 'utf8');
    const xmlMatch = log.match(/\/xml "?([^"\s]+\.xml)"?/i);
    assert.ok(xmlMatch);
    const xmlContent = fs.readFileSync(xmlMatch[1], 'utf16le');
    assert.match(xmlContent, /<RunLevel>LeastPrivilege<\/RunLevel>/i);
});

test('15. restore command restores from a valid manifest', () => {
    const env = createTestEnv('restore_manifest');
    const mockBackupXml = join(env.capsStateDir, 'scheduler/backups', 'backup-test.xml');
    if (!fs.existsSync(dirname(mockBackupXml))) fs.mkdirSync(dirname(mockBackupXml), { recursive: true });
    fs.writeFileSync(mockBackupXml, '<Task><Test>Backup</Test></Task>');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(mockBackupXml)).digest('hex').toUpperCase();
    const manifestPath = mockBackupXml + '.manifest';
    fs.writeFileSync(manifestPath, hash);

    const result = runInstall(env, `-Apply -RestoreManifest "${manifestPath}"`);
    assert.strictEqual(result.exitCode, 0);
    assert.match(result.stdout, /Task applied/i);

    const log = fs.readFileSync(env.logPath, 'utf8');
    assert.match(log, /\/create.*\/tn.*Bridge Caps Daily Refresh.*\/xml.*backup-test\.xml/i);
});

test('16. concurrent dual-stream stress regression prevents pipe deadlock', () => {
    const env = createTestEnv('invoke_dual_stream_stress');
    const fakeNodeCmd = join(env.testDir, 'node.cmd');

    // Generate a large but valid JSON report on stdout interleaved with stderr.
    let scriptContent = '@echo off\n';
    scriptContent += 'echo {\n';
    scriptContent += 'echo   "schema": "bridge-caps-refresh-report-v1",\n';
    scriptContent += 'echo   "lifecycle_status": "terminal-success",\n';
    scriptContent += 'echo   "refresh_run_id": "dual-stream-stress",\n';
    scriptContent += 'echo   "padding": [\n';
    // Emitting 1000 JSON strings of ~100 bytes to stdout and 1000 lines to stderr
    // exceeds typical pipe buffers while preserving the real JSON-only CLI contract.
    for(let i=0; i<1000; i++) {
        const comma = i === 999 ? '' : ',';
        scriptContent += `echo     "stdout line ${i} with lots of padding data 1234567890 1234567890 1234567890 1234567890 1234567890"${comma}\n`;
        scriptContent += `echo stderr line ${i} with lots of padding data 1234567890 1234567890 1234567890 1234567890 1234567890 1>&2\n`;
    }
    scriptContent += 'echo   ]\n';
    scriptContent += 'echo }\n';
    scriptContent += `exit /b 0\n`;
    fs.writeFileSync(fakeNodeCmd, scriptContent);

    const pathEnv = `${env.testDir};${process.env.PATH}`;
    const penv = { ...process.env, PATH: pathEnv, BRIDGE_CAPS_STATE_DIR: env.capsStateDir };

    // Fake dist/cli.js if it doesn't exist
    const distDir = join(repoRoot, 'dist');
    if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
    const cliPath = join(distDir, 'cli.js');
    let createdCli = false;
    if (!fs.existsSync(cliPath)) {
        fs.writeFileSync(cliPath, '');
        createdCli = true;
    }

    try {
        // Will deadlock if pipes are read sequentially and buffer fills
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${invokeScript}"`, {
            cwd: __dirname,
            encoding: 'utf8',
            env: penv,
            timeout: 10000 // bounded timeout
        });

        const logsDir = join(env.capsStateDir, 'scheduler/logs');
        const logs = fs.readdirSync(logsDir).filter(f => !f.endsWith('.tmp'));
        const receipt = JSON.parse(fs.readFileSync(join(logsDir, logs[0]), 'utf8'));

        assert.strictEqual(receipt.ResultClass, 'success');
        assert.strictEqual(receipt.WrapperExit, 0);
        assert.strictEqual(receipt.LifecycleStatus, 'terminal-success');
        assert.strictEqual(receipt.RefreshReportId, 'dual-stream-stress');
        assert.strictEqual(receipt.NodeExe.toLowerCase(), fakeNodeCmd.toLowerCase());

        const stderrLines = receipt.BoundedStderr.split('\n');
        assert.strictEqual(stderrLines.length, 50); // receipt bound preserved
    } finally {
        if (createdCli) fs.unlinkSync(cliPath);
    }
});

test('17. terminal-failure report cannot be mislabeled as wrapper success', () => {
    const env = createTestEnv('invoke_terminal_failure');
    const fakeNodeCmd = join(env.testDir, 'node.cmd');
    fs.writeFileSync(fakeNodeCmd, `@echo off\necho {"schema":"bridge-caps-refresh-report-v1","lifecycle_status":"terminal-failure","refresh_run_id":"failed-run"}\nexit /b 0`);

    const pathEnv = `${env.testDir};${process.env.PATH}`;
    const penv = { ...process.env, PATH: pathEnv, BRIDGE_CAPS_STATE_DIR: env.capsStateDir };

    let exitCode = 0;
    try {
        execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${invokeScript}"`, {
            cwd: __dirname,
            encoding: 'utf8',
            env: penv
        });
    } catch (error) {
        exitCode = error.status;
    }

    assert.strictEqual(exitCode, 1);
    const logsDir = join(env.capsStateDir, 'scheduler/logs');
    const logs = fs.readdirSync(logsDir).filter(f => !f.endsWith('.tmp'));
    const receipt = JSON.parse(fs.readFileSync(join(logsDir, logs[0]), 'utf8'));
    assert.strictEqual(receipt.ResultClass, 'error');
    assert.strictEqual(receipt.WrapperExit, 1);
    assert.strictEqual(receipt.ChildExit, 0);
    assert.strictEqual(receipt.LifecycleStatus, 'terminal-failure');
    assert.strictEqual(receipt.RefreshReportId, 'failed-run');
});
