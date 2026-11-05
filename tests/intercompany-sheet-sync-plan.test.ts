import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIntercompanySheetSource} from '../lib/finance/intercompany-sheet-source';
import {planIntercompanySheetSync,assertIntercompanySourceIdentities} from '../lib/finance/intercompany-sheet-sync-plan';
import {buildIntercompanyRegister,type IntercompanyRegisterData} from '../lib/finance/intercompany-register';
import {ids,syntheticRegister,syntheticRaw,refreshSyntheticRaw,syntheticEntry} from './helpers/intercompany-source-fixture';

const plan=(register:IntercompanyRegisterData,raw=syntheticRaw(register))=>planIntercompanySheetSync(register,parseIntercompanySheetSource(raw,register.baseline!),raw);
const synced=(register:IntercompanyRegisterData,raw=syntheticRaw(register))=>({...register,sheet_sync:{...plan(register,raw).snapshot,revision:1,synced_at:'2020-10-21T00:03:00Z'}});

test('첫 동기화와 재동기화는 기존 누계를 다시 더하지 않고 등록과 원본을 한 번씩 표시한다',()=>{
 const value=syntheticRegister(),before=JSON.stringify(value),p=plan(value),model=buildIntercompanyRegister({...value,sheet_sync:{...p.snapshot,revision:1,synced_at:''}},[]);
 assert.deepEqual(p.summary,{added:0,updated:0,unchanged:2,basisUpdated:0});assert.equal(p.amendments.length,1);assert.equal(p.amendments[0].source_row_key,ids.native);assert.equal(model.pairs[0].aToB,1300);assert.equal(model.pairs[0].bToA,400);assert.equal(model.sourceAdditions.length,1);assert.equal(JSON.stringify(value),before);
 assert.deepEqual(plan(synced(value)).summary,p.summary);
});
test('같은 날짜와 금액이라도 별도 ID의 원본은 추가하고 반복해도 늘지 않는다',()=>{
 const value=syntheticRegister(),raw=syntheticRaw(value);raw.sourceValues[55]=['2020-10-21','합성회사A','합성회사B',100,'','','대여금',ids.source];refreshSyntheticRaw(raw);
 const p=plan(value,raw);assert.equal(p.summary.added,1);const next={...value,sheet_sync:{...p.snapshot,revision:1,synced_at:''}};assert.equal(buildIntercompanyRegister(next,[]).pairs[0].aToB,1400);assert.equal(plan(next,raw).summary.added,0);
});
test('원본의 기존 역사 행 수정은 신규 생성 대신 같은 ID를 갱신한다',()=>{
 const value=synced(syntheticRegister()),raw=syntheticRaw(value);raw.sourceValues[47][3]=350;refreshSyntheticRaw(raw);
 const p=plan(value,raw);assert.equal(p.summary.added,0);assert.equal(p.summary.updated,1);assert.equal(buildIntercompanyRegister({...value,sheet_sync:{...p.snapshot,revision:2,synced_at:''}},[]).pairs[0].aToB,1450);
});
test('명시된 UUID의 원본 수정은 기존 native를 CAS 수정하고 중복 추가하지 않는다',()=>{
 const value=syntheticRegister(),raw=syntheticRaw(value);raw.sourceValues[55]=['2020-10-21','합성회사A','합성회사B',100,ids.native,'원본 메모','대여금',ids.native];refreshSyntheticRaw(raw);
 const previous=synced(value,raw);raw.sourceValues[55][3]=150;refreshSyntheticRaw(raw);const p=plan(previous,raw);
 assert.equal(p.amendments.length,1);assert.equal(p.amendments[0].id,ids.native);assert.equal(p.amendments[0].amount,150);assert.equal(p.amendments[0].version,1);assert.deepEqual(p.amendments[0].previous_row,raw.mirrorValues[1]);assert.equal(p.summary.added,0);assert.equal(p.snapshot.rows.filter(r=>r.native_id===ids.native).length,1);
});
test('연결된 원본 일자·방향·구분 수정도 같은 ID로 유지하고 처음 메모는 보존한다',()=>{
 const value=syntheticRegister(),raw=syntheticRaw(value);raw.sourceValues[55]=['2020-10-19','합성회사B','합성회사A',175,ids.native,'연결 설명','대여금 상환',ids.native];refreshSyntheticRaw(raw);const p=plan(value,raw),a=p.amendments[0];
 assert.equal(a.id,ids.native);assert.equal(a.entry_date,'2020-10-19');assert.equal(a.from_party,'b');assert.equal(a.to_party,'a');assert.equal(a.kind,'repayment');assert.equal(a.memo,value.entries[0].memo);
});
test('기록 탭만 수정되면 연결된 원본도 같은 금융값으로 정규화한다',()=>{
 const value=syntheticRegister(),raw=syntheticRaw(value);raw.sourceValues[55]=['2020-10-21','합성회사A','합성회사B',100,ids.native,'','대여금',ids.native];refreshSyntheticRaw(raw);const previous=synced(value,raw);
 raw.mirrorValues[1][4]=190;refreshSyntheticRaw(raw);const p=plan(previous,raw);assert.equal(p.amendments[0].amount,190);assert.equal(p.sourceUpdates.length,1);assert.equal(p.sourceUpdates[0].amount,190);
});
test('양쪽이 서로 다르게 수정된 경우 전체 보류하고 이전 입력은 변경하지 않는다',()=>{
 const value=syntheticRegister(),raw=syntheticRaw(value);raw.sourceValues[55]=['2020-10-21','합성회사A','합성회사B',100,ids.native,'','대여금',ids.native];refreshSyntheticRaw(raw);const previous=synced(value,raw);
 raw.sourceValues[55][3]=150;raw.mirrorValues[1][4]=160;refreshSyntheticRaw(raw);const before=JSON.stringify(previous);assert.throws(()=>plan(previous,raw),/서로 다르게 수정/);assert.equal(JSON.stringify(previous),before);
});
test('금액이 같은 앱 전용 native와 새 원본은 명시 연결 없이는 합치지 않는다',()=>{
 const value=syntheticRegister([syntheticEntry(),syntheticEntry({id:ids.second,sheet_row:3})]),raw=syntheticRaw(value);raw.sourceValues[55]=['2020-10-21','합성회사A','합성회사B',100,ids.source,'','대여금',ids.source];
 refreshSyntheticRaw(raw);assert.throws(()=>plan(value,raw),/가리키는 등록 기록/);
 raw.sourceValues[55][4]='';refreshSyntheticRaw(raw);const p=plan(value,raw);assert.equal(p.snapshot.rows.length,4);assert.equal(buildIntercompanyRegister({...value,sheet_sync:{...p.snapshot,revision:1,synced_at:''}},[]).pairs[0].aToB,1500);
});
test('기록 탭의 새로운 UUID는 별도 source 기록으로 보존하고 취소 상태는 합계에서 뺀다',()=>{
 const value=syntheticRegister(),raw=syntheticRaw(value);raw.mirrorValues.push([ids.source,'2020-10-21','합성회사B','합성회사A',250,'대여금 상환','정상',1,'합성 외부 입력']);refreshSyntheticRaw(raw);const p=plan(value,raw);assert.equal(p.summary.added,1);assert.equal(p.snapshot.mirrored_max_row,3);
 let model=buildIntercompanyRegister({...value,sheet_sync:{...p.snapshot,revision:1,synced_at:''}},[]);assert.equal(model.pairs[0].bToA,650);
 raw.mirrorValues[2][6]='취소';refreshSyntheticRaw(raw);const cancelled=plan(value,raw);model=buildIntercompanyRegister({...value,sheet_sync:{...cancelled.snapshot,revision:1,synced_at:''}},[]);assert.equal(model.pairs[0].bToA,400);
});
test('연동ID가 지워지거나 기록이 사라지면 새 기록으로 추측하지 않는다',()=>{
 const value=synced(syntheticRegister()),raw=syntheticRaw(value);raw.sourceValues[47][7]='';refreshSyntheticRaw(raw);assert.throws(()=>assertIntercompanySourceIdentities(value,parseIntercompanySheetSource(raw,value.baseline!),raw),/연동ID가 지워/);
 raw.sourceValues[47]=[];refreshSyntheticRaw(raw);assert.throws(()=>plan(value,raw),/연동ID가 사라/);
});
test('원본 합계 수식의 기준 숫자 변경과 금융 오버플로를 구분한다',()=>{
 const value=syntheticRegister(),raw=syntheticRaw(value);raw.sourceFormulas[8][2]=String(raw.sourceFormulas[8][2]).replace('1000+','1100+');raw.sourceValues[8][2]=1400;raw.sourceValues[8][4]=1000;const p=plan(value,raw);assert.equal(p.summary.basisUpdated,1);assert.equal(p.snapshot.historical_base_pairs[0].a_to_b,1100);
 const overflow=syntheticRaw(value);overflow.sourceFormulas[8][2]=String(overflow.sourceFormulas[8][2]).replace('1000+',`${Number.MAX_SAFE_INTEGER}+`);assert.throws(()=>plan(value,overflow),/초과/);
});
test('이미 반영된 미러 행 삭제는 완료로 숨기지 않고 보류한다',()=>{
 const value=syntheticRegister(),raw=syntheticRaw(value);raw.mirrorValues[1]=[];refreshSyntheticRaw(raw);assert.throws(()=>plan(value,raw),/시트 행이 없어/);
});
test('이전 시트 저장 실패 후 양쪽 편집은 승인된 이전 행과 대조한다',()=>{
 const initial=syntheticRegister(),raw=syntheticRaw(initial);raw.sourceValues[55]=['2020-10-21','합성회사A','합성회사B',100,ids.native,'','대여금',ids.native];refreshSyntheticRaw(raw);
 const value=synced(initial,raw),previous=[...raw.mirrorValues[1]] as (string|number)[];
 value.entries[0]={...value.entries[0],amount:150,version:2,sheet_status:'error',sheet_previous_row:previous};
 value.sheet_sync.rows.find(r=>r.native_id===ids.native)!.amount=150;
 raw.sourceValues[55][3]=200;refreshSyntheticRaw(raw);
 const pending=plan(value,raw);assert.equal(pending.amendments[0].amount,200);assert.deepEqual(pending.amendments[0].previous_row,previous);
 raw.mirrorValues[1][4]=120;refreshSyntheticRaw(raw);assert.throws(()=>plan(value,raw),/반영 대기 중/);
});
