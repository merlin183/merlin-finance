import test from 'node:test';
import assert from 'node:assert/strict';
import type {SupabaseClient} from '@supabase/supabase-js';
import {buildIntercompanyRegister,intercompanyBaselineSchema,intercompanyChangeSchema,intercompanyRegisterSchema,type IntercompanyBaseline,type IntercompanyEntry,type IntercompanyRegisterData} from '../lib/finance/intercompany-register';
import {intercompanyRegisterHandlers} from '../lib/finance/intercompany-register-route';
import {addDays,today} from '../lib/finance/format';

const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002',id='20000000-0000-4000-8000-000000000001',token='30000000-0000-4000-8000-000000000001';
const baseline=():IntercompanyBaseline=>({source_url:'https://docs.google.com/spreadsheets/d/synthetic-document/edit?gid=1',gid:'1',mirror_gid:'2',mirror_sheet_name:'Synthetic register',as_of:'2020-10-16',coverage_start:null,opening_balance_known:false,totals_include_additions:true,notes:['기초잔액 미확인'],
 businesses:[{key:'a',name:'합성 A',business_id:a},{key:'b',name:'합성 B',business_id:b},{key:'external',name:'합성 외부사업자',business_id:null}],
 pairs:[{business_a:'a',business_b:'b',a_to_b:1000,b_to_a:400,note:'양방향 이체 집계'},{business_a:'a',business_b:'external',a_to_b:0,b_to_a:0,note:'순증감 없음'}],
 additions:[{id:'source-1',date:'2020-10-15',from_business:'a',to_business:'b',amount:100,kind:'source_unspecified',memo:'쌍 합계에 이미 포함'}]});
const entry=(extra:Partial<IntercompanyEntry>={}):IntercompanyEntry=>({id,from_party:'a',to_party:'b',entry_date:'2020-10-20',amount:200,kind:'loan',memo:'합성 기록',version:1,voided:false,sheet_row:2,created_at:'2020-10-20T01:00:00Z',updated_at:'2020-10-20T01:00:00Z',sheet_status:'pending',sheet_synced_at:null,sheet_error:'',...extra});
const register=(entries:IntercompanyEntry[]=[]):IntercompanyRegisterData=>({baseline:baseline(),entries});
const create={action:'create' as const,id,from_party:'a',to_party:'b',entry_date:'2020-10-20',amount:200,kind:'loan' as const,memo:'합성 기록'};
const request=(body:unknown=create,origin:string|null='https://finance.example.test')=>new Request('https://finance.example.test/api/intercompany-register',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});

test('원본 쌍 합계에 포함된 추가 기록은 다시 더하지 않고 0원 쌍과 기초잔액 미확인을 유지한다',()=>{
 const value=register(),before=JSON.stringify(value),model=buildIntercompanyRegister(value,[]);
 const pair=model.pairs.find(p=>p.businessB.key==='b')!;
 assert.equal(pair.aToB,1000);assert.equal(pair.bToA,400);assert.equal(pair.net,600);assert.equal(pair.creditor?.key,'a');assert.equal(pair.debtor?.key,'b');
 assert.equal(model.pairs.length,2);assert.equal(model.pairs[1].amount,0);assert.equal(model.pairs[1].creditor,null);
 assert.equal(model.openingBalanceKnown,false);assert.equal(model.sourceAsOf,'2020-10-16');assert.equal(JSON.stringify(value),before);
});

test('대여와 상환은 실제 보낸 방향으로 한 번 반영하고 취소·복원·외부 사업자도 계산한다',()=>{
 const rows=[entry(),entry({id:'20000000-0000-4000-8000-000000000002',from_party:'b',to_party:'a',amount:500,kind:'repayment',sheet_row:3}),entry({id:'20000000-0000-4000-8000-000000000003',from_party:'a',to_party:'external',amount:700,voided:true,sheet_row:4})];
 const value=register(rows),model=buildIntercompanyRegister(value,[]),pair=model.pairs.find(p=>p.businessB.key==='b')!;
 assert.equal(pair.aToB,1200);assert.equal(pair.bToA,900);assert.equal(pair.amount,300);assert.equal(pair.manualEntries.length,2);assert.equal(model.entries.length,3);
 const restored=buildIntercompanyRegister(register(rows.map(r=>({...r,voided:false}))),[]);
 assert.equal(restored.pairs.find(p=>p.businessB.key==='external')?.amount,700);assert.equal(restored.totalPairNet,1000);
 const reversed=buildIntercompanyRegister(register([entry({from_party:'b',to_party:'a',kind:'repayment',amount:900})]),[]);
 assert.equal(reversed.pairs[0].creditor?.key,'b');assert.equal(reversed.pairs[0].amount,300);
});

test('세 사업자 순액을 서로 상계하지 않고 사업자명 변경은 명시된 ID 연결로만 표시한다',()=>{
 const source=baseline();source.pairs=[{business_a:'a',business_b:'b',a_to_b:1000,b_to_a:0,note:''},{business_a:'b',business_b:'external',a_to_b:1000,b_to_a:0,note:''},{business_a:'external',business_b:'a',a_to_b:1000,b_to_a:0,note:''}];
 const model=buildIntercompanyRegister({baseline:source,entries:[]},[{id:a,name:'수정한 합성 사업자명',representative:'',kind:'',reserve:0,color:'#123456'}]);
 assert.equal(model.totalPairNet,3000);assert.ok(model.businesses.every(v=>v.net===0&&v.receivable===1000&&v.payable===1000));assert.equal(model.businesses[0].party.name,'수정한 합성 사업자명');
});

test('외부 상대방의 보낼 차액은 관리사업자가 받을 금액에 한 번만 포함되고 다른 채무와 상계하지 않는다',()=>{
 const source=baseline();source.additions=[];
 source.pairs=[{business_a:'external',business_b:'a',a_to_b:0,b_to_a:4000,note:'합성 외부 대여'},{business_a:'b',business_b:'a',a_to_b:700,b_to_a:0,note:'별도 채무'}];
 const value={baseline:source,entries:[entry({from_party:'external',to_party:'a',kind:'repayment',amount:500})]},before=JSON.stringify(value);
 const model=buildIntercompanyRegister(value,[]),managed=model.businesses.find(item=>item.party.key==='a')!,external=model.businesses.find(item=>item.party.key==='external')!;
 const pair=model.pairs.find(item=>item.debtor?.key==='external')!;
 assert.equal(pair.creditor?.key,'a');assert.equal(pair.creditor?.business_id,a);assert.equal(pair.debtor?.business_id,null);assert.equal(pair.amount,3500);
 assert.equal(managed.receivable,3500);assert.equal(managed.payable,700);assert.equal(external.payable,3500);assert.equal(external.receivable,0);
 assert.equal(model.totalPairNet,4200);assert.equal(JSON.stringify(value),before);
});

test('입력은 실제 날짜·양의 안전 정수·서로 다른 사업자만 받고 서버 전용 필드는 거부한다',()=>{
 assert.equal(intercompanyChangeSchema.safeParse(create).success,true);
 for(const patch of [{amount:0},{amount:-1},{amount:1.5},{amount:Number.MAX_SAFE_INTEGER+1},{entry_date:'2020-02-30'},{entry_date:addDays(today(),1)},{to_party:'a'},{sheet_row:3},{owner_id:a},{sheet_status:'synced'},{version:1}])assert.equal(intercompanyChangeSchema.safeParse({...create,...patch}).success,false,JSON.stringify(patch));
 assert.equal(intercompanyChangeSchema.safeParse({action:'set_voided',id,version:1,voided:true}).success,true);
 assert.equal(intercompanyChangeSchema.safeParse({action:'set_voided',id,version:0,voided:true}).success,false);
 const malformed=baseline();malformed.pairs.push({...malformed.pairs[0],business_a:'b',business_b:'a'});assert.equal(intercompanyBaselineSchema.safeParse(malformed).success,false);
 const unknown=baseline();unknown.additions[0].from_business='not-registered';assert.equal(intercompanyBaselineSchema.safeParse(unknown).success,false);
 assert.equal(intercompanyRegisterSchema.safeParse({...register([entry()]),secret:'hidden'}).success,false);
 assert.throws(()=>buildIntercompanyRegister(register([entry({amount:Number.MAX_SAFE_INTEGER})]),[]),/초과/);
});

function fixture(options:{authError?:string;saveError?:string;gatewayError?:boolean;busy?:boolean;malformed?:boolean}={}){
 const calls:{name:string;args:unknown}[]=[];let auth=0,synced=0;
 const pending=register([entry()]);
 const db={rpc:async(name:string,args:unknown)=>{
  calls.push({name,args});
  if(name==='fd_save_intercompany_register')return {data:options.malformed?{token:'sensitive'}:pending,error:options.saveError?{message:options.saveError}:null};
  if(name==='fd_read_intercompany_register')return {data:pending,error:null};
  if(name==='fd_claim_intercompany_sheet')return {data:options.busy?null:{entry:entry({sheet_status:'syncing'}),token,lease_version:1},error:null};
  if(name==='fd_finish_intercompany_sheet')return {data:register([entry({sheet_status:options.gatewayError?'error':'synced',sheet_synced_at:options.gatewayError?null:'2020-10-20T01:01:00Z'})]),error:null};
  throw Error('Unexpected RPC');
 }} as unknown as Pick<SupabaseClient,'rpc'>;
 const handlers=intercompanyRegisterHandlers({authenticate:async()=>{auth++;if(options.authError)throw Error(options.authError);return {db};},syncEntry:async(base,row)=>{synced++;assert.equal(base.gid,'1');assert.equal(row.sheet_row,2);if(options.gatewayError)throw Error('sensitive provider body');}});
 return {handlers,calls,counts:()=>({auth,synced})};
}

test('로그인 전 조회·저장·시트 접근이 차단되고 같은 출처와 검증된 명시적 필드만 저장한다',async()=>{
 for(const authError of ['UNAUTHORIZED','ADMIN_REQUIRED']){const f=fixture({authError});assert.equal((await f.handlers.GET()).status,authError==='UNAUTHORIZED'?401:403);assert.equal((await f.handlers.POST(request())).status,authError==='UNAUTHORIZED'?401:403);assert.equal(f.calls.length,0);assert.equal(f.counts().synced,0);}
 for(const origin of [null,'https://other.example.test']){const f=fixture();assert.equal((await f.handlers.POST(request(create,origin))).status,403);assert.equal(f.calls.length,0);}
 const invalid=fixture();assert.equal((await invalid.handlers.POST(request({...create,amount:-1}))).status,400);assert.equal(invalid.calls.length,0);
 const huge=fixture();assert.equal((await huge.handlers.POST(request({memo:'x'.repeat(16385)}))).status,413);assert.equal(huge.calls.length,0);
 const good=fixture(),response=await good.handlers.POST(request());assert.equal(response.status,200);const result=await response.json() as IntercompanyRegisterData&{sheetWarning?:string};assert.equal(result.entries[0].sheet_status,'synced');assert.equal(result.sheetWarning,undefined);assert.equal(good.counts().synced,1);assert.deepEqual(good.calls[0],{name:'fd_save_intercompany_register',args:{p_change:create}});assert.equal(good.calls.length,3);assert.match(response.headers.get('cache-control')||'',/no-store/);
});

test('시트 실패·진행 중에도 DB 저장 상태를 반환하고 실패한 원문이나 비밀값을 노출하지 않는다',async()=>{
 const failed=fixture({gatewayError:true}),response=await failed.handlers.POST(request()),body=await response.json() as IntercompanyRegisterData&{sheetWarning:string};
 assert.equal(response.status,200);assert.equal(body.entries[0].sheet_status,'error');assert.match(body.sheetWarning,/기록은 저장/);assert.ok(!JSON.stringify(body).includes('sensitive'));
 assert.deepEqual((failed.calls[2].args as Record<string,unknown>).p_success,false);
 const busy=fixture({busy:true}),busyResponse=await busy.handlers.POST(request({action:'sync',id})),busyBody=await busyResponse.json() as IntercompanyRegisterData&{sheetWarning:string};assert.equal(busyResponse.status,200);assert.ok(busyBody.sheetWarning);assert.equal(busy.counts().synced,0);assert.ok(!busy.calls.some(c=>c.name==='fd_save_intercompany_register'));
});

test('충돌·원본 기간·최대 행·잘못된 응답은 성공으로 보고하지 않고 시트 쓰기도 실행하지 않는다',async()=>{
 for(const [saveError,status] of [['INTERCOMPANY_STALE',409],['INTERCOMPANY_ID_CONFLICT',409],['INTERCOMPANY_BASELINE_PERIOD',400],['INTERCOMPANY_FUTURE_DATE',400],['INTERCOMPANY_SHEET_FULL',409],['sensitive database body',500]] as const){const f=fixture({saveError}),response=await f.handlers.POST(request());assert.equal(response.status,status);assert.equal(f.counts().synced,0);assert.ok(!(await response.text()).includes('sensitive'));}
 const malformed=fixture({malformed:true});assert.equal((await malformed.handlers.POST(request())).status,502);assert.equal(malformed.counts().synced,0);
});
