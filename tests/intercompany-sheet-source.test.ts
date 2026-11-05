import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIntercompanySheetSource,intercompanySourceDedupFormula,type IntercompanySheetRaw} from '../lib/finance/intercompany-sheet-source';
import type {IntercompanyBaseline} from '../lib/finance/intercompany-register';

const mirror='가상 기록 탭';
const one='10000000-0000-4000-8000-000000000001',two='10000000-0000-4000-8000-000000000002';
const baseline:IntercompanyBaseline={source_url:'https://docs.google.com/spreadsheets/d/synthetic_workbook_identifier_12345/edit',gid:'123',mirror_gid:'456',mirror_sheet_name:mirror,as_of:'2026-10-20',coverage_start:'2023-01-01',opening_balance_known:false,totals_include_additions:true,notes:[],businesses:[{key:'a',name:'가상 A',business_id:null},{key:'b',name:'가상 B',business_id:null}],pairs:[{business_a:'a',business_b:'b',a_to_b:105,b_to_a:20,note:''}],additions:[]};
function formula(row=9,reverse=false,base=100){const a=reverse?`B${row}`:`A${row}`,b=reverse?`A${row}`:`B${row}`,s=`'${mirror}'!`;return `=(${base}+SUMIFS($D$48:$D$70,$B$48:$B$70,${a},$C$48:$C$70,${b}))+SUMIFS(${s}$E$2:$E$10000,${s}$C$2:$C$10000,${a},${s}$D$2:$D$10000,${b},${s}$G$2:$G$10000,"정상")`;}
function dedup(row:number,label='대여금 상환'){
 const s=`'${mirror}'!`,count=(state:string)=>`COUNTIFS(${s}$A$2:$A$10000,$E$${row},${s}$B$2:$B$10000,TEXT($A$${row},"yyyy-mm-dd"),${s}$C$2:$C$10000,$B$${row},${s}$D$2:$D$10000,$C$${row},${s}$E$2:$E$10000,$D$${row},${s}$F$2:$F$10000,"${label}",${s}$G$2:$G$10000,"${state}")`;
 return `IF(AND($E$${row}<>"",(${count('정상')}+${count('취소')})=1),$D$${row},0)`;
}
function fixture():IntercompanySheetRaw{
 const values=Array.from({length:170},()=>[] as (string|number)[]);
 values[1]=['원장 기록 2023-01-01~2026-10-01 · 확인 2026-10-20 · 단위: 원'];
 values[8]=['가상 A','가상 B',105,20,85,'','합성 근거'];
 values[46]=['기재일','보낸 사업자','받은 사업자','반영 금액','반영 위치','근거','비고'];
 values[47]=['10/12','가상 A','가상 B',5,'9행 A → B','합성 근거','대여금'];
 const formulas=structuredClone(values);formulas[8][2]=formula();formulas[8][3]=formula(9,true,20);
 return {sourceTitle:'가상 원본 요약',sourceGid:'123',mirrorTitle:mirror,mirrorGid:'456',sourceValues:values,sourceFormulas:formulas,mirrorValues:[['기록ID','일자','보낸 사업자','받은 사업자','금액','구분','상태','버전','메모']],capturedAt:'2026-10-22T00:00:00Z',fingerprint:'synthetic-fingerprint'};
}
test('기존 포함 행은 지속 ID 계획을 만들고 known 수식의 기초금액만 추출한다',()=>{
 const raw=fixture(),before=structuredClone(raw),result=parseIntercompanySheetSource(raw,baseline);
 assert.deepEqual(result.issues,[]);assert.equal(result.sourceRows[0].id,'source-row-48');assert.equal(result.sourceRows[0].date,'2026-10-12');
 assert.equal(result.identifierWrites[0].row,48);assert.equal(result.historicalBasePairs[0].a_to_b,100);assert.equal(result.historicalBasePairs[0].b_to_a,20);assert.deepEqual(raw,before);
});
test('원본 일자·금액·종류가 바뀌어도 H 식별자를 보존한다',()=>{
 const raw=fixture();raw.sourceValues[47][0]='2026-10-19';raw.sourceValues[47][3]=7;raw.sourceValues[47][6]='대여금상환';raw.sourceValues[47][7]='source-row-48';
 const result=parseIntercompanySheetSource(raw,baseline);assert.deepEqual(result.issues,[]);assert.equal(result.sourceRows[0].id,'source-row-48');assert.equal(result.sourceRows[0].amount,7);assert.equal(result.sourceRows[0].kind,'repayment');assert.equal(result.identifierWrites.length,0);
});
test('같은 날·방향·금액의 별도 행과 mirror를 값으로 중복 제거하지 않는다',()=>{
 const raw=fixture();raw.sourceValues[55]=['2026-10-22','가상 A','가상 B',4,'','','대여금'];raw.sourceValues[56]=['2026-10-22','가상 A','가상 B',4,'','','대여금'];
 raw.mirrorValues.push([one,'2026-10-22','가상 A','가상 B',4,'대여금','정상',1,'']);let index=0;
 const result=parseIntercompanySheetSource(raw,baseline,{newId:()=>[one,two][index++]});assert.deepEqual(result.issues,[]);assert.equal(result.sourceRows.length,3);assert.equal(result.mirrorRows.length,1);assert.notEqual(result.sourceRows[1].id,result.sourceRows[2].id);
});
test('E UUID만 명시적 native 연결로 읽고 위치 설명을 UUID로 간주하지 않는다',()=>{
 const raw=fixture();raw.sourceValues[55]=['2026-10-22','가상 A','가상 B',10,one,'근거','대여금 상환'];
 const result=parseIntercompanySheetSource(raw,baseline);assert.equal(result.sourceRows[0].nativeId,null);assert.equal(result.sourceRows[1].nativeId,one);assert.equal(result.sourceRows[1].id,one);
});
test('기존 dedup IF의 종류와 수정된 원본 종류가 달라도 수식 기초금액은 유지한다',()=>{
 const raw=fixture();raw.sourceValues[55]=['2026-10-22','가상 A','가상 B',10,one,'근거','대여금'];
 raw.sourceFormulas[8][2]=`=(${formula().slice(1)})-${dedup(56)}`;
 const result=parseIntercompanySheetSource(raw,baseline);assert.deepEqual(result.issues,[]);assert.equal(result.historicalBasePairs[0].a_to_b,100);
});
test('E/H UUID 기반 짧은 중복제외 수식도 기초금액을 바꾸지 않는다',()=>{
 for(const column of ['E','H'] as const){const raw=fixture();raw.sourceValues[55]=['2026-10-22','가상 A','가상 B',10,one,'근거','대여금',one];raw.sourceFormulas[8][2]=`${formula()}-${intercompanySourceDedupFormula(56,mirror,column)}`;const result=parseIntercompanySheetSource(raw,baseline);assert.deepEqual(result.issues,[]);assert.equal(result.historicalBasePairs[0].a_to_b,100);}
});
test('73행 이후 자동 표시 내용은 원본 이동이나 합계로 다시 읽지 않는다',()=>{
 const raw=fixture();raw.sourceValues[74]=['2026-10-22','가상 A','가상 B',99999,'','','대여금'];raw.sourceValues[75]=['가상 A','가상 B',999,1,998];
 const result=parseIntercompanySheetSource(raw,baseline);assert.equal(result.sourceRows.length,1);assert.equal(result.historicalBasePairs.length,1);assert.deepEqual(result.issues,[]);
});
test('직접 숫자로 덮어쓴 합계와 모르는 수식은 추측하지 않고 보류한다',()=>{
 for(const invalid of [123,'=100+SUM(A1:A5)']){const raw=fixture();raw.sourceFormulas[8][2]=invalid;const result=parseIntercompanySheetSource(raw,baseline);assert.ok(result.issues.some(issue=>issue.code==='pair_formula'));}
});
test('승인된 과거 근거 SUM(D36:D38)은 값을 합산하고 원본 참조를 보존한다',()=>{
 const raw=fixture();for(const [index,value] of [[35,10],[36,20],[37,30]])raw.sourceValues[index]=['','','',value];raw.sourceFormulas[8][2]=formula().replace('(100+','(SUM(D36:D38)+');
 const result=parseIntercompanySheetSource(raw,baseline);assert.deepEqual(result.issues,[]);assert.equal(result.historicalBasePairs[0].a_to_b,60);assert.equal(result.historicalBasePairs[0].base_a_expression,'SUM(D36:D38)');
 raw.sourceValues[35][3]=11;assert.equal(parseIntercompanySheetSource(raw,baseline).historicalBasePairs[0].a_to_b,61);
});
test('기존 mirror-only 0기초 수식은 누적 금액을 기초금액으로 오인하지 않는다',()=>{
 const raw=fixture();raw.sourceFormulas[8][2]='='+formula().split('))+')[1];const result=parseIntercompanySheetSource(raw,baseline);assert.deepEqual(result.issues,[]);assert.equal(result.historicalBasePairs[0].a_to_b,0);
});
test('지속 ID 복사·가짜 legacy ID·동일 native 링크 중복은 오류다',()=>{
 for(const id of ['source-row-48','source-row-99']){const raw=fixture();raw.sourceValues[55]=['2026-10-22','가상 A','가상 B',4,'','','대여금',id];assert.ok(parseIntercompanySheetSource(raw,baseline).issues.some(issue=>issue.code==='source_identity'));}
 const raw=fixture();raw.sourceValues[55]=['2026-10-22','가상 A','가상 B',4,one,'','대여금',one];raw.sourceValues[56]=['2026-10-22','가상 A','가상 B',5,one,'','대여금',two];assert.ok(parseIntercompanySheetSource(raw,baseline).issues.some(issue=>issue.code==='source_identity'));
});
test('잘못된 날짜·소수금액·알 수 없는 사업자·불명확한 구분은 오류다',()=>{
 for(const [column,value] of [[0,'2026-02-30'],[3,1.5],[1,'모르는 사업자'],[6,'확인 필요']] as const){const raw=fixture();raw.sourceValues[47][column]=value;assert.ok(parseIntercompanySheetSource(raw,baseline).issues.some(issue=>issue.code==='source_row_invalid'));}
});
test('Google serial 날짜와 수정된 원본 기간을 읽고 기준일 자체는 바꾸지 않는다',()=>{
 const raw=fixture();raw.sourceValues[1]=['원장 기록 2024-01-01~2026-10-15 · 확인 2026-10-22'];raw.sourceValues[47][0]=46317;
 const result=parseIntercompanySheetSource(raw,baseline);assert.equal(result.sourceRows[0].date,'2026-10-22');assert.equal(result.period.sourceStart,'2024-01-01');assert.equal(result.period.ledgerThrough,'2026-10-15');assert.equal(baseline.as_of,'2026-10-20');
});
test('mirror의 새 UUID와 취소 상태를 보존하고 중복 UUID를 거부한다',()=>{
 const raw=fixture();raw.mirrorValues.push([one,'2026-10-22','가상 B','가상 A',10,'대여금 상환','취소',2,'합성 메모']);
 const result=parseIntercompanySheetSource(raw,baseline);assert.deepEqual(result.issues,[]);assert.equal(result.mirrorRows[0].voided,true);assert.equal(result.mirrorRows[0].version,2);assert.equal(result.mirrorRows[0].cells.length,9);
 raw.mirrorValues.push([...raw.mirrorValues[1]]);assert.ok(parseIntercompanySheetSource(raw,baseline).issues.some(issue=>issue.code==='mirror_row_invalid'));
});
