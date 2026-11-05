import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIntercompanyRegister,intercompanySheetSnapshotInputSchema,intercompanyRegisterSchema,type IntercompanyBaseline,type IntercompanyEntry,type IntercompanyRegisterData,type IntercompanySheetSnapshot} from '../lib/finance/intercompany-register';
const id='20000000-0000-4000-8000-000000000001';
const baseline:IntercompanyBaseline={source_url:'https://docs.google.com/spreadsheets/d/synthetic-source-document/edit',gid:'1',mirror_gid:'2',mirror_sheet_name:'사업자간 대여금_대시보드기록',as_of:'2020-10-20',coverage_start:'2020-01-01',opening_balance_known:false,totals_include_additions:true,notes:[],businesses:[{key:'a',name:'합성 A',business_id:null},{key:'b',name:'합성 B',business_id:null}],pairs:[{business_a:'a',business_b:'b',a_to_b:500,b_to_a:100,note:'Original source'}],additions:[{id:'source-row-48',date:'2020-10-01',from_business:'a',to_business:'b',amount:50,kind:'loan',memo:'Old source'}]};
const entry=(patch:Partial<IntercompanyEntry>={}):IntercompanyEntry=>({id,from_party:'a',to_party:'b',entry_date:'2020-10-21',amount:100,kind:'loan',memo:'Synthetic native',version:1,voided:false,sheet_row:2,created_at:'2020-10-21T00:00:00Z',updated_at:'2020-10-21T00:00:00Z',sheet_status:'synced',sheet_synced_at:'2020-10-21T00:00:01Z',sheet_error:'',...patch});
const snapshot=():IntercompanySheetSnapshot=>({revision:1,synced_at:'2020-10-22T00:00:00Z',fingerprint:'synthetic-v1',through_date:'2020-10-22',mirrored_max_row:8,historical_base_pairs:[{business_a:'a',business_b:'b',a_to_b:450,b_to_a:100}],rows:[
 {id:'source-row-48',source_row:48,date:'2020-10-01',from_business:'a',to_business:'b',amount:50,kind:'loan',memo:'Old source',native_id:null,origin:'source',voided:false},
 {id:'source-linked',source_row:56,date:'2020-10-21',from_business:'a',to_business:'b',amount:100,kind:'loan',memo:'Linked source',native_id:id,origin:'source',voided:false},
 {id:'source-distinct',source_row:57,date:'2020-10-22',from_business:'a',to_business:'b',amount:100,kind:'loan',memo:'A separate same amount movement',native_id:null,origin:'source',voided:false},
 {id:'mirror-only',source_row:8,date:'2020-10-22',from_business:'b',to_business:'a',amount:30,kind:'repayment',memo:'Standalone mirror entry',native_id:null,origin:'mirror',voided:false},
]});

test('스냅샷은 역사 기준+독립 원본행+실제 native를 사용하고 연결된 source 행을 다시 더하지 않는다',()=>{
 const data:IntercompanyRegisterData={baseline,entries:[entry()],sheet_sync:snapshot()},before=JSON.stringify(data);
 const model=buildIntercompanyRegister(data,[]),pair=model.pairs[0];
 assert.equal(pair.aToB,700);assert.equal(pair.bToA,130);assert.equal(pair.net,570);assert.equal(pair.manualEntries.length,1);
 assert.equal(model.sourceAdditions.length,3);assert.equal(model.sourceAdditions.find(r=>r.id==='source-distinct')?.amount,100);
 assert.equal(model.sourceAdditions.find(r=>r.origin==='mirror')?.source_row,8);assert.equal(model.sourceAsOf,'2020-10-22');assert.equal(baseline.as_of,'2020-10-20');assert.equal(JSON.stringify(data),before);
});
test('기존 8건 같은 원본행 수정·기준누계 변경·신규 원본은 재동기화 값으로 계산하고 이전 baseline을 중복 가산하지 않는다',()=>{
 const next=snapshot();next.historical_base_pairs[0].a_to_b=600;next.rows[0].amount=80;
 const model=buildIntercompanyRegister({baseline,entries:[entry()],sheet_sync:next},[]);
 assert.equal(model.pairs[0].aToB,880);assert.equal(model.sourceAdditions[0].amount,80);assert.equal(baseline.additions[0].amount,50);
});
test('동일 날짜·방향·금액의 다른 ID는 모두 유지하고 linkednative의 수정·취소·복원이 일관적으로 반영된다',()=>{
 const state=snapshot();state.rows[1].amount=120;
 const amended=entry({amount:120,version:2,source_row_key:id});
 assert.equal(buildIntercompanyRegister({baseline,entries:[amended],sheet_sync:state},[]).pairs[0].aToB,720);
 assert.equal(buildIntercompanyRegister({baseline,entries:[{...amended,voided:true,version:3}],sheet_sync:state},[]).pairs[0].aToB,600);
 assert.equal(buildIntercompanyRegister({baseline,entries:[{...amended,version:4}],sheet_sync:state},[]).pairs[0].aToB,720);
 const another=entry({id:'20000000-0000-4000-8000-000000000002',sheet_row:9});
 assert.equal(buildIntercompanyRegister({baseline,entries:[amended,another],sheet_sync:state},[]).pairs[0].aToB,820);
});
test('미러 원본의 취소 표시는 합계에서 제외하고 snapshot 없는 이전 응답도 그대로 지원한다',()=>{
 const state=snapshot();state.rows[3].voided=true;
 assert.equal(buildIntercompanyRegister({baseline,entries:[entry()],sheet_sync:state},[]).pairs[0].bToA,100);
 assert.equal(buildIntercompanyRegister({baseline,entries:[entry()]},[]).pairs[0].aToB,600);
 assert.ok(intercompanyRegisterSchema.safeParse({baseline,entries:[entry()]}).success);
});
test('스냅샷 입력은 ID·연결의 중복과 음수 기준·불완전 날짜·자동 표시 범위 수입을 거부한다',()=>{
 const state=snapshot();const {revision:_revision,synced_at:_syncedAt,...input}=state;void _revision;void _syncedAt;
 assert.ok(intercompanySheetSnapshotInputSchema.safeParse(input).success);
 const patches=[{historical_base_pairs:[{...input.historical_base_pairs[0],a_to_b:-1}]},{rows:[...input.rows,input.rows[0]]},{rows:[{...input.rows[0],date:'2020-02-30'}]},{rows:[{...input.rows[0],source_row:73}]},{rows:[input.rows[1],{...input.rows[1],id:'another'}]},{rows:[input.rows[0],{...input.rows[0],id:'different-id'}]},{mirrored_max_row:7},{mirrored_max_row:10001},{through_date:'2999-01-01'}];
 for(const patch of patches){assert.equal(intercompanySheetSnapshotInputSchema.safeParse({...input,...patch}).success,false);assert.equal(intercompanyRegisterSchema.safeParse({baseline,entries:[],sheet_sync:{...state,...patch}}).success,false);}
});
