import test from 'node:test';
import assert from 'node:assert/strict';
import {utils,write} from '@e965/xlsx';
import {fetchGoogleSheet,googleSheetUrl,prepareSheetRows,prepareSheetRowsFromSnapshot,sheetSnapshot,suggestSheetAccount} from '../lib/finance/google-sheets';
import {buildSheetMergePlan} from '../lib/finance/sheet-merge';
import {resolveSheetCategory} from '../lib/finance/sheet-category';
import {digest} from '../lib/finance/parser';
import {emptyDataset,type Account,type Business,type Dataset,type Transaction} from '../lib/finance/types';

// Every identifier, workbook, business and transaction in this file is synthetic.
const sheetId='A_test_spreadsheet_identifier_12345';
const shareUrl=`https://docs.google.com/spreadsheets/d/${sheetId}/edit?usp=sharing#gid=123`;
const canonicalUrl=`https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
const exportUrl=`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
const maxBytes=4*1024*1024;
const business=(id:string,name:string):Business=>({id,name,representative:'',kind:'법인',reserve:0,color:'#ffffff'});
const account=(id:string,business_id:string,name:string):Account=>({id,business_id,name,bank:'가상은행',masked_number:'***0000',opening_balance:0,opening_balance_date:null});
const businesses=[business('biz-a','가상회사'),business('biz-b','테스트상사')];
const accounts=[account('account-a','biz-a','운영통장'),account('account-a2','biz-a','예비통장'),account('account-b','biz-b','운영통장')];
const header=['거래일자','거래내용','출금금액','입금금액','계정과목','거래 후 잔액','세금계산서','거래시간'];
const dataset:Dataset={...emptyDataset,businesses,accounts,categories:[
 {id:'category-rent',name:'임차료',group_name:'영업지출',is_operating:true,is_internal:false},
 {id:'category-ad',name:'광고선전비',group_name:'영업지출',is_operating:true,is_internal:false},
 {id:'category-internal',name:'내부대체',group_name:'내부이동',is_operating:false,is_internal:true},
 {id:'category-unmapped',name:'미매핑',group_name:'정리필요',is_operating:false,is_internal:false},
],rules:[{id:'rule-ad',pattern:'테스트',field:'description',category_id:'category-ad',priority:1,is_internal:false}],aliases:[{id:'alias-rent',raw_name:'월세',standard_name:'임차료'}]};
function workbook(sheets:{name:string;rows:unknown[][];hidden?:boolean}[]){
 const wb=utils.book_new();
 for(const sheet of sheets)utils.book_append_sheet(wb,utils.aoa_to_sheet(sheet.rows),sheet.name);
 wb.Workbook={Sheets:sheets.map(sheet=>({name:sheet.name,Hidden:sheet.hidden?1:0}))};
 return new Uint8Array(write(wb,{bookType:'xlsx',type:'array'}) as ArrayBuffer);
}
function oneSheet(rows:unknown[][]){return workbook([{name:'가상회사 운영통장',rows:[header,...rows]}]);}

test('이미 파싱한 원본은 변경 없이 재사용하며 기존 바이트 경로와 해시·분류·요약이 같다',async()=>{
 const bytes=oneSheet([
  ['2026-01-01','테스트 임대',1000,'','월세',9000,'O','09:10:00'],
  ['2026-01-02','테스트 대체',2000,'','내부대체',7000,'','09:11:00'],
  ['2026-01-03','가상 미매핑',500,'','미매핑',6500,'','09:12:00'],
 ]);
 const mappings=[{sheet:'가상회사 운영통장',account_id:'account-a',selected:true}];
 const original=await prepareSheetRows(bytes,dataset,mappings,canonicalUrl),snapshot=sheetSnapshot(bytes),before=structuredClone(snapshot);
 const freeze=(value:unknown)=>{if(value&&typeof value==='object'){for(const nested of Object.values(value))freeze(nested);Object.freeze(value);}};
 freeze(snapshot);
 assert.deepEqual(await prepareSheetRowsFromSnapshot(snapshot,dataset,mappings,canonicalUrl),original);
 const changed={...dataset,rules:[],aliases:[]};
 assert.deepEqual(await prepareSheetRowsFromSnapshot(snapshot,changed,mappings,canonicalUrl),await prepareSheetRows(bytes,changed,mappings,canonicalUrl));
 assert.deepEqual(snapshot,before);
});

test('공유 링크에서 원본 ID만 사용하며 외부 URL·자격증명·다른 포트를 거절한다',()=>{
 assert.deepEqual(googleSheetUrl(`  ${shareUrl}  `),{id:sheetId,url:canonicalUrl,exportUrl});
 for(const value of [
  'not-a-url',`http://docs.google.com/spreadsheets/d/${sheetId}/edit`,
  `https://example.org/spreadsheets/d/${sheetId}/edit`,
  `https://docs.google.com.example.org/spreadsheets/d/${sheetId}/edit`,
  `https://reader:secret@docs.google.com/spreadsheets/d/${sheetId}/edit`,
  `https://docs.google.com:444/spreadsheets/d/${sheetId}/edit`,
  `https://docs.google.com/document/d/${sheetId}/edit`,
  'https://docs.google.com/spreadsheets/d/short/edit',
 ])assert.throws(()=>googleSheetUrl(value),/Google Sheets/);
});

test('내보내기는 수동 리디렉션으로 Google 파일 주소만 따라가며 원본 링크를 반환한다',async t=>{
 const calls:{url:string;init?:RequestInit}[]=[];
 const payload=new Uint8Array([0x50,0x4b,3,4,1,2,3]);
 t.mock.method(globalThis,'fetch',async (input:RequestInfo|URL,init?:RequestInit)=>{
  calls.push({url:String(input),init});
  return calls.length===1?new Response(null,{status:302,headers:{location:'https://download.googleusercontent.com/export.xlsx'}}):new Response(payload);
 });
 const result=await fetchGoogleSheet(shareUrl);
 assert.equal(result.sourceUrl,canonicalUrl);assert.deepEqual(result.bytes,payload);
 assert.deepEqual(calls.map(call=>call.url),[exportUrl,'https://download.googleusercontent.com/export.xlsx']);
 assert.ok(calls.every(call=>call.init?.redirect==='manual'&&call.init.cache==='no-store'&&call.init.signal instanceof AbortSignal));
});

test('리디렉션 대상이 외부 호스트·자격증명·HTTP이면 네트워크 후속 요청을 하지 않는다',async t=>{
 for(const location of ['https://example.org/export.xlsx','https://download.googleusercontent.com.example.org/export.xlsx','https://name:secret@download.googleusercontent.com/export.xlsx','http://download.googleusercontent.com/export.xlsx','https://download.googleusercontent.com:444/export.xlsx']){
  await t.test(location,async child=>{
   let calls=0;
   child.mock.method(globalThis,'fetch',async ()=>{calls++;return new Response(null,{status:302,headers:{location}});});
   await assert.rejects(fetchGoogleSheet(shareUrl),/서버에서 읽을 수 없습니다/);assert.equal(calls,1);
  });
 }
});

test('끝없는 리디렉션은 다섯 번 이내에 중단한다',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async ()=>{calls++;return new Response(null,{status:302,headers:{location:'/export-again'}});});
 await assert.rejects(fetchGoogleSheet(shareUrl),/너무 여러 번/);assert.equal(calls,5);
});

test('헤더에서 4MB를 초과하면 본문을 읽기 전에 거절한다',async t=>{
 t.mock.method(globalThis,'fetch',async ()=>new Response(new Uint8Array([0x50,0x4b]),{headers:{'content-length':String(maxBytes+1)}}));
 await assert.rejects(fetchGoogleSheet(shareUrl),/4MB 이하/);
});

test('크기 헤더가 없어도 스트림의 4MB 초과를 검출하고 읽기를 취소한다',async t=>{
 let cancelled=false;
 const first=new Uint8Array(maxBytes);first[0]=0x50;first[1]=0x4b;
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(first);controller.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;}});
 t.mock.method(globalThis,'fetch',async ()=>new Response(body));
 await assert.rejects(fetchGoogleSheet(shareUrl),/4MB 이하/);assert.equal(cancelled,true);
});

test('정확히 4MB의 ZIP 데이터는 수신하고 로그인 HTML은 거절한다',async t=>{
 await t.test('4MB 경계값',async child=>{
  const payload=new Uint8Array(maxBytes);payload[0]=0x50;payload[1]=0x4b;
  child.mock.method(globalThis,'fetch',async ()=>new Response(payload,{headers:{'content-length':String(maxBytes)}}));
  assert.equal((await fetchGoogleSheet(shareUrl)).bytes.length,maxBytes);
 });
 await t.test('HTML 로그인 화면',async child=>{
  child.mock.method(globalThis,'fetch',async ()=>new Response('<!doctype html><title>Sign in</title>',{headers:{'content-type':'text/html'}}));
  await assert.rejects(fetchGoogleSheet(shareUrl),/Excel 형식/);
 });
});

test('계좌 추천은 사업자와 계좌를 함께 식별하고 모호한 이름을 임의로 선택하지 않는다',()=>{
 assert.equal(suggestSheetAccount('가상 회사 · 운영 통장 (2026)',businesses,accounts),'account-a');
 assert.equal(suggestSheetAccount('테스트상사_운영통장',businesses,accounts),'account-b');
 assert.equal(suggestSheetAccount('가상회사 예비통장',businesses,accounts),'account-a2');
 assert.equal(suggestSheetAccount('운영통장',businesses,accounts),null);
 assert.equal(suggestSheetAccount('가상회사',businesses,accounts),null);
 assert.equal(suggestSheetAccount('가상회사 테스트상사 운영통장',businesses,accounts),null);
 assert.equal(suggestSheetAccount('가상회사 운영통장 예비통장',businesses,accounts),null);
 assert.equal(suggestSheetAccount('가상회사 운영통장',businesses,[...accounts,account('account-extra','biz-a','운영통장')]),null);
 const prefixed=[business('prefix-a','예시 가상회사'),business('prefix-b','예시 테스트상사')];
 const prefixedAccounts=[account('prefix-account-a','prefix-a','운영통장'),account('prefix-account-b','prefix-b','운영통장')];
 assert.equal(suggestSheetAccount('예시 운영통장',prefixed,prefixedAccounts),null);
 const aliases=[{businessName:'예시 가상회사',aliases:['예시']}];
 assert.equal(suggestSheetAccount('예시 운영통장',prefixed,prefixedAccounts,aliases),'prefix-account-a');
 assert.equal(suggestSheetAccount('예시 운영통장',prefixed,prefixedAccounts,[...aliases,{businessName:'예시 테스트상사',aliases:['예시']}]),null);
});

test('명시한 계정과목과 별칭은 적요 자동규칙보다 우선하며 내부대체 속성도 유지한다',async ()=>{
 const prepared=await prepareSheetRows(oneSheet([
  ['2026-01-01','테스트 임대',1000,'','임차료',9000,'O','09:10:00'],
  ['2026-01-02','테스트 월세',1000,'','월세',8000,'','09:11:00'],
  ['2026-01-03','테스트 대체',1000,'','내부대체',7000,'','09:12:00'],
 ]),dataset);
 assert.deepEqual(prepared.incoming.map(row=>row.category_id),['category-rent','category-rent','category-internal']);
 assert.deepEqual(prepared.incoming.map(row=>row.is_internal),[false,false,true]);
 assert.ok(prepared.incoming.every(row=>row.provided.category));
 assert.equal(prepared.incoming[0].tax_invoice,true);
 assert.deepEqual(prepared.sheets[0].sample.map(row=>row.category_name),['임차료','임차료','내부대체']);
});

test('미등록 명시 과목과 규칙으로 해결되지 않는 미매핑은 원본 과목과 확인 사유를 보존한다',async ()=>{
 const prepared=await prepareSheetRows(oneSheet([
  ['2026-01-01','테스트 미등록',1000,'','없는 가상 과목',9000,'','09:10:00'],
  ['2026-01-02','가상 미매핑',1000,'','미매핑',8000,'','09:11:00'],
 ]),dataset);
 assert.deepEqual(prepared.incoming.map(row=>row.category_id),['category-unmapped','category-unmapped']);
 assert.deepEqual(prepared.sheets[0].sample.map(row=>row.category_name),['미매핑','미매핑']);
 assert.deepEqual(prepared.sheets[0].sample.map(row=>[row.raw_category,row.category_status]),[['없는 가상 과목','unregistered'],['미매핑','needs_review']]);
 assert.deepEqual(prepared.sheets[0].categoryIssues,[{rawName:'없는 가상 과목',count:1,status:'unregistered'},{rawName:'미매핑',count:1,status:'needs_review'}]);
 const withoutDefault=await prepareSheetRows(oneSheet([['2026-01-01','가상 미등록 거래',1000,'','없는 가상 과목',9000,'','09:10:00']]),{...dataset,categories:dataset.categories.filter(category=>category.name!=='미매핑')});
 assert.equal(withoutDefault.incoming[0].category_id,null);
 assert.equal(withoutDefault.sheets[0].sample[0].category_name,'미매핑');
 assert.equal(withoutDefault.sheets[0].sample[0].raw_category,'없는 가상 과목');
});

test('일반 입출금·미매핑의 유효 규칙 결과는 보존하되 명시 과목을 대신하지 않고 자동 분류로 저장한다',async()=>{
 const configured:Dataset={...dataset,categories:[...dataset.categories,
  {id:'category-in',name:'입금',group_name:'정리필요',is_operating:false,is_internal:false},
  {id:'category-out',name:'출금',group_name:'정리필요',is_operating:false,is_internal:false},
 ],rules:[
  {id:'rule-out',pattern:'가상정기',field:'description',category_id:'category-ad',priority:1,is_internal:false,account_id:'account-a',direction:'out'},
  {id:'rule-in',pattern:'가상반환',field:'description',category_id:'category-internal',priority:1,is_internal:true,account_id:'account-a',direction:'in'},
 ]};
 const prepared=await prepareSheetRows(oneSheet([
  ['2026-01-01','가상정기 첫 거래',1000,'','출금',9000,'','09:10:00'],
  ['2026-01-02','가상반환 둘째 거래','',1000,'입금',10000,'','09:11:00'],
  ['2026-01-03','가상정기 셋째 거래',1000,'','미매핑',9000,'','09:12:00'],
  ['2026-01-04','가상정기 넷째 거래',1000,'','임차료',8000,'','09:13:00'],
  ['2026-01-05','가상정기 다섯째 거래',1000,'','미등록 가상 과목',7000,'','09:14:00'],
  ['2026-01-06','규칙 없는 가상 거래',1000,'','출금',6000,'','09:15:00'],
 ]),configured);
 assert.deepEqual(prepared.incoming.map(row=>row.category_id),['category-ad','category-internal','category-ad','category-rent','category-unmapped','category-out']);
 assert.deepEqual(prepared.incoming.map(row=>row.category_status),['needs_review','needs_review','needs_review','mapped','unregistered','needs_review']);
 assert.equal(prepared.incoming[1].is_internal,true);
 assert.deepEqual(prepared.sheets[0].sample.map(row=>row.category_name),['광고선전비','내부대체','광고선전비','임차료','미매핑','출금']);
 assert.deepEqual(prepared.sheets[0].sample.map(row=>row.raw_category),['출금','입금','미매핑','임차료','미등록 가상 과목','출금']);
 assert.deepEqual(prepared.sheets[0].categoryIssues,[
  {rawName:'출금',count:2,status:'needs_review'},{rawName:'입금',count:1,status:'needs_review'},
  {rawName:'미매핑',count:1,status:'needs_review'},{rawName:'미등록 가상 과목',count:1,status:'unregistered'},
 ]);
 const plan=await buildSheetMergePlan(configured,prepared.incoming,prepared.sourceHash);
 assert.equal(plan.summary.inserted,6);
 const changes=new Map(plan.changes.map(change=>[change.row.txn_date,change.row]));
 assert.equal(changes.get('2026-01-04')!.manually_classified,true);
 for(const date of ['2026-01-01','2026-01-02','2026-01-03','2026-01-05','2026-01-06'])assert.equal(changes.get(date)!.manually_classified,false);
 assert.ok(plan.changes.every(change=>!('category_status' in change.row)));
});

test('일반 원과목에 규칙이 있어도 기존 사용자 분류는 보존하고 미분류만 자동 분류한다',async()=>{
 const prepared=await prepareSheetRows(oneSheet([['2026-01-01','테스트 정기 거래',1000,'','미매핑',9000,'','09:10:00']]),dataset);
 const source=prepared.incoming[0];
 assert.equal(source.category_id,'category-ad');assert.equal(source.category_status,'needs_review');
 for(const [previousCategory,previousManual,expectedCategory,expectedManual] of [
  ['category-rent',true,'category-rent',true],['category-rent',false,'category-rent',false],
  ['category-unmapped',false,'category-ad',false],['category-unmapped',true,'category-ad',false],
 ] as const){
  const previous:Transaction={id:'previous-rule',business_id:'biz-a',account_id:'account-a',upload_id:null,txn_date:source.txn_date,txn_time:source.txn_time,amount:source.amount,direction:source.direction,description:source.description,raw_gwamok:'이전 원과목',category_id:previousCategory,is_internal:false,balance:source.balance,tax_invoice:source.tax_invoice,dedup_hash:source.dedup_hash,manually_classified:previousManual};
  const plan=await buildSheetMergePlan({...dataset,transactions:[previous]},prepared.incoming,prepared.sourceHash);
  assert.equal(plan.summary.updated,1);assert.equal(plan.summary.inserted,0);
  const change=plan.changes[0];
  assert.equal(change.id,previous.id);assert.equal(change.row.category_id,expectedCategory);assert.equal(change.row.manually_classified,expectedManual);
  assert.equal(change.row.raw_gwamok,'미매핑');assert.equal(change.row.dedup_hash,previous.dedup_hash);
  assert.equal(change.row.amount,previous.amount);assert.equal(change.row.txn_date,previous.txn_date);
 }
});

test('일반·빈 원과목은 적요·기본·세부내역 전체의 유일한 등록 과목만 자동 연결한다',async()=>{
 const configured:Dataset={...dataset,rules:[],categories:[...dataset.categories,{id:'category-out',name:'출금',group_name:'정리필요',is_operating:false,is_internal:false}]};
 const prepared=await prepareSheetRows(workbook([{name:'가상회사 운영통장',rows:[[...header,'기본내역','세부내역'],
  ['2026-02-01','임차료',1000,'','출금',9000,'','09:10:00','',''],
  ['2026-02-02','합성 거래 A',1000,'','미매핑',8000,'','09:11:00','임 차 료',''],
  ['2026-02-03','합성 거래 B',1000,'','',7000,'','09:12:00','','내부대체'],
  ['2026-02-04','합성 거래 C',1000,'','출금',6000,'','09:13:00','임차료','임 차 료'],
 ]}]),configured);
 assert.deepEqual(prepared.incoming.map(row=>row.category_id),['category-rent','category-rent','category-internal','category-rent']);
 assert.deepEqual(prepared.incoming.map(row=>row.category_status),['needs_review','needs_review','blank','needs_review']);
 assert.equal(prepared.incoming[2].is_internal,true);assert.equal(prepared.incoming[2].provided.category,false);
 assert.ok(prepared.incoming.every(row=>!row.manually_classified));
 assert.deepEqual(prepared.sheets[0].sample.map(row=>row.raw_category),['출금','미매핑','','출금']);
 const plan=await buildSheetMergePlan(configured,prepared.incoming,prepared.sourceHash);
 assert.equal(plan.summary.inserted,4);assert.ok(plan.changes.every(change=>!change.row.manually_classified));
});

test('명시 내역 보조 분류는 규칙·명시 원과목보다 뒤이며 부분명·미등록명·충돌을 추측하지 않는다',async()=>{
 const prepared=await prepareSheetRows(workbook([{name:'가상회사 운영통장',rows:[[...header,'기본내역','세부내역'],
  ['2026-02-01','테스트 규칙 거래',1000,'','미매핑',9000,'','09:10:00','임차료',''],
  ['2026-02-02','합성 거래 A',1000,'','내부대체',8000,'','09:11:00','임차료',''],
  ['2026-02-03','합성 거래 B',1000,'','미등록 합성 과목',7000,'','09:12:00','임차료',''],
  ['2026-02-04','임차료 지급',1000,'','미매핑',6000,'','09:13:00','김가상',''],
  ['2026-02-05','합성 거래 C',1000,'','미매핑',5000,'','09:14:00','임차료','광고선전비'],
  ['2026-02-06','합성 거래 D',1000,'','미매핑',4000,'','09:15:00','월세',''],
 ]}]),dataset);
 assert.deepEqual(prepared.incoming.map(row=>row.category_id),['category-ad','category-internal','category-unmapped','category-unmapped','category-unmapped','category-unmapped']);
 const colliding:Dataset={...dataset,rules:[],categories:[...dataset.categories,{...dataset.categories[0],id:'category-rent-collision',name:'임 차 료'}]};
 const duplicate=await prepareSheetRows(oneSheet([['2026-02-01','임차료',1000,'','미매핑',9000,'','09:10:00']]),colliding);
 assert.equal(duplicate.incoming[0].category_id,'category-unmapped');
});

test('명시 내역으로 새 과목을 찾아도 기존 유효 분류·원과목·금액·중복 식별값을 보호한다',async()=>{
 for(const raw of ['미매핑','']){
  const prepared=await prepareSheetRows(oneSheet([['2026-02-01','임차료',1000,'',raw,9000,'','09:10:00']]),{...dataset,rules:[]});
  const source=prepared.incoming[0];
  assert.equal(source.category_id,'category-rent');
  const previous:Transaction={id:'preserve-explicit-detail',business_id:'biz-a',account_id:source.account_id,upload_id:null,txn_date:source.txn_date,txn_time:source.txn_time,amount:source.amount,direction:source.direction,description:source.description,raw_gwamok:'내부대체',category_id:'category-internal',is_internal:true,balance:source.balance,tax_invoice:false,dedup_hash:source.dedup_hash,manually_classified:true};
  const plan=await buildSheetMergePlan({...dataset,transactions:[previous]},prepared.incoming,prepared.sourceHash);
  const change=plan.changes[0];
  assert.equal(change.row.category_id,'category-internal');assert.equal(change.row.is_internal,true);assert.equal(change.row.manually_classified,true);
  assert.equal(change.row.raw_gwamok,raw||previous.raw_gwamok);assert.equal(change.row.amount,previous.amount);assert.equal(change.row.dedup_hash,previous.dedup_hash);
 }
});

test('명시 과목과 별칭은 NFKC·공백 정규화 뒤 유일하게 연결되는 경우에만 적용한다',async()=>{
 const configured:Dataset={...dataset,categories:[...dataset.categories,{id:'category-saas',name:'SaaS',group_name:'영업지출',is_operating:true,is_internal:false}],aliases:[...dataset.aliases,{id:'alias-space',raw_name:'임대 료',standard_name:'임 차 료'}]};
 const prepared=await prepareSheetRows(oneSheet([
  ['2026-01-01','가상 거래 1',1000,'',' 임\t차 료 ',9000,'','09:10:00'],
  ['2026-01-02','가상 거래 2',1000,'','임대료',8000,'','09:11:00'],
  ['2026-01-03','가상 거래 3',1000,'','ＳａａＳ',7000,'','09:12:00'],
 ]),configured);
 assert.deepEqual(prepared.incoming.map(row=>row.category_id),['category-rent','category-rent','category-saas']);
 assert.ok(prepared.incoming.every(row=>row.category_status==='mapped'));
 assert.deepEqual(prepared.sheets[0].categoryIssues,[]);
 assert.deepEqual(prepared.sheets[0].sample.map(row=>row.raw_category),['임\t차 료','임대료','ＳａａＳ']);
});

test('정규화된 과목명이나 별칭 대상이 둘 이상이면 임의의 과목을 선택하지 않는다',()=>{
 const colliding=[...dataset.categories,{...dataset.categories[0],id:'category-rent-other',name:'임 차 료'}];
 assert.deepEqual(resolveSheetCategory('임차료',colliding,[]),{status:'unregistered'});
 const aliases=[{id:'first',raw_name:'월 세',standard_name:'임차료'},{id:'second',raw_name:'월세',standard_name:'광고선전비'}];
 assert.deepEqual(resolveSheetCategory('월세',dataset.categories,aliases),{status:'unregistered'});
 assert.deepEqual(resolveSheetCategory('임차료',dataset.categories,[{id:'conflict',raw_name:'임 차 료',standard_name:'광고선전비'}]),{status:'unregistered'});
 assert.deepEqual(resolveSheetCategory('월세',dataset.categories,[{id:'missing',raw_name:'월세',standard_name:'등록되지 않은 과목'}]),{status:'unregistered'});
});

test('과목 확인 사유는 시트별 이름·건수만 집계하고 빈 원과목을 구분한다',async()=>{
 const configured:Dataset={...dataset,categories:[...dataset.categories,{id:'category-in',name:'입금',group_name:'정리필요',is_operating:false,is_internal:false}]};
 const prepared=await prepareSheetRows(oneSheet([
  ['2026-01-01','가상 첫 거래',1000,'','새로운 과목',9000,'','09:10:00'],
  ['2026-01-02','가상 둘째 거래',1000,'','새로운 과목',8000,'','09:11:00'],
  ['2026-01-03','가상 세째 거래','',1000,'입금',9000,'','09:12:00'],
  ['2026-01-04','가상 넷째 거래',1000,'','',8000,'','09:13:00'],
 ]),configured);
 assert.deepEqual(prepared.sheets[0].categoryIssues,[{rawName:'새로운 과목',count:2,status:'unregistered'},{rawName:'입금',count:1,status:'needs_review'}]);
 assert.equal(prepared.sheets[0].sample[3].category_status,'blank');
 const plan=await buildSheetMergePlan(configured,prepared.incoming,prepared.sourceHash);
 assert.ok(plan.changes.every(change=>change.row.manually_classified===false));
 assert.ok(plan.changes.every(change=>!('category_status' in change.row)&&!('raw_category' in change.row)));
});

test('미등록 원과목은 기존 유효 분류를 보존하고 잘못 확정된 미매핑은 다시 검토 가능하게 한다',async()=>{
 const prepared=await prepareSheetRows(oneSheet([['2026-01-01','가상 정기 거래',1000,'','미등록 가상 과목',9000,'','09:10:00']]),dataset);
 const source=prepared.incoming[0];
 for(const [category_id,manually_classified,expectedManual] of [['category-rent',true,true],['category-rent',false,false],['category-unmapped',true,false],[null,true,false]] as const){
  const previous:Transaction={...source,id:'previous',account_id:'account-a',business_id:'biz-a',upload_id:null,category_id,manually_classified,raw_gwamok:category_id==='category-rent'?'임차료':source.raw_gwamok,dedup_hash:await digest('account-a',source.txn_date,source.amount,source.direction,source.description,source.balance)};
  // Runtime metadata belongs to the sheet plan, never a persisted transaction.
  delete (previous as Transaction&{category_status?:string}).category_status;
  delete (previous as Transaction&{provided?:unknown}).provided;
  delete (previous as Transaction&{sheet?:unknown}).sheet;
  const plan=await buildSheetMergePlan({...dataset,transactions:[previous]},prepared.incoming,prepared.sourceHash);
  assert.equal(plan.summary.updated,1);assert.equal(plan.summary.inserted,0);
  const change=plan.changes[0];
  assert.equal(change.id,previous.id);assert.equal(change.row.category_id,category_id==='category-rent'?category_id:'category-unmapped');
  assert.equal(change.row.manually_classified,expectedManual);assert.equal(change.row.raw_gwamok,'미등록 가상 과목');
  for(const field of ['txn_date','amount','direction','description','balance','txn_time','dedup_hash'] as const)assert.equal(change.row[field],previous[field]);
  assert.equal('category_status' in change.row,false);assert.equal('category_status' in change.expected!,false);
 }
 const validPrevious:Transaction={...prepared.incoming[0],id:'previous-known',account_id:'account-a',business_id:'biz-a',upload_id:null,category_id:'category-ad',manually_classified:true};
 delete (validPrevious as Transaction&{category_status?:string}).category_status;
 delete (validPrevious as Transaction&{provided?:unknown}).provided;
 delete (validPrevious as Transaction&{sheet?:unknown}).sheet;
 const known=await prepareSheetRows(oneSheet([['2026-01-01','가상 정기 거래',1000,'','임차료',9000,'','09:10:00']]),dataset);
 const plan=await buildSheetMergePlan({...dataset,transactions:[validPrevious]},known.incoming,known.sourceHash);
 assert.equal(plan.changes[0].row.category_id,'category-rent');assert.equal(plan.changes[0].row.manually_classified,true);
});

test('빈 과목·잔액·세금계산서·시간은 제공되지 않은 필드로 표시하고 기존 거래 값을 보존한다',async ()=>{
 const prepared=await prepareSheetRows(oneSheet([['2026-01-01','정기 테스트 거래',1000,'','','','','']]),dataset);
 const source=prepared.incoming[0];
 assert.deepEqual(source.provided,{category:false,balance:false,tax:false,time:false});
 const previous:Transaction={id:'previous',business_id:'biz-a',account_id:'account-a',upload_id:'old-upload',txn_date:source.txn_date,txn_time:'11:22:33',amount:1000,direction:'out',description:source.description,raw_gwamok:'임차료',category_id:'category-rent',is_internal:false,balance:3210,tax_invoice:true,dedup_hash:'old-hash',manually_classified:true};
 const plan=await buildSheetMergePlan({...dataset,transactions:[previous]},prepared.incoming,prepared.sourceHash);
 assert.equal(plan.summary.updated,1);assert.equal(plan.summary.inserted,0);assert.equal(plan.summary.removed,0);assert.equal(plan.conflicts.length,0);
 const next=plan.changes[0].row;
 assert.equal(next.category_id,previous.category_id);assert.equal(next.raw_gwamok,previous.raw_gwamok);assert.equal(next.balance,3210);assert.equal(next.tax_invoice,true);assert.equal(next.txn_time,'11:22:33');assert.equal(next.manually_classified,true);
});

test('명시적인 0원 잔액과 세금계산서 없음은 빈 값과 구분한다',async ()=>{
 const prepared=await prepareSheetRows(oneSheet([['2026-01-01','테스트 마지막 출금',1000,'','임차료',0,'N','00:00:00']]),dataset);
 assert.deepEqual(prepared.incoming[0].provided,{category:true,balance:true,tax:true,time:true});
 assert.equal(prepared.incoming[0].balance,0);assert.equal(prepared.incoming[0].tax_invoice,false);assert.equal(prepared.incoming[0].txn_time,'00:00:00');
});

test('숨긴 시트와 안내 시트는 제외하고 공개 거래 시트 전체 기간만 준비한다',async ()=>{
 const bytes=workbook([
  {name:'가상회사 운영통장',rows:[header,['2026-01-01','공개 거래',1000,'','임차료',9000,'','09:00:00'],['2026-09-01','공개 다음 거래','',2000,'',11000,'','10:00:00']]},
  {name:'테스트상사 운영통장',hidden:true,rows:[header,['2026-01-01','숨긴 거래',999999,'','광고선전비',1,'','08:00:00']]},
  {name:'안내',rows:[['자료 이용 안내'],['이 페이지는 거래가 아닙니다.']]},
 ]);
 assert.deepEqual(sheetSnapshot(bytes).map(sheet=>sheet.name),['가상회사 운영통장']);
 const prepared=await prepareSheetRows(bytes,dataset);
 assert.equal(prepared.incoming.length,2);assert.equal(prepared.sheets.length,1);assert.equal(prepared.sheets[0].from,'2026-01-01');assert.equal(prepared.sheets[0].to,'2026-09-01');
 assert.equal(prepared.sheets[0].income,2000);assert.equal(prepared.sheets[0].expense,1000);
});

test('명시한 계좌 선택과 시트 제외를 반영하며 존재하지 않는 계좌·시트는 거절한다',async ()=>{
 const bytes=oneSheet([['2026-01-01','테스트 거래',1000,'','임차료',9000,'','09:00:00']]);
 const changed=await prepareSheetRows(bytes,dataset,[{sheet:'가상회사 운영통장',account_id:'account-a2',selected:true}]);
 assert.equal(changed.incoming[0].account_id,'account-a2');
 const excluded=await prepareSheetRows(bytes,dataset,[{sheet:'가상회사 운영통장',account_id:'account-a',selected:false}]);
 assert.equal(excluded.incoming.length,0);assert.equal(excluded.sheets[0].count,1);
 await assert.rejects(prepareSheetRows(bytes,dataset,[{sheet:'가상회사 운영통장',account_id:'missing-account',selected:true}]),/계좌를 확인/);
 await assert.rejects(prepareSheetRows(bytes,dataset,[{sheet:'없는 시트',account_id:'account-a',selected:true}]),/시트 목록/);
});
