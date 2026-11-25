const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
for (const role of ['admin','captain']) test(role + ': stored map links cannot inject markup or scripts into account pages', () => {
  const source = fs.readFileSync(role + '-app.js', 'utf8');
  const context = vm.createContext({URL,encodeURIComponent});
  vm.runInContext(source.match(/^const esc = .*$/m)[0] + '\n' + source.match(/^const mapUrl=.*$/m)[0] + '\nthis.mapLink=mapUrl',context);
  assert.equal(context.mapLink({map_url:'javascript:alert(1)'}),'');
  const link=context.mapLink({map_url:'https://maps.google.com/?q="><img src=x onerror=alert(1)>'});
  assert.ok(!link.includes('<img')); assert.ok(!link.includes('"')); assert.match(link,/^https:\/\/maps.google.com/);
  assert.equal(context.mapLink({map_url:'https://maps.google.com/?q=Damascus'}),'https://maps.google.com/?q=Damascus');
});
