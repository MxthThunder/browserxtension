const fs = require('fs');
const path = require('path');

const extDir = path.resolve(__dirname, '../pii-agent-extension');
console.log('--- Checking Imports and Resources in:', extDir);

let errorsFound = 0;

// 1. Check ES module imports in JS files
const jsFiles = fs.readdirSync(extDir).filter(f => f.endsWith('.js'));
for (const file of jsFiles) {
  const content = fs.readFileSync(path.join(extDir, file), 'utf8');
  const importMatches = [...content.matchAll(/import\s+(?:(?:\{[^}]+\}|\w+|\*\s+as\s+\w+)\s+from\s+)?['"]([^'"]+)['"]/g)];
  for (const m of importMatches) {
    const importPath = m[1];
    if (importPath.startsWith('.')) {
      const resolved = path.resolve(extDir, importPath);
      if (!fs.existsSync(resolved)) {
        console.error(`❌ Missing import in ${file} -> ${importPath} (${resolved})`);
        errorsFound++;
      } else {
        console.log(`✓ Import resolved: ${file} -> ${importPath}`);
      }
    }
  }
}

// 2. Check script and link tags in HTML files
const htmlFiles = fs.readdirSync(extDir).filter(f => f.endsWith('.html'));
for (const hFile of htmlFiles) {
  const content = fs.readFileSync(path.join(extDir, hFile), 'utf8');
  const scriptMatches = [...content.matchAll(/<script[^>]*src=["']([^"']+)["'][^>]*>/gi)];
  for (const sm of scriptMatches) {
    const tag = sm[0];
    const src = sm[1];
    if (!src.startsWith('http://') && !src.startsWith('https://')) {
      const resolved = path.resolve(extDir, src);
      if (!fs.existsSync(resolved)) {
        console.error(`❌ Missing script in ${hFile} -> ${src} (${resolved})`);
        errorsFound++;
      } else {
        const isModule = /type=["']module["']/i.test(tag);
        const targetContent = fs.readFileSync(resolved, 'utf8');
        const hasModuleSyntax = /\b(import\s+|export\s+)/.test(targetContent);
        if (hasModuleSyntax && !isModule) {
          console.error(`❌ Bug: Script tag in ${hFile} for ${src} lacks type="module" but file uses import/export!`);
          errorsFound++;
        } else {
          console.log(`✓ Script tag OK: ${hFile} -> ${src} (${isModule ? 'module' : 'classic'})`);
        }
      }
    }
  }

  const cssMatches = [...content.matchAll(/<link[^>]*href=["']([^"']+)["'][^>]*>/gi)];
  for (const cm of cssMatches) {
    const href = cm[1];
    if (!href.startsWith('http://') && !href.startsWith('https://')) {
      const resolved = path.resolve(extDir, href);
      if (!fs.existsSync(resolved)) {
        console.error(`❌ Missing CSS link in ${hFile} -> ${href}`);
        errorsFound++;
      } else {
        console.log(`✓ CSS link OK: ${hFile} -> ${href}`);
      }
    }
  }
}

// 3. Check models and lib folders
console.log('\n--- Checking models and lib folders ---');
const libDir = path.join(extDir, 'lib');
if (fs.existsSync(libDir)) {
  console.log('Lib folder items:', fs.readdirSync(libDir));
} else {
  console.error('❌ Lib folder does not exist!');
  errorsFound++;
}

const modelsDir = path.join(extDir, 'models');
if (fs.existsSync(modelsDir)) {
  console.log('Models folder items:', fs.readdirSync(modelsDir));
} else {
  console.error('❌ Models folder does not exist!');
  errorsFound++;
}

console.log(`\nScan finished with ${errorsFound} issues.`);
