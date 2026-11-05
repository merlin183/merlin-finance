import test from 'node:test';
import assert from 'node:assert/strict';
import type {SupabaseClient} from '@supabase/supabase-js';
import {intercompanySheetSyncHandlers} from '../lib/finance/intercompany-sheet-sync-route';
import {IntercompanySheetError} from '../lib/finance/intercompany-sheet';
import type {IntercompanyRegisterData} from '../lib/finance/intercompany-register';
import {ids,syntheticRegister,syntheticRaw} from './helpers/intercompany-source-fixture';

const request=(body:unknown={},origin:string|null='https://finance.example.test')=>new Request('https://finance.example.test/api/intercompany-sheet-sync',{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)});
const responseBody=async(r:Response)=>await r.json() as {summary:Record<string,unknown>;register:IntercompanyRegisterData;error:string;row:number;sheetWarning:string};
function fixture(options:{auth?:string;beginError?:string;applyError?:string;providerError?:boolean;sourceChanged?:boolean;malformed?:boolean;pending?:boolean}={}){
 let register=syntheticRegister(),reads=0,writes=0,providerCalls=0;const calls:{name:string;args:Record<string,unknown>|undefined}[]=[],raw=syntheticRaw(register);
 if(options.pending)register.entries[0].sheet_status='pending';
 const db={rpc:async(name:string,args?:Record<string,unknown>)=>{
  calls.push({name,args});
  if(name==='fd_begin_intercompany_sheet_sync')return {data:{token:ids.token,revision:0,baseline_hash:'synthetic-baseline',native_hash:'synthetic-native',register},error:options.beginError?{message:options.beginError}:null};
  if(name==='fd_apply_intercompany_sheet_sync'){
   if(options.applyError)return {data:null,error:{message:options.applyError}};
   writes++;register={...register,sheet_sync:{...(args!.p_snapshot as NonNullable<typeof register.sheet_sync>),revision:1,synced_at:'2020-10-21T00:05:00Z'}};
   return {data:{register:options.malformed?{secret:'sensitive provider content'}:register,changed_rows:0,amended_entries:0,unchanged:true},error:null};
  }
  if(name==='fd_claim_intercompany_sheet_for_sync')return {data:null,error:null};
  if(name==='fd_read_intercompany_register')return {data:register,error:null};
  if(name==='fd_end_intercompany_sheet_sync')return {data:true,error:null};
  throw Error('Unexpected RPC');
 }} as unknown as Pick<SupabaseClient,'rpc'>;
 const handlers=intercompanySheetSyncHandlers({authenticate:async()=>{if(options.auth)throw Error(options.auth);return {db};},newId:()=>ids.request,
  readSource:async()=>{providerCalls++;if(options.providerError)throw new IntercompanySheetError('authorization');reads++;return options.sourceChanged&&reads>1?{...raw,fingerprint:'changed-after-plan'}:raw;},
  stampIdentifiers:async(_b,value)=>value,reconcileSource:async(_b,value)=>value,normalizeFormulas:async(_b,value)=>value,syncEntry:async()=>{throw Error('No financial test writes allowed');}});
 return {handlers,calls,raw,counts:()=>({reads,writes,providerCalls})};
}
test('관리자와 같은 출처 검증 전 시트·DB 작업을 시작하지 않는다',async()=>{
 for(const auth of ['UNAUTHORIZED','ADMIN_REQUIRED']){const f=fixture({auth}),r=await f.handlers.POST(request());assert.equal(r.status,auth==='UNAUTHORIZED'?401:403);assert.equal(f.calls.length,0);assert.equal(f.counts().providerCalls,0);}
 for(const origin of [null,'https://foreign.example.test']){const f=fixture();assert.equal((await f.handlers.POST(request({},origin))).status,403);assert.equal(f.calls.length,0);assert.equal(f.counts().providerCalls,0);}
});
test('클라이언트가 소유자·시트·금액·실행권한을 지정하지 못한다',async()=>{
 for(const body of [{source_url:'https://example.test'},{owner_id:ids.native},{amount:1},{token:ids.token},[]]){const f=fixture();assert.equal((await f.handlers.POST(request(body))).status,400);assert.equal(f.calls.length,0);}
 const huge=fixture();assert.equal((await huge.handlers.POST(request({memo:'x'.repeat(1025)}))).status,413);assert.equal(huge.calls.length,0);
});
test('전체 저장 결과와 변경없음 건수를 반환하고 실행 임대를 해제한다',async()=>{
 const f=fixture(),r=await f.handlers.POST(request()),body=await responseBody(r);
 assert.equal(r.status,200);assert.deepEqual(body.summary,{added:0,updated:0,unchanged:2,basisUpdated:0,syncedAt:'2020-10-21T00:05:00Z'});assert.equal(body.register.entries.length,1);assert.equal(body.register.sheet_sync!.rows.length,2);assert.equal(body.register.baseline!.as_of,'2020-10-20');assert.equal(f.counts().writes,1);assert.match(r.headers.get('cache-control')??'',/no-store/);
 const apply=f.calls.find(c=>c.name==='fd_apply_intercompany_sheet_sync')!;assert.equal(apply.args!.p_token,ids.token);assert.equal(apply.args!.p_expected_native_hash,'synthetic-native');assert.equal(apply.args!.p_expected_baseline_hash,'synthetic-baseline');assert.equal((apply.args!.p_amendments as unknown[]).length,1);assert.equal(f.calls.at(-1)?.name,'fd_end_intercompany_sheet_sync');
});
test('다른 작업의 활성 임대가 있으면 외부 시트를 읽지도 쓰지도 않는다',async()=>{
 const f=fixture({beginError:'INTERCOMPANY_SHEET_SYNC_BUSY'});assert.equal((await f.handlers.POST(request())).status,409);assert.equal(f.counts().providerCalls,0);assert.equal(f.counts().writes,0);
});
test('반영 직전 원본 변경과 DB CAS 충돌은 과거 상태를 덮지 않고 보류한다',async()=>{
 const stale=fixture({sourceChanged:true}),r=await stale.handlers.POST(request());assert.equal(r.status,409);assert.match((await responseBody(r)).error,/반영 직전/);assert.equal(stale.counts().writes,0);assert.equal(stale.calls.at(-1)?.name,'fd_end_intercompany_sheet_sync');
 const database=fixture({applyError:'INTERCOMPANY_SOURCE_STALE'});assert.equal((await database.handlers.POST(request())).status,409);assert.equal(database.counts().writes,0);assert.equal(database.calls.at(-1)?.name,'fd_end_intercompany_sheet_sync');
});
test('잘못된 행·중복 ID는 금융 저장 전에 행 번호와 안전한 오류만 반환한다',async()=>{
 const f=fixture();f.raw.sourceValues[47][3]=-1;f.raw.sourceFormulas[47][3]=-1;const r=await f.handlers.POST(request()),body=await responseBody(r);assert.equal(r.status,409);assert.equal(body.row,48);assert.equal(f.counts().writes,0);
});
test('Google 권한 실패와 잘못된 저장 응답에서 비밀·금융 원문을 노출하지 않는다',async()=>{
 const provider=fixture({providerError:true}),r=await provider.handlers.POST(request());assert.equal(r.status,409);assert.match((await responseBody(r)).error,/권한/);assert.equal(provider.calls.at(-1)?.name,'fd_end_intercompany_sheet_sync');
 const malformed=fixture({malformed:true}),m=await malformed.handlers.POST(request());assert.equal(m.status,502);assert.ok(!(await m.text()).includes('sensitive'));assert.equal(malformed.calls.at(-1)?.name,'fd_end_intercompany_sheet_sync');
});
test('기존 미러 반영 대기는 금융 반영 성공과 구분해 안내한다',async()=>{
 const f=fixture({pending:true}),r=await f.handlers.POST(request()),body=await responseBody(r);assert.equal(r.status,200);assert.equal(f.counts().writes,1);assert.match(body.sheetWarning,/대기 중/);assert.equal(body.register.entries[0].sheet_status,'pending');assert.ok(f.calls.some(c=>c.name==='fd_claim_intercompany_sheet_for_sync'));
});
