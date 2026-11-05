import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkPublicSupabaseConfig,readPublicConfig,runDoctor} from '../scripts/check-connections.mjs';

const jwt=(body)=>`eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(body)).toString('base64url')}.synthetic_signature`;
const configured=(url='https://syntheticproject.supabase.co',key='sb_publishable_synthetic_test_key')=>({NEXT_PUBLIC_SUPABASE_URL:url,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:key});

test('doctor accepts each installer project and isolated local Supabase addresses',()=>{
 for(const url of ['https://syntheticproject.supabase.co','https://anotherproject.supabase.co','https://database.example.com','http://127.0.0.1:54321','http://localhost:54321','http://[::1]:54321']){
  assert.ok(checkPublicSupabaseConfig(configured(url)).every(check=>check.status==='OK'),url);
 }
});

test('doctor rejects unsafe URL forms without exposing supplied values',()=>{
 for(const url of ['http://database.example.com','https://user:password@database.example.com','https://database.example.com/rest/v1','https://database.example.com?secret=hidden','not-a-url']){
  const checks=checkPublicSupabaseConfig(configured(url));
  assert.ok(checks.some(check=>check.status==='FAIL'));
  assert.equal(JSON.stringify(checks).includes(url),false);
 }
});

test('doctor rejects either public key slot containing a secret or service-role key',()=>{
 for(const name of ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','NEXT_PUBLIC_SUPABASE_ANON_KEY']){
  for(const key of ['sb_secret_synthetic_private_key',jwt({role:'service_role',ref:'syntheticproject'})]){
   const checks=checkPublicSupabaseConfig({...configured(),[name]:key});
   assert.ok(checks.some(check=>check.status==='FAIL'));
   assert.equal(JSON.stringify(checks).includes(key),false);
  }
 }
});

test('legacy anon keys are scoped to the configured hosted project and malformed payloads fail safely',()=>{
 assert.ok(checkPublicSupabaseConfig(configured(undefined,jwt({role:'anon',ref:'syntheticproject'}))).every(check=>check.status==='OK'));
 assert.ok(checkPublicSupabaseConfig(configured(undefined,jwt({role:'anon',ref:'differentproject'}))).some(check=>check.status==='FAIL'));
 for(const value of [null,[],false,'invalid','a.b.c']){
  const key=typeof value==='string'?value:jwt(value);
  assert.ok(checkPublicSupabaseConfig(configured(undefined,key)).some(check=>check.status==='FAIL'));
 }
});

test('public config loader applies local overrides and ignores server secrets',()=>{
 const directory=mkdtempSync(join(tmpdir(),'merlin-doctor-'));
 try{
  writeFileSync(join(directory,'.env'),'NEXT_PUBLIC_SUPABASE_URL=https://first.example.com\nCLOBE_TOKEN_ENCRYPTION_KEY=synthetic-private-value\n');
  writeFileSync(join(directory,'.env.local'),'NEXT_PUBLIC_SUPABASE_URL="http://localhost:54321"\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_from_file # synthetic comment\n');
  const config=readPublicConfig(directory,{NEXT_PUBLIC_SUPABASE_URL:'https://override.example.com',TOSS_SECRET_KEY:'synthetic-private-value'});
  assert.deepEqual(config,{NEXT_PUBLIC_SUPABASE_URL:'https://override.example.com',NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_from_file'});
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('clean checkout warnings are optional and doctor logs never include configured secrets',()=>{
 const directory=mkdtempSync(join(tmpdir(),'merlin-doctor-'));
 try{
  const output=[];
  assert.equal(runDoctor({directory,environment:{},log:line=>output.push(line)}),0);
  assert.equal(runDoctor({directory,environment:{},strict:true,log:()=>{}}),1);
  const secret='sb_secret_never_print_this_value';
  assert.equal(runDoctor({directory,environment:configured(undefined,secret),log:line=>output.push(line)}),1);
  assert.equal(output.join('\n').includes(secret),false);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
