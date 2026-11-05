import assert from 'node:assert/strict';
import test from 'node:test';
import {getSheetImportData} from '../lib/finance/data';

type Client=Parameters<typeof getSheetImportData>[0];
const keys=['businesses','accounts','categories','rules','aliases','transactions','links','notes'] as const;
function fixture():Record<string,unknown[]>{return Object.fromEntries(keys.map(key=>[key,[]]));}
function client(response:unknown,calls:string[]){
 return {rpc:async(name:string)=>{calls.push(name);return response;},from:()=>{throw Error('Unexpected table request');},auth:{getUser:()=>{throw Error('Repeated authentication');}}} as unknown as Client;
}

test('sheet matching reads only its context once and keeps complete transaction identity and classifications',async()=>{
 const calls:string[]=[],data=fixture();
 const transaction={id:'synthetic',txn_date:'2025-01-01',txn_time:'12:34:56',source_details:{provenance:{sheet:'Synthetic',row:8,url:'https://example.test/source'}},balance:2400,category_id:'manual',manually_classified:true,tax_invoice:true,transfer_fee_amount:500,transfer_fee_category_id:'fee'};
 data.transactions=[transaction];data.notes=[{memo:'Synthetic shared memo'}];data.links=[{out_transaction_id:'synthetic'}];
 const loaded=await getSheetImportData(client({data,error:null},calls));
 assert.deepEqual(calls,['fd_read_sheet_import_context']);
 assert.equal(loaded.transactions[0],transaction);assert.equal(loaded.notes,data.notes);assert.equal(loaded.links,data.links);
 assert.deepEqual(loaded.recurring,[]);assert.deepEqual(loaded.uploads,[]);assert.deepEqual(loaded.audit,[]);
 assert.equal(Object.hasOwn(loaded,'cash_plan_series'),false);assert.equal(Object.hasOwn(loaded,'bank_plan_actuals'),false);
});

test('missing context arrays fail closed rather than planning with an incomplete ledger',async()=>{
 for(const key of keys){
  const data=fixture();delete data[key];
  await assert.rejects(getSheetImportData(client({data,error:null},[])),/자료 형식/);
 }
 await assert.rejects(getSheetImportData(client({data:null,error:null},[])),/자료 형식/);
});

test('sheet context errors keep auth classification and never retry or fall back to full UI reads',async()=>{
 for(const [code,message,pattern] of [['42501','UNAUTHORIZED',/^Error: UNAUTHORIZED$/],['42501','ADMIN_REQUIRED',/^Error: ADMIN_REQUIRED$/],['57014','synthetic timeout',/데이터베이스 연결/],['PGRST202','synthetic missing function',/데이터베이스 연결/]] as const){
  const calls:string[]=[];
  await assert.rejects(getSheetImportData(client({data:null,error:{code,message},status:500},calls)),pattern);
  assert.deepEqual(calls,['fd_read_sheet_import_context']);
 }
});
