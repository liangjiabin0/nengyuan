import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runDirectory } from "../src/lib/power-compute/store";
import { importDirectory } from "../src/lib/power-compute/imports";
import { modelPath } from "../src/lib/power-compute/models";

const originalCwd = process.cwd();
const tempRoot = fs.realpathSync(os.tmpdir());
const sandbox = fs.mkdtempSync(path.join(tempRoot, "ai4es-power-storage-"));
const linkType = process.platform === "win32" ? "junction" : "dir";
try {
  for (const linked of [false, true]) {
    const release = path.join(sandbox, linked ? "linked" : "physical");
    fs.mkdirSync(release);
    const storage = linked
      ? path.join(sandbox, "shared-storage")
      : path.join(release, "storage");
    fs.mkdirSync(storage);
    if (linked) fs.symlinkSync(storage, path.join(release, "storage"), linkType);
    process.chdir(release);

    for (const [directory, name] of [
      [runDirectory, "power-runs"],
      [importDirectory, "power-imports"],
    ] as const) {
      const id = randomUUID();
      const location = directory(id);
      assert.equal(location, path.join(storage, name, id));
      fs.mkdirSync(location);
      fs.writeFileSync(path.join(location, "input.json"), "{}");
      assert.equal(directory(id), location);
      assert.equal(fs.readFileSync(path.join(directory(id), "input.json"), "utf8"), "{}");
      assert.throws(() => directory("../outside"));

      const redirected = randomUUID();
      const outside = path.join(sandbox, linked + "-" + name);
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(storage, name, redirected), linkType);
      assert.throws(() => directory(redirected), /非法链接|目录无效/);
    }

    for (const engine of ["pandapower", "pypsa", "andes"] as const) {
      const filename = modelPath({ id: randomUUID(), engine });
      fs.writeFileSync(filename, "model");
      assert.equal(fs.realpathSync(filename), filename);
      assert.equal(path.dirname(filename), path.join(storage, "power-models"));
    }

    // A shared storage root is supported; redirecting one calculation subtree is not.
    fs.renameSync(path.join(storage, "power-models"), path.join(storage, "saved-models"));
    fs.symlinkSync(path.join(storage, "saved-models"), path.join(storage, "power-models"), linkType);
    assert.throws(() => modelPath({ id: randomUUID(), engine: "pypsa" }), /非法链接/);
  }
  console.log("Power storage paths PASS: physical/shared storage and redirected-child rejection");
} finally {
  process.chdir(originalCwd);
  assert.equal(path.dirname(sandbox), tempRoot);
  assert.ok(path.basename(sandbox).startsWith("ai4es-power-storage-"));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
