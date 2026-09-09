/**
 * Production Packaging Script for Chrome Web Store Distribution
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const EXT_DIR = path.resolve(__dirname, "../pii-agent-extension");
const DIST_DIR = path.resolve(__dirname, "../dist");
const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");

if (!fs.existsSync(DIST_DIR)) {
  fs.mkdirSync(DIST_DIR, { recursive: true });
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const zipName = `pii-agent-extension-v${manifest.version}.zip`;
const zipPath = path.join(DIST_DIR, zipName);

console.log(`📦 Packaging Chrome Extension v${manifest.version} into ${zipName}...`);

try {
  // Use PowerShell Compress-Archive on Windows
  if (process.platform === "win32") {
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }
    const cmd = `powershell -Command "Compress-Archive -Path '${EXT_DIR}\\*' -DestinationPath '${zipPath}' -Force"`;
    execSync(cmd, { stdio: "inherit" });
  } else {
    execSync(`cd "${EXT_DIR}" && zip -r "${zipPath}" ./*`, { stdio: "inherit" });
  }

  const stats = fs.statSync(zipPath);
  const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`\n🎉 Packaging complete! Created:`);
  console.log(`   📂 ${zipPath} (${sizeMb} MB)`);
  console.log(`   🚀 Ready for deployment to Chrome Web Store or enterprise sideloading!`);
} catch (err) {
  console.error("❌ Packaging error:", err.message);
  process.exit(1);
}
