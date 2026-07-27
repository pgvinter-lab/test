import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] || 'success';
const telemetryPath = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(process.cwd(), `stdio-probe-telemetry-${process.pid}.json`);

const telemetry = {
  pid: process.pid,
  childPid: null,
  mode,
  methods: [],
  envKeys: Object.keys(process.env).sort(),
  runtimePaths: {
    USERPROFILE: process.env.USERPROFILE ?? null,
    TEMP: process.env.TEMP ?? null,
    TMP: process.env.TMP ?? null,
  },
  receivedToolCall: false,
  exitRequested: false,
};

function saveTelemetry() {
  fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
  fs.writeFileSync(telemetryPath, JSON.stringify(telemetry), 'utf8');
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function spawnHangingChild() {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    {
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: 'ignore',
      env: process.env,
    },
  );
  telemetry.childPid = child.pid ?? null;
  saveTelemetry();
}

saveTelemetry();

if (mode === 'early_exit') {
  process.exit(23);
}

function initializeResponse(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'synthetic-stdio-fixture',
        version: '3.0.0',
      },
    },
  };
}

function normalTools() {
  return [
    {
      name: 'fixture_echo',
      description: 'Returns a bounded fixture response.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          apiKey: {
            type: 'string',
            default: 'should-not-be-stored-as-a-secret',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'fixture_status',
      description: 'Reports deterministic fixture status.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ];
}

function handleInitialize(message) {
  if (mode === 'hang_initialize' || mode === 'child_tree_hang') {
    if (mode === 'child_tree_hang') {
      spawnHangingChild();
    }
    return;
  }
  if (mode === 'explicit_error') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32001, message: 'fixture initialization rejected' },
    });
    return;
  }
  if (mode === 'malformed_protocol') {
    process.stdout.write('{this is not json}\n');
    return;
  }
  if (mode === 'oversized_output') {
    for (let index = 0; index < 6; index += 1) {
      send({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'info', data: 'x'.repeat(96 * 1024) },
      });
    }
    return;
  }
  if (mode === 'stderr_overflow') {
    process.stderr.write('e'.repeat(72 * 1024));
    return;
  }
  if (mode === 'secret_stderr') {
    process.stderr.write('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n');
    process.stderr.write('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signaturevalue\n');
    process.stderr.write('OPENAI_API_KEY=sk-fixture-secret-value-1234567890\n');
    setTimeout(() => process.exit(17), 20);
    return;
  }
  if (mode === 'slow_initialize') {
    setTimeout(() => send(initializeResponse(message.id)), 180);
    return;
  }
  send(initializeResponse(message.id));
}

function handleToolsList(message) {
  if (mode === 'hang_tools' || mode === 'total_timeout') {
    return;
  }
  if (mode === 'explicit_error_tools') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32002, message: 'fixture tools/list rejected' },
    });
    return;
  }
  if (mode === 'oversized_schema') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'oversized_schema',
          description: 'Schema exceeds the per-tool byte ceiling.',
          inputSchema: {
            type: 'object',
            properties: {
              payload: {
                type: 'string',
                description: 's'.repeat(70 * 1024),
              },
            },
          },
        }],
      },
    });
    return;
  }
  if (mode === 'total_schema_overflow') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: Array.from({ length: 5 }, (_, index) => ({
          name: `large_schema_${index}`,
          inputSchema: {
            type: 'object',
            properties: {
              payload: {
                type: 'string',
                description: String(index).repeat(55 * 1024),
              },
            },
          },
        })),
      },
    });
    return;
  }
  if (mode === 'description_overflow') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'description_overflow',
          description: 'd'.repeat(9 * 1024),
          inputSchema: { type: 'object', properties: {} },
        }],
      },
    });
    return;
  }
  if (mode === 'deep_schema') {
    let nested = { type: 'string' };
    for (let depth = 0; depth < 80; depth += 1) {
      nested = { type: 'object', properties: { nested } };
    }
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [{
          name: 'deep_schema',
          description: 'Schema exceeds the sanitizer depth ceiling.',
          inputSchema: nested,
        }],
      },
    });
    return;
  }
  send({
    jsonrpc: '2.0',
    id: message.id,
    result: { tools: normalTools() },
  });
}

function handleMessage(message) {
  if (!message || typeof message !== 'object') {
    return;
  }
  if (typeof message.method === 'string') {
    telemetry.methods.push(message.method);
    if (message.method === 'tools/call') {
      telemetry.receivedToolCall = true;
    }
    saveTelemetry();
  }

  if (message.method === 'initialize') {
    handleInitialize(message);
    return;
  }
  if (message.method === 'notifications/initialized') {
    return;
  }
  if (message.method === 'tools/list') {
    handleToolsList(message);
    return;
  }
  if (message.method === 'tools/call') {
    process.stderr.write('tools/call was forbidden\n');
    process.exit(99);
  }
}

let input = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (true) {
    const newline = input.indexOf(0x0a);
    if (newline === -1) {
      break;
    }
    const line = input.subarray(0, newline).toString('utf8').replace(/\r$/, '');
    input = input.subarray(newline + 1);
    if (!line) {
      continue;
    }
    try {
      handleMessage(JSON.parse(line));
    } catch {
      process.stderr.write('fixture received malformed JSON\n');
      process.exit(31);
    }
  }
});

process.stdin.on('end', () => {
  telemetry.exitRequested = true;
  saveTelemetry();
  if (
    mode === 'hang_initialize'
    || mode === 'hang_tools'
    || mode === 'total_timeout'
    || mode === 'child_tree_hang'
    || mode === 'stderr_overflow'
  ) {
    return;
  }
  process.exit(0);
});

const keepAlive = setInterval(() => {}, 1_000);
if (
  mode !== 'hang_initialize'
  && mode !== 'hang_tools'
  && mode !== 'total_timeout'
  && mode !== 'child_tree_hang'
  && mode !== 'stderr_overflow'
) {
  keepAlive.unref();
}
