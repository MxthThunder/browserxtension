/**
 * Manifest V3 & Extension File Integrity Validator
 */

const fs = require("fs");
const path = require("path");

const EXT_DIR = path.resolve(__dirname, "../pii-agent-extension");
const MANIFEST_PATH = path.join(EXT_DIR, "manifest.json");

console.log("🔍 Validating Chrome Extension at:", EXT_DIR);

if (!fs.existsSync(MANIFEST_PATH)) {
  console.error("❌ manifest.json not found at:", MANIFEST_PATH);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  console.log(`✓ manifest.json is valid JSON (Version ${manifest.version}, MV${manifest.manifest_version})`);
} catch (e) {
  console.error("❌ Failed to parse manifest.json:", e.message);
  process.exit(1);
}

// Required MV3 fields
const requiredFields = ["manifest_version", "name", "version", "description", "icons", "action"];
let missingFields = 0;
requiredFields.forEach((field) => {
  if (!manifest[field]) {
    console.error(`❌ Missing required field: ${field}`);
    missingFields++;
  }
});

if (manifest.manifest_version !== 3) {
  console.error("❌ Manifest version must be 3, found:", manifest.manifest_version);
  missingFields++;
}

// Check referenced files exist
const filesToCheck = [
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  manifest.options_ui?.page,
  ...(manifest.content_scripts?.[0]?.js || []),
  manifest.icons?.["16"],
  manifest.icons?.["48"],
  manifest.icons?.["128"],
];

let missingFiles = 0;
filesToCheck.filter(Boolean).forEach((relPath) => {
  const fullPath = path.join(EXT_DIR, relPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`❌ Referenced file does not exist: ${relPath} (${fullPath})`);
    missingFiles++;
  } else {
    console.log(`✓ Verified file: ${relPath}`);
  }
});

if (missingFields === 0 && missingFiles === 0) {
  console.log("\n🎉 ALL MANIFEST V3 & FILE INTEGRITY CHECKS PASSED!");
  process.exit(0);
} else {
  console.error(`\n❌ Validation failed: ${missingFields} missing fields, ${missingFiles} missing files.`);
  process.exit(1);
}
