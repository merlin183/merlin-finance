import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {SupabaseClient} from '@supabase/supabase-js';
import {transferFeeHandler,transferFeeRequestSchema} from '../lib/finance/transfer-fee-request';

const id='00000000-0000-4000-8000-000000000001',transfer='00000000-0000-4000-8000-000000000002',fee='00000000-0000-4000-8000-000000000003',owner='00000000-0000-4000-8000-000000000004';
const input={transaction_id:id,transfer_category_id:transfer,fee_category_id:fee,fee_amount:75,expected:{amount:10075,category_id:null,manually_classified:false,transfer_fee_amount:0,transfer_fee_category_id:null}};
const saved={id,amount:10075,category_id:transfer,is_internal:true,manually_classified:true,transfer_fee_amount:75,transfer_fee_category_id:fee};
const request=(body:unknown=input,origin:string|null='https://finance.example.test')=>new Request('https://finance.example.test/api/transaction-transfer-fee',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
function fixture({authError='',rpcError='',result=saved as unknown}={}){
 let calls=0,authenticated=0;const payloads:unknown[]=[];
 const db={rpc:async(name:string,args:unknown)=>{calls++;payloads.push(args);assert.equal(name,'fd_set_transaction_transfer_fee');return {data:result,error:rpcError?{message:rpcError}:null};}} as unknown as SupabaseClient;
 const handler=transferFeeHandler({authenticate:async()=>{authenticated++;if(authError)throw Error(authError);return {db,ownerId:owner};}});
 return {handler,payloads,counts:()=>({calls,authenticated})};
}
test('fee request accepts explicit allocation and clear but rejects raw bank-field changes and unsafe values',()=>{
 assert.ok(transferFeeRequestSchema.safeParse(input).success);
 assert.ok(transferFeeRequestSchema.safeParse({...input,fee_amount:0,fee_category_id:null}).success);
 for(const patch of [{fee_amount:-1},{fee_amount:10075},{fee_amount:1.5},{fee_amount:Number.MAX_SAFE_INTEGER+1},{fee_category_id:null},{fee_category_id:transfer},{fee_amount:0},{amount:1},{description:'changed'},{txn_date:'2026-01-01'},{owner_id:owner},{transaction_id:'bad'}])assert.equal(transferFeeRequestSchema.safeParse({...input,...patch}).success,false,JSON.stringify(patch));
 for(const expected of [{...input.expected,transfer_fee_amount:5},{...input.expected,transfer_fee_category_id:fee},{...input.expected,transfer_fee_amount:10075,transfer_fee_category_id:fee},{...input.expected,amount:1.5},{...input.expected,extra:1}])assert.equal(transferFeeRequestSchema.safeParse({...input,expected}).success,false);
});
test('same-origin authenticated POST sends exactly allocation payload and verifies canonical saved row',async()=>{
 const mock=fixture();const response=await mock.handler(request());
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,transaction:saved});assert.deepEqual(mock.payloads,[{p_payload:input}]);assert.deepEqual(mock.counts(),{calls:1,authenticated:1});assert.match(response.headers.get('cache-control')||'',/no-store/);
});
test('missing/foreign origin and invalid body cannot invoke allocation RPC',async()=>{
 for(const req of [request(input,null),request(input,'https://other.test')]){const mock=fixture();assert.equal((await mock.handler(req)).status,403);assert.equal(mock.counts().calls,0);assert.equal(mock.counts().authenticated,0);}
 const invalid=fixture();assert.equal((await invalid.handler(request({...input,raw_gwamok:'changed'}))).status,400);assert.equal(invalid.counts().calls,0);
 const huge=fixture();assert.equal((await huge.handler(request({text:'x'.repeat(4097)}))).status,413);assert.equal(huge.counts().calls,0);
 const malformed=fixture();assert.equal((await malformed.handler(new Request('https://finance.example.test/api/transaction-transfer-fee',{method:'POST',headers:{Origin:'https://finance.example.test'},body:'{'}))).status,400);assert.equal(malformed.counts().calls,0);
});
test('authentication, stale snapshot, missing transaction and invalid category return safe errors',async()=>{
 for(const [authError,status] of [['UNAUTHORIZED',401],['ADMIN_REQUIRED',403]] as const){const mock=fixture({authError});assert.equal((await mock.handler(request())).status,status);assert.equal(mock.counts().calls,0);}
 for(const [rpcError,status] of [['TRANSFER_FEE_STALE',409],['TRANSFER_FEE_NOT_FOUND',404],['TRANSFER_FEE_LINKED',400],['INVALID_TRANSFER_FEE_CATEGORY',400],['ADMIN_REQUIRED',403],['sensitive raw database text',500]] as const){
  const mock=fixture({rpcError});const response=await mock.handler(request());assert.equal(response.status,status);assert.ok(!(await response.text()).includes('sensitive'));assert.match(response.headers.get('cache-control')||'',/no-store/);
 }
});
test('mismatched or malformed saved result cannot be reported as success',async()=>{
 for(const result of [null,{...saved,amount:9999},{...saved,id:owner},{...saved,category_id:fee},{...saved,transfer_fee_amount:74},{...saved,transfer_fee_category_id:transfer},{...saved,token:'secret'}]){
  const mock=fixture({result});const response=await mock.handler(request());assert.equal(response.status,502);assert.ok(!(await response.text()).includes('secret'));
 }
});
