import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {financeDatasetResponse,getData} from '../lib/finance/data';
import {emptyDataset} from '../lib/finance/types';

test('complete large finance JSON is gzipped below hosting size while every row and metadata round-trips',async()=>{
 const data=structuredClone(emptyDataset);
 data.transactions=Array.from({length:9000},(_,i)=>({id:`synthetic-${i}`,business_id:'business',account_id:'account',upload_id:null,txn_date:'2026-10-07',txn_time:'12:34:56',amount:100+i,direction:'out' as const,description:'Synthetic original bank recipient '.repeat(10),raw_gwamok:'',category_id:null,is_internal:false,balance:1000000-i,tax_invoice:false,dedup_hash:String(i),manually_classified:false,source_details:{basic:'합성 원본 상세정보 '.repeat(20),memo:'Synthetic source memo preserved'}}));
 assert.ok(Buffer.byteLength(JSON.stringify(data))>4.5*1024*1024);
 const response=await financeDatasetResponse(data,performance.now(),new Request('https://merlin.example.test/api/data',{headers:{'Accept-Encoding':'gzip, br'}}));
 assert.equal(response.headers.get('content-encoding'),'gzip');assert.equal(response.headers.get('vary'),'Accept-Encoding');assert.equal(response.headers.get('cache-control'),'private, no-store');
 const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.length<4*1024*1024);assert.deepEqual(JSON.parse(gunzipSync(bytes).toString('utf8')),data);
});
test('small finance JSON remains uncompressed; explicit gzip rejection is respected without dropping fields',async()=>{
 const small=await financeDatasetResponse(emptyDataset,performance.now());assert.equal(small.headers.get('content-encoding'),null);assert.deepEqual(await small.json(),emptyDataset);
 const data=structuredClone(emptyDataset);data.businesses=Array.from({length:1000},(_,i)=>({id:String(i),name:'Synthetic '.repeat(20),representative:'',kind:'개인',reserve:0,color:'#000000'}));
 const response=await financeDatasetResponse(data,performance.now(),new Request('https://merlin.example.test/api/data',{headers:{'Accept-Encoding':'gzip;q=0, *;q=1'}}));
 assert.equal(response.headers.get('content-encoding'),null);assert.deepEqual(await response.json(),data);
});
test('dataset RPC diagnostics contain safe error code/status only, with no owner, source or token content',async()=>{
 const original=console.error,logs:unknown[][]=[];console.error=(...args)=>{logs.push(args);};
 try{
  const db={rpc:async()=>({data:null,status:400,error:{code:'57014',message:'synthetic sensitive owner/source/token error',details:'not logged'}})} as unknown as NonNullable<Parameters<typeof getData>[0]>;
  await assert.rejects(()=>getData(db),/데이터베이스 연결/);
  assert.deepEqual(logs,[['finance dataset RPC failed',{code:'57014',status:400}]]);assert.ok(!JSON.stringify(logs).includes('sensitive'));
 }finally{console.error=original;}
});
