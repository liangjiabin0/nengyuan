const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const moduleDir = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');
const binary = path.join(moduleDir, 'build', 'Release', 'better_sqlite3.node');
const prebuildInstall = path.join(__dirname, '..', 'node_modules', 'prebuild-install', 'bin.js');

if (!fs.existsSync(moduleDir)) process.exit(0);
if (fs.existsSync(binary)) {
  try {
    const Database = require(moduleDir);
    const db = new Database(':memory:');
    db.close();
    process.exit(0);
  } catch (error) {
    console.warn(`[postinstall] 现有 better-sqlite3 与 Node ${process.version} 不兼容，正在替换: ${error.message}`);
    try {
      fs.unlinkSync(binary);
    } catch {
      // prebuild-install --force 会再次尝试覆盖。
    }
  }
}

try {
  execSync(
    `"${process.execPath}" "${prebuildInstall}" --runtime=node --target=${process.versions.node} --force`,
    { cwd: moduleDir, stdio: 'inherit' }
  );
} catch {
  console.warn(`[postinstall] better-sqlite3 预编译包安装失败，请使用 Node ${process.version} 在 node_modules/better-sqlite3 目录运行 prebuild-install --force`);
}
