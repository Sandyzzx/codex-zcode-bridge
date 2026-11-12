import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnClaimOnlyWorker } from "../src/manager/spawn-worker.js";

for (const interactionChannel of [false, true]) {
  for (const exitCode of [0, 23]) {
    test(`production Spawner drains stderr before Result and exit ${exitCode} (interaction=${interactionChannel})`, { timeout: 15_000 }, async (t) => {
      const root = mkdtempSync(path.join(tmpdir(), "bridge-stderr-"));
      const worker = path.join(root, "worker.mjs");
      const totalBytes = 8 * 1024 * 1024;
      writeFileSync(worker, `
        import { writeSync } from 'node:fs';
        const chunk = Buffer.alloc(64 * 1024, 120);
        let bytes = 0;
        while (bytes < ${totalBytes}) bytes += writeSync(2, chunk);
        writeSync(6, JSON.stringify({ bytes }) + '\\n');
        process.exit(${exitCode});
      `);
      const child = spawnClaimOnlyWorker(worker, {
        bridge: { path: null, sha256: null }, worker: { path: worker, sha256: null },
      }, { interactionChannel });
      const closed = once(child, "close");
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
        rmSync(root, { recursive: true, force: true });
      });
      // Deliberately no stderr listener/recorder. This must finish with the
      // same Spawner setup used by the production lifecycle driver.
      const frames: Buffer[] = [];
      for await (const chunk of child.resultChannel!) frames.push(Buffer.from(chunk));
      assert.deepEqual(JSON.parse(Buffer.concat(frames).toString("utf8")), { bytes: totalBytes });
      const [code, signal] = await closed;
      assert.equal(code, exitCode);
      assert.equal(signal, null);
    });
  }
}
