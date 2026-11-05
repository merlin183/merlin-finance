import assert from 'node:assert/strict';
import test from 'node:test';
import {getBackupData} from '../lib/finance/data';
import {resources} from '../lib/finance/types';

type Row=Record<string,unknown>;
type Result={data:Row[];error:null|{message:string}};
type Call={table:string;columns?:string;cutoff?:string;sort?:string;ascending?:boolean;limit?:number;after?:string};
function fixture(tables:Record<string,Row[]>,calls:Call[],errorTable?:string,options:{register?:unknown;registerError?:boolean;rpcCalls?:string[]}={}){
 const db={from:(table:string)=>{
  const call:Call={table};calls.push(call);
  const query={
   select:(columns:string)=>{call.columns=columns;return query;},
   lte:(field:string,value:string)=>{assert.equal(field,'created_at');call.cutoff=value;return query;},
   order:(field:string,options:{ascending:boolean})=>{call.sort=field;call.ascending=options.ascending;return query;},
   limit:(limit:number)=>{call.limit=limit;return query;},
   gt:(field:string,value:string)=>{assert.equal(field,'id');call.after=value;return query;},
   then:(resolve:(value:Result)=>unknown,reject:(reason:unknown)=>unknown)=>{
    const rows=[...(tables[table]||[])].filter(row=>(!call.after||String(row.id)>call.after)&&String(row.created_at)<=call.cutoff!)
     .sort((a,b)=>String(a[call.sort!]).localeCompare(String(b[call.sort!]))*(call.ascending?1:-1)).slice(0,call.limit);
    return Promise.resolve({data:rows,error:table===errorTable?{message:'Synthetic error'}:null}).then(resolve,reject);
   },
  };
  return query;
 },rpc:async(name:string)=>{
  assert.equal(name,'fd_read_intercompany_register','raw resources must not use the display projection RPC');
  options.rpcCalls?.push(name);
  return {data:options.register??{baseline:null,entries:[]},error:options.registerError?{message:'Synthetic private database error'}:null};
 },auth:{getUser:()=>{throw Error('Repeated authentication');}}};
 return db as unknown as Parameters<typeof getBackupData>[0];
}

test('full backup preserves arbitrary stored metadata and all keyset pages using the authenticated client',async()=>{
 const tables=Object.fromEntries(Object.values(resources).map(table=>[table,[{id:'0001',owner_id:'synthetic-owner',created_at:'2026-01-01T00:00:00Z',extra_stored_field:{retained:true}}]]));
 tables.fd_transactions=Array.from({length:1001},(_,index)=>({id:String(index+1).padStart(5,'0'),owner_id:'synthetic-owner',created_at:'2026-01-01T00:00:00Z',extra_stored_field:{retained:true}}));
 const calls:Call[]=[],rpcCalls:string[]=[],result=await getBackupData(fixture(tables,calls,undefined,{rpcCalls}));
 for(const [key,table] of Object.entries(resources))assert.deepEqual(result[key as keyof typeof resources],tables[table]);
 assert.equal(result.transactions.length,1001);
 assert.ok(calls.every(call=>call.columns==='*'));
 assert.equal(new Set(calls.map(call=>call.cutoff)).size,1);
 assert.deepEqual(calls.filter(call=>call.table==='fd_transactions').map(call=>call.after),[undefined,'01000']);
 assert.equal(calls.length,14);
 assert.deepEqual(result.cash_plan_series,[]);
 assert.deepEqual(result.cash_plan_series_revisions,[]);
 assert.deepEqual(rpcCalls,['fd_read_intercompany_register']);
 assert.deepEqual(result.intercompany_register,{baseline:null,entries:[]});
});

test('backup preserves newest upload ordering and the historical newest-100 audit limit including actor fields',async()=>{
 const row=(id:string,created_at:string)=>({id,created_at,owner_id:'synthetic-owner',actor_id:'synthetic-actor'});
 const uploads=[row('0001','2026-01-01T00:00:00Z'),row('0002','2026-02-01T00:00:00Z')];
 const audit=Array.from({length:120},(_,i)=>row(String(i).padStart(4,'0'),new Date(Date.UTC(2026,0,1,0,i)).toISOString()));
 const result=await getBackupData(fixture({fd_uploads:uploads,fd_audit_log:audit},[]));
 assert.deepEqual(result.uploads,[uploads[1],uploads[0]]);
 assert.deepEqual(result.audit,[...audit].reverse().slice(0,100));
});

test('backup query failure rejects the export instead of returning partial data',async()=>{
 await assert.rejects(getBackupData(fixture({},[],'fd_transactions')),/자료를 불러오지 못했습니다/);
 await assert.rejects(getBackupData(fixture({},[],'fd_cash_plan_series')),/자료를 불러오지 못했습니다/);
});

test('full JSON backup includes the safe standalone intercompany source and manual records without changing raw ledger metadata',async()=>{
 const register={baseline:{source_url:'https://docs.google.com/spreadsheets/d/synthetic-document/edit',gid:'1',mirror_gid:'2',mirror_sheet_name:'Synthetic register',as_of:'2020-10-16',coverage_start:null,opening_balance_known:false,totals_include_additions:true,notes:['Synthetic opening balance unknown'],businesses:[{key:'a',name:'Synthetic A',business_id:null},{key:'b',name:'Synthetic B',business_id:null}],pairs:[{business_a:'a',business_b:'b',a_to_b:5000,b_to_a:1000,note:'Synthetic source'}],additions:[]},entries:[{id:'20000000-0000-4000-8000-000000000001',from_party:'a',to_party:'b',entry_date:'2020-10-20',amount:1000,kind:'loan',memo:'Synthetic note',version:1,voided:false,sheet_row:2,created_at:'2020-10-20T00:00:00Z',updated_at:'2020-10-20T00:00:00Z',sheet_status:'pending',sheet_synced_at:null,sheet_error:''}]};
 const stored={id:'0001',created_at:'2020-10-20T00:00:00Z',owner_id:'synthetic-owner',extra_stored_field:{retained:true}};
 const rpcCalls:string[]=[],result=await getBackupData(fixture({fd_transactions:[stored]},[],undefined,{register,rpcCalls}));
 assert.deepEqual(result.intercompany_register,register);assert.deepEqual(result.transactions,[stored]);assert.deepEqual(rpcCalls,['fd_read_intercompany_register']);
 assert.ok(!('sheet_lease_token'in result.intercompany_register.entries[0]));
});

test('register lookup or shape failure rejects the entire export without including private provider errors or bookkeeping tokens',async()=>{
 await assert.rejects(getBackupData(fixture({},[],undefined,{registerError:true})),error=>error instanceof Error&&/전체 백업을 중단/.test(error.message)&&!error.message.includes('private'));
 for(const register of [{baseline:null,entries:'invalid'},{baseline:null,entries:[],sheet_lease_token:'sensitive'},{baseline:{source_url:'invalid'},entries:[]}])await assert.rejects(getBackupData(fixture({},[],undefined,{register})),/기록 형식을 확인하지 못해 전체 백업을 중단/);
});
