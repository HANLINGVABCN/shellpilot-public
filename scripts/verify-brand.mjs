import assert from 'node:assert/strict';
import fs from 'node:fs';
const config=JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json','utf8'));
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
assert.equal(config.identifier,'app.shellpilot.client');
assert.equal(config.productName,'ShellPilot');
assert.equal(config.bundle.publisher,'ShellPilot');
assert.equal(pkg.author,'ShellPilot');
for(const file of ['src-tauri/tauri.conf.json','package.json','src-tauri/src/lib.rs','server-rs/src/mcp.rs']){
  const text=fs.readFileSync(file,'utf8');
  assert(!text.toLowerCase().includes('hanling'),`${file} must not include personal brand names`);
}
const app=fs.readFileSync('src-tauri/src/lib.rs','utf8');
const mcp=fs.readFileSync('server-rs/src/mcp.rs','utf8');
assert(app.includes('app.path().data_dir().map(|base| base.join("ShellPilot"))'));
assert(mcp.includes('base.join("ShellPilot")'));
assert(!mcp.includes('modern.exists'),'MCP default must not migrate or fall back to legacy directories');
console.log('PASS: neutral application ID, publisher, authors, desktop/MCP data directory and no legacy migration code');
