import fs from "node:fs";
import { LegacyBridgeFacade } from "../../dist/v2/compat/legacy-core.js";

const [stateRoot, project, lane, sessionId, readyPath, startPath, resultPath] = process.argv.slice(2);
const facade = new LegacyBridgeFacade({
  stateRoot,
  config: {
    agent: lane,
    host: "legacy-race-host",
    sessionId,
    bridgeHome: stateRoot,
    project,
  },
  lane: () => ({ lane, warning: null, ambiguous: false }),
});

try {
  await facade.sync(project);
  fs.writeFileSync(readyPath, "ready\n");
  while (!fs.existsSync(startPath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const result = await facade.claim({ project, paths: ["src/shared-race"], ttlMinutes: 5 });
  fs.writeFileSync(resultPath, JSON.stringify(result));
} finally {
  facade.close();
}
