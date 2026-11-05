import assert from 'node:assert/strict';
import test from 'node:test';
import {getData} from '../lib/finance/data';
import {emptyDataset,type Dataset} from '../lib/finance/types';

type Client=NonNullable<Parameters<typeof getData>[0]>;
function client(response:unknown,calls:string[]){
 return {rpc:async(name:string)=>{calls.push(name);return response;},from:()=>{throw Error('Unexpected table request');},auth:{getUser:()=>{throw Error('Repeated authentication');}}} as unknown as Client;
}
test('dataset loader reuses request client and reads every resource with one RPC',async()=>{
 const calls:string[]=[];
 const data={...structuredClone(emptyDataset),cash_plan_series:[],cash_plan_series_revisions:[]};
 data.businesses.push({id:'synthetic',name:'Synthetic',representative:'',kind:'개인',reserve:0,color:'#000000'});
 assert.equal(await getData(client({data,error:null},calls)),data);
 assert.deepEqual(calls,['fd_read_finance_snapshot']);
});
test('은행 조회 addon은 제공될 때만 검증하고 legacy 응답의 참조를 보존한다',async()=>{
 const legacy={...structuredClone(emptyDataset),cash_plan_series:[],cash_plan_series_revisions:[]},loaded=await getData(client({data:legacy,error:null},[]));
 assert.equal(loaded,legacy);assert.equal(Object.hasOwn(loaded,'bank_plan_actuals'),false);assert.equal(Object.hasOwn(loaded,'bank_plan_coverage'),false);
 const extra={...legacy,bank_plan_actuals:[{account_id:'unowned',business_id:'unknown'}],bank_plan_coverage:[]} as unknown as Dataset;
 const normalized=await getData(client({data:extra,error:null},[]));
 assert.notEqual(normalized,extra);assert.deepEqual(normalized.bank_plan_actuals,[]);assert.deepEqual(normalized.bank_plan_coverage,[]);
 assert.equal(extra.bank_plan_actuals?.length,1);
});
test('dataset loader preserves authorization failure classification and never falls back to table reads',async()=>{
 for(const error of ['UNAUTHORIZED','ADMIN_REQUIRED']){
  const calls:string[]=[];
  await assert.rejects(getData(client({data:null,error:{message:error}},calls)),new RegExp('^Error: '+error+'$'));
  assert.deepEqual(calls,['fd_read_finance_snapshot']);
 }
 const calls:string[]=[];
 await assert.rejects(getData(client({data:null,error:{message:'function missing: synthetic internal detail'}},calls)),/데이터베이스 연결/);
 assert.deepEqual(calls,['fd_read_finance_snapshot']);
});
test('incomplete dataset is rejected instead of silently replacing existing client data',async()=>{
 for(const data of [null,{}, {...emptyDataset,transactions:null}])await assert.rejects(getData(client({data,error:null},[])),/자료 형식/);
 await assert.rejects(getData(client({data:structuredClone(emptyDataset),error:null},[])),/월 고정비·할부 계획/);
});

test('JSON snapshot 조회는 시간 초과도 자동 재시도하거나 이전의 무거운 RPC로 대체하지 않는다',async()=>{
 const data={...structuredClone(emptyDataset),cash_plan_series:[],cash_plan_series_revisions:[]};let attempts=0;
 const db={rpc:async(name:string)=>{assert.equal(name,'fd_read_finance_snapshot');attempts++;return {data,error:null,status:200};},from:()=>{throw Error('Unexpected table request');}} as unknown as Client;
 assert.equal(await getData(db),data);assert.equal(attempts,1);
 for(const code of ['57014','42501','PGRST301']){
  let calls=0;
  const failed={rpc:async()=>{calls++;return {data:null,error:{code,message:'synthetic unavailable'},status:500};}} as unknown as Client;
  await assert.rejects(getData(failed),/데이터베이스 연결/);assert.equal(calls,1);
 }
});
