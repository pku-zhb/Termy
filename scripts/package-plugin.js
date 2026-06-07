/**
 * Plugin Package Script
 * Package plugin files for distribution
 *
 * Usage:
 *   node scripts/package-plugin.js        # Package for current platform
 *   node scripts/package-plugin.js --zip  # Create ZIP archive
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.join(__dirname, '..');
const PACKAGE_DIR = path.join(ROOT_DIR, 'plugin-package');
const createZip = process.argv.includes('--zip');

// 1. Check required files
console.log('🔍 Checking required files...');
const coreFiles = [
  'main.js',
  'manifest.json',
  'styles.css'
];
const packageFiles = [...coreFiles];

for (const file of packageFiles) {
  const filePath = path.join(ROOT_DIR, file);
  if (!fs.existsSync(filePath)) {
    console.error(`❌ Error: Missing required file ${file}`);
    console.error('Please run pnpm build first and ensure the plugin bundle files are present');
    process.exit(1);
  }
}
console.log('✅ All required files exist');
console.log('');

console.log('');

// 3. Clean and create package directory
if (fs.existsSync(PACKAGE_DIR)) {
  fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });
}
fs.mkdirSync(PACKAGE_DIR, { recursive: true });

console.log('📋 Copying files to package directory...');

// 4. Copy package files
for (const file of packageFiles) {
  const srcPath = path.join(ROOT_DIR, file);
  const destPath = path.join(PACKAGE_DIR, file);
  fs.copyFileSync(srcPath, destPath);
  console.log(`  ✓ ${file}`);
}

console.log('');


// 7. Create ZIP if requested
if (createZip) {
  console.log('📦 Creating ZIP archive...');
  
  // Read version from manifest
  const manifestPath = path.join(PACKAGE_DIR, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = manifest.version || '0.0.0';
  
  const zipName = `termy-${version}.zip`;
  const zipPath = path.join(ROOT_DIR, zipName);
  
  // Remove existing ZIP
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
  
  try {
    // Use PowerShell Compress-Archive (Windows) or zip command (Unix)
    if (process.platform === 'win32') {
      execSync(
        `powershell -Command "Compress-Archive -Path '${PACKAGE_DIR}\\*' -DestinationPath '${zipPath}' -Force"`,
        { stdio: 'inherit' }
      );
    } else {
      execSync(
        `cd "${PACKAGE_DIR}" && zip -r "${zipPath}" .`,
        { stdio: 'inherit' }
      );
    }
    
    const zipStats = fs.statSync(zipPath);
    const zipSizeMB = (zipStats.size / 1024 / 1024).toFixed(2);
    console.log(`  ✅ ZIP created: ${zipName} (${zipSizeMB} MB)`);
  } catch (error) {
    console.error('  ❌ Failed to create ZIP:', error.message);
    console.log('  💡 Tip: You can manually compress the plugin-package/ directory');
  }
  
  console.log('');
}

// 8. Complete
console.log('🎉 Package complete!');
console.log(`📂 Package location: ${PACKAGE_DIR}`);

if (createZip) {
  console.log('');
  console.log('📦 Next steps:');
  console.log('  1. Test the packaged plugin in Obsidian');
  console.log('  2. Upload to GitHub Releases');
  console.log('  3. Submit to Obsidian community plugins');
}
