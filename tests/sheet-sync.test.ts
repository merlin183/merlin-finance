import test from 'node:test';
import assert from 'node:assert/strict';
import {utils,write} from '@e965/xlsx';
import {prepareAutomaticSheetSync,runSheetSync,syncErrorMessage,type SyncRpc} from '../lib/finance/sheet-sync';
import {emptyDataset,type Dataset,type Transaction} from '../lib/finance/types';

// Synthetic bank rows only; no operational source IDs or personal details.
const sourceUrl='https://docs.google.com/spreadsheets/d/synthetic_sheet_identifier_12345/edit';
const sheet='가상회사 운영통장';
const header=['연도','월','일','과목','기본내역','세부내역','입금','출금','세금계산서 유무','비고','잔액'];
const payment=[2026,9,1,'급여','테스트 급여','가상직원',0,1000,'','테스트 메모',9000];
const nextPayment=[2026,9,2,'임차료','테스트 월세','가상임대인',0,500,'','',8500];
const token='a'.repeat(64);
function bytes(rows:unknown[][],name=sheet){
 const book=utils.book_new();utils.book_append_sheet(book,utils.aoa_to_sheet([header,...rows]),name);
 return new Uint8Array(write(book,{type:'array',bookType:'xlsx'}) as ArrayBuffer);
}
function context(){
 const dataset:Dataset=structuredClone(emptyDataset);
 dataset.businesses=[{id:'business',name:'가상회사',representative:'',kind:'법인',reserve:0,color:'#123456'}];
 dataset.accounts=[{id:'account',business_id:'business',name:'운영통장',bank:'가상은행',masked_number:'0000',opening_balance:0,opening_balance_date:null}];
 dataset.categories=[
  {id:'salary',name:'급여',group_name:'지출',is_operating:true,is_internal:false},
  {id:'rent',name:'임차료',group_name:'지출',is_operating:true,is_internal:false},
  {id:'other',name:'기타비용',group_name:'지출',is_operating:true,is_internal:false},
 ];
 return {source_id:'source',source_url:sourceUrl,mappings:[{sheet,account_id:'account',selected:true}],dataset,source_fingerprints:[] as string[]};
}
function harness(rows:unknown[][]=[payment]){
 const state=context(),calls:{name:string;args:Record<string,unknown>}[]=[];
 let current=rows,lastSourceHash:string|null=null,lastResult:Record<string,unknown>|null=null;
 const rpc:SyncRpc=async(name,args)=>{
  calls.push({name,args});
  if(name==='fd_sheet_sync_probe')return {data:{source_id:state.source_id,source_url:state.source_url,last_source_hash:lastSourceHash,last_result:lastResult},error:null};
  if(name==='fd_sheet_sync_context')return {data:structuredClone(state),error:null};
  if(name==='fd_apply_sheet_sync'){
   for(const change of args.p_changes as {id:string;account_id:string;row:Transaction}[]){
    state.dataset.transactions=state.dataset.transactions.filter(t=>t.id!==change.id);
    state.dataset.transactions.push({...change.row,id:change.id,account_id:change.account_id,business_id:'business',upload_id:null});
   }
   state.source_fingerprints=args.p_fingerprints as string[];
   lastSourceHash=args.p_snapshot_hash as string;
   return {data:{run_id:args.p_run},error:null};
  }
  if(name==='fd_sheet_sync_finish'&&!args.p_error){
   if(args.p_fingerprints)state.source_fingerprints=args.p_fingerprints as string[];
   if(args.p_source_hash)lastSourceHash=args.p_source_hash as string;
   lastResult=args.p_result as Record<string,unknown>;
  }
  return {data:{},error:null};
 };
 return {state,calls,rpc,setRows:(value:unknown[][])=>{current=value;},fetchSource:async()=>({sourceUrl,bytes:bytes(current)})};
}
test('은행봇의 11열 구조에서 과목·상대 내역·입출금·잔액을 보존한다',async()=>{
 const plan=await prepareAutomaticSheetSync(bytes([payment]),context());
 assert.equal(plan.summary.inserted,1);
 const row=plan.changes[0].row;
 assert.equal(row.category_id,'salary');assert.equal(row.txn_date,'2026-09-01');
 assert.equal(row.amount,1000);assert.equal(row.direction,'out');assert.equal(row.balance,9000);
 assert.equal(row.source_details?.basic,'테스트 급여');assert.equal(row.source_details?.detail,'가상직원');
 assert.equal(row.source_details?.note,'테스트 메모');
});
test('반복 동기화는 거래를 추가하지 않으며 실행 전 미리보기는 상태도 쓰지 않는다',async()=>{
 const h=harness();
 const preview=await runSheetSync({token,...h,dryRun:true});
 assert.equal(preview.inserted,1);assert.equal(h.state.dataset.transactions.length,0);
 assert.deepEqual(h.calls.map(c=>c.name),['fd_sheet_sync_probe','fd_sheet_sync_context']);
 const first=await runSheetSync({token,...h});assert.equal(first.inserted,1);
 const second=await runSheetSync({token,...h});assert.equal(second.inserted,0);assert.equal(second.updated,0);
 assert.equal(h.state.dataset.transactions.length,1);assert.equal(h.calls.filter(c=>c.name==='fd_apply_sheet_sync').length,1);
});
test('시트가 그대로거나 새 거래가 추가되어도 대시보드에서 직접 수정한 분류는 유지한다',async()=>{
 const h=harness();await runSheetSync({token,...h});
 h.state.dataset.transactions[0].category_id='other';
 const unchanged=await runSheetSync({token,...h});assert.equal(unchanged.updated,0);
 h.setRows([payment,nextPayment]);
 const appended=await runSheetSync({token,...h});
 assert.equal(appended.inserted,1);assert.equal(appended.updated,0);
 assert.equal(h.state.dataset.transactions.find(t=>t.txn_date==='2026-09-01')?.category_id,'other');
});
test('시트에서 실제 계정과목을 수정하면 원래 거래를 업데이트한다',async()=>{
 const h=harness();await runSheetSync({token,...h});
 const changed=[...payment];changed[3]='기타비용';h.setRows([changed]);
 const result=await runSheetSync({token,...h});assert.equal(result.inserted,0);assert.equal(result.updated,1);
 assert.equal(h.state.dataset.transactions.length,1);assert.equal(h.state.dataset.transactions[0].category_id,'other');
});
test('행 정렬만 바뀌어도 기존 분류를 다시 덮어쓰지 않는다',async()=>{
 const h=harness([payment,nextPayment]);await runSheetSync({token,...h});
 h.state.dataset.transactions[0].category_id='other';h.setRows([nextPayment,payment]);
 const result=await runSheetSync({token,...h});assert.equal(result.inserted,0);assert.equal(result.updated,0);
});
test('이미 반영한 시트 거래의 금액·날짜·기본내역 변경은 새 거래로 만들지 않고 멈춘다',async()=>{
 for(const [column,value] of [[7,2000],[2,3],[4,'바뀐 내역']] as const){
  const h=harness();await runSheetSync({token,...h});
  const changed=[...payment];changed[column]=value;h.setRows([changed]);
  await assert.rejects(runSheetSync({token,...h}),/SHEET_SYNC_SOURCE_ROWS_CHANGED/);
  assert.equal(h.state.dataset.transactions.length,1);assert.equal(h.state.dataset.transactions[0].amount,1000);
 }
});
test('적용 후 finish는 원자적으로 저장한 체크포인트를 다시 쓰지 않는다',async()=>{
 const h=harness();await runSheetSync({token,...h});
 const applied=h.calls.find(c=>c.name==='fd_apply_sheet_sync')!;
 assert.deepEqual(applied.args.p_expected_fingerprints,[]);
 const finished=h.calls.find(c=>c.name==='fd_sheet_sync_finish')!;
 assert.equal('p_fingerprints' in finished.args,false);
 await runSheetSync({token,...h,force:true});
 const noOp=h.calls.filter(c=>c.name==='fd_sheet_sync_finish').at(-1)!;
 assert.deepEqual(noOp.args.p_expected_fingerprints,h.state.source_fingerprints);
});
test('원본이 그대로인 예약 실행은 전체 금융 자료를 읽지 않고 수동 재시도는 다시 확인한다',async()=>{
 const h=harness();await runSheetSync({token,...h});h.calls.length=0;
 await runSheetSync({token,...h});assert.deepEqual(h.calls.map(c=>c.name),['fd_sheet_sync_probe','fd_sheet_sync_finish']);
 h.calls.length=0;await runSheetSync({token,...h,force:true});
 assert.ok(h.calls.some(c=>c.name==='fd_sheet_sync_context'));
});
test('새 거래 시트나 사라진 연결 시트는 계좌를 추측하지 않고 중단한다',async()=>{
 await assert.rejects(prepareAutomaticSheetSync(bytes([payment],'새로운 거래통장'),context()),/SHEET_SYNC_MAPPING_CHANGED/);
 const state=context();state.mappings.push({sheet:'사라진 통장',account_id:'account',selected:true});
 await assert.rejects(prepareAutomaticSheetSync(bytes([payment]),state),/SHEET_SYNC_MAPPING_CHANGED/);
});
test('구분 불가능한 반복 거래는 보류하고 처리 완료 체크포인트에 넣지 않는다',async()=>{
 const plan=await prepareAutomaticSheetSync(bytes([payment,payment]),context());
 assert.equal(plan.summary.blocked,2);assert.equal(plan.summary.inserted,0);assert.deepEqual(plan.checkpoint,[]);
});
test('첫 연동에서 적요가 다른 기존 거래와 잔액·시간이 구분되지 않으면 보류하고 다른 신규 거래만 반영한다',async()=>{
 for(const [existingBalance,sourceBalance] of [[9000,9000],[null,9000],[9000,null],[null,null]] as const){
  const h=harness([payment,nextPayment]);
  const seed=await prepareAutomaticSheetSync(bytes([payment]),context());
  const change=seed.changes[0];
  const existing:Transaction={...change.row,id:'existing-bank-payment',account_id:'account',business_id:'business',upload_id:'original-bank-upload',description:'은행에서 읽은 다른 적요',source_details:null,balance:existingBalance,category_id:'other',manually_classified:true};
  h.state.dataset.transactions=[existing];
  const before=structuredClone(existing);
  const ambiguous:unknown[]=[...payment];ambiguous[10]=sourceBalance;
  h.setRows([ambiguous,nextPayment]);
  const onlyNew=await prepareAutomaticSheetSync(bytes([nextPayment]),context());
  const result=await runSheetSync({token,...h});
  assert.equal(result.inserted,1);assert.equal(result.updated,0);assert.equal(result.blocked,1);
  assert.equal(h.state.dataset.transactions.length,2);
  assert.deepEqual(h.state.dataset.transactions.find(t=>t.id===existing.id),before);
  assert.deepEqual(h.state.source_fingerprints,onlyNew.checkpoint);
  const repeated=await runSheetSync({token,...h});
  assert.equal(repeated.inserted,0);assert.equal(repeated.updated,0);assert.equal(repeated.blocked,1);
  assert.equal(h.state.dataset.transactions.length,2);
 }
});

test('첫 연동에서 날짜·금액이 같아도 명시된 잔액이 다른 거래는 별도 신규 거래로 반영한다',async()=>{
 const h=harness();
 const seed=await prepareAutomaticSheetSync(bytes([payment]),context());
 const change=seed.changes[0];
 const existing:Transaction={...change.row,id:'existing-distinct-payment',account_id:'account',business_id:'business',upload_id:'original-bank-upload',description:'은행의 앞선 급여 지급',balance:10000,category_id:'other',manually_classified:true};
 h.state.dataset.transactions=[existing];
 const before=structuredClone(existing);
 const result=await runSheetSync({token,...h});
 assert.equal(result.inserted,1);assert.equal(result.updated,0);assert.equal(result.blocked,0);
 assert.equal(h.state.dataset.transactions.length,2);
 assert.deepEqual(h.state.dataset.transactions.find(t=>t.id===existing.id),before);
 const added=h.state.dataset.transactions.find(t=>t.id!==existing.id)!;
 assert.equal(added.balance,9000);assert.equal(added.description,change.row.description);
 assert.equal(added.source_details?.detail,'가상직원');
 assert.equal(h.state.source_fingerprints.length,1);
 const repeated=await runSheetSync({token,...h});
 assert.equal(repeated.inserted,0);assert.equal(repeated.updated,0);
 assert.equal(h.state.dataset.transactions.length,2);
});

test('다른 출처나 거래내용을 요청자가 전달하는 인터페이스가 없고 등록 URL만 읽는다',async()=>{
 const h=harness();let fetched='';
 await runSheetSync({token,...h,fetchSource:async url=>{fetched=url;return {sourceUrl,bytes:bytes([payment])};}});
 assert.equal(fetched,sourceUrl);
 const apply=h.calls.find(c=>c.name==='fd_apply_sheet_sync')!;
 assert.equal('p_source_url' in apply.args,false);assert.equal('p_owner' in apply.args,false);
});
test('인증 실패와 DB 실패를 금융 원문이나 토큰 없이 처리하며 실패 시 체크포인트를 저장하지 않는다',async()=>{
 let called=false;
 await assert.rejects(runSheetSync({token:'bad',rpc:async()=>{called=true;return {data:null,error:null};}}),/SHEET_SYNC_UNAUTHORIZED/);
 assert.equal(called,false);
 const h=harness();
 const rpc:SyncRpc=async(name,args)=>name==='fd_apply_sheet_sync'?{data:null,error:{message:'sensitive internal data'}}:h.rpc(name,args);
 await assert.rejects(runSheetSync({token,...h,rpc}),/SHEET_SYNC_APPLY_FAILED/);
 const finish=h.calls.find(c=>c.name==='fd_sheet_sync_finish')!;
 assert.equal(finish.args.p_error,'SHEET_SYNC_APPLY_FAILED');assert.equal('p_fingerprints' in finish.args,false);
 assert.deepEqual(h.state.source_fingerprints,[]);
 assert.equal(syncErrorMessage('some raw financial error'),syncErrorMessage('SHEET_SYNC_FAILED'));
});
