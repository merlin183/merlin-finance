import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clobeImportHandlers} from '../lib/clobe/import-route';

test('Clobe import routes require authenticated same-origin JSON, bound sizes and sanitized errors',async()=>{
 let authenticateCalls=0,sourceCalls=0;
 const handlers=clobeImportHandlers({getOrigin:()=> 'https://merlin.example.test',authenticate:async()=>{
  authenticateCalls++;return {openSession:async()=>{sourceCalls++;throw Error('private OAuth/provider secret');},makeDependencies:()=>({userId:'actor',ownerId:'owner',getDataset:async()=>{throw Error('secret DB connection');},getRefs:async()=>[],fetchSource:async()=>[],rpc:async()=>({mappings:[]})})};
 }});
 const badOrigin=await handlers.POST(new Request('https://merlin.example.test/api/clobe/import',{method:'POST',headers:{Origin:'https://other.test','Content-Type':'application/json'},body:'{}'}));
 assert.equal(badOrigin.status,400);assert.equal(authenticateCalls,0);
 const financialInjection=await handlers.POST(new Request('https://merlin.example.test/api/clobe/import',{method:'POST',headers:{Origin:'https://merlin.example.test','Content-Type':'application/json'},body:JSON.stringify({action:'apply',previewId:'10000000-0000-4000-8000-000000000001',choices:[],amount:1234})}));
 assert.equal(financialInjection.status,400);assert.equal(authenticateCalls,0);
 const huge=await handlers.POST(new Request('https://merlin.example.test/api/clobe/import',{method:'POST',headers:{Origin:'https://merlin.example.test','Content-Type':'application/json','Content-Length':String(3*1024*1024)},body:'{}'}));assert.equal(huge.status,400);
 const settings=await handlers.GET();assert.equal(settings.status,200);assert.equal(settings.headers.get('cache-control'),'private, no-store');assert.deepEqual(await settings.json(),{mappings:[]});assert.equal(sourceCalls,0);
 const wrongJson=await handlers.POST(new Request('https://merlin.example.test/api/clobe/import',{method:'POST',headers:{Origin:'https://merlin.example.test','Content-Type':'application/json'},body:'{'}));assert.equal(wrongJson.status,400);
 const unauthorized=clobeImportHandlers({getOrigin:()=> 'https://merlin.example.test',authenticate:async()=>{throw Error('UNAUTHORIZED');}});assert.equal((await unauthorized.GET()).status,401);
});
