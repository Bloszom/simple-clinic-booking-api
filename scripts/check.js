const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function checkDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) checkDirectory(filename);
    else if (entry.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(1);
    }
  }
}

for (const directory of ['src', 'test', 'scripts']) checkDirectory(directory);
for (const filename of ['package.json', 'postman/clinic-booking.postman_collection.json']) {
  JSON.parse(readFileSync(filename, 'utf8'));
}
console.log('JavaScript syntax and JSON checks passed.');