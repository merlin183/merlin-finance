import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot=fileURLToPath(new URL('../',import.meta.url));
async function collectTests(directory){
 const entries=await readdir(directory,{withFileTypes:true});
 const files=[];
 for(const entry of entries){
  const path=join(directory,entry.name);
  if(entry.isDirectory())files.push(...await collectTests(path));
  else if(entry.isFile()&&/\.test\.(?:ts|mjs)$/.test(entry.name))files.push(path);
 }
 return files.sort();
}

const files=await collectTests(join(projectRoot,'tests'));
if(!files.length)throw Error('No .test.ts or .test.mjs files found in tests/.');
console.log(`Running ${files.length} test files on Node ${process.version} using the local tsx and PGlite dependencies.`);
// Resolve the pinned dependency ourselves so an old PGLITE_MODULE setting or
// machine-specific npx cache never affects a clean checkout's tests.
const env={...process.env,NODE_ENV:'test',TZ:'Asia/Seoul',PGLITE_MODULE:import.meta.resolve('@electric-sql/pglite')};
// Tests use synthetic fixtures and an in-memory database. They need no live
// Supabase credentials, even when invoked from a configured developer shell.
for(const key of Object.keys(env))if(/^(?:NEXT_PUBLIC_)?SUPABASE_/.test(key))delete env[key];
const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1','--test-reporter=spec',...files],{
 cwd:projectRoot,env,stdio:'inherit',windowsHide:true,
});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('exit',(code,signal)=>{
 if(signal)console.error(`Test process ended with ${signal}.`);
 process.exitCode=code??1;
});
