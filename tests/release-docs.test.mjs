import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const read=path=>readFileSync(resolve(root,path),'utf8');
const markdown=['README.md','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY_NOTICES.md',...readdirSync(resolve(root,'docs')).filter(name=>name.endsWith('.md')).map(name=>'docs/'+name)];

test('release documentation relative links resolve in a fresh source checkout',()=>{
 for(const filename of markdown){
  for(const match of read(filename).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
   const href=match[1].split('#')[0];
   if(!href||/^[a-z][a-z\d+.-]*:/i.test(href))continue;
   assert.ok(existsSync(resolve(root,dirname(filename),decodeURIComponent(href))),`${filename}: ${href}`);
  }
 }
});

test('package metadata and dependency notice inventory agree with the committed lockfile',()=>{
 const pkg=JSON.parse(read('package.json')),lock=JSON.parse(read('package-lock.json'));
 assert.equal(pkg.name,'merlin-finance');
 assert.equal(pkg.license,'MIT');
 assert.equal(lock.name,pkg.name);
 assert.equal(lock.packages[''].name,pkg.name);
 assert.equal(lock.packages[''].license,pkg.license);
 const inventory=read('docs/DEPENDENCY_LICENSES.md');
 for(const [path,entry] of Object.entries(lock.packages)){
  if(!path)continue;
  const license=String(entry.license||'UNDECLARED — inspect package').replaceAll('|','&#124;');
  assert.ok(inventory.includes(`| ${path} | ${entry.version||'(link)'} | ${license} |`),path);
 }
});

test('project MIT notice preserves the included vendor notice separately',()=>{
 const vendor=read('vendor/shadcn-tailwind-4.13.0.LICENSE.md').trim();
 assert.equal(read('LICENSE').trim(),vendor.replace('Copyright (c) 2023 shadcn','Copyright (c) 2026 Merlin Finance contributors'));
 assert.ok(read('THIRD_PARTY_NOTICES.md').includes('vendor/shadcn-tailwind-4.13.0.LICENSE.md'));
});
