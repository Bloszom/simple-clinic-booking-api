const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Script } = require('node:vm');

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

function checkPostmanScripts(items) {
  for (const item of items) {
    for (const event of item.event || []) new Script(event.script.exec.join('\n'), { filename: item.name });
    if (item.item) checkPostmanScripts(item.item);
  }
}

checkPostmanScripts(JSON.parse(readFileSync('postman/clinic-booking.postman_collection.json', 'utf8')).item);
console.log('JavaScript, JSON and Postman script syntax checks passed.');