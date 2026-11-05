import test from 'node:test';
import assert from 'node:assert/strict';
import {utils,write} from '@e965/xlsx';
import {detect,validateMapping} from '../lib/finance/auto-mapping';
import {parseRows} from '../lib/finance/parser';
import {prepareSheetRows} from '../lib/finance/google-sheets';
import {emptyDataset} from '../lib/finance/types';
import {extractSourceDetails,getSourceDetailEntries,mergeSourceDetails,normalizeSourceDetails,sourceCounterparty} from '../lib/finance/source-details';

test('all explicit source columns survive alongside the single mapped description',async()=>{
 const headers=['거래일자','입금금액(원)','출금금액(원)','거래내용','기본내역','세부내역','보낸분/받는분','거래기록사항','이체메모','비고','계정과목'];
 const row=['2026-09-01',500,0,'급여','ICD수당8','8월 지급분','지원 기관','정산 입금','보낸 분 메모','검토 완료','지원금'];
 const rows=[headers,row],detected=detect(rows);
 assert.equal(detected.mapping.description,3);assert.doesNotThrow(()=>validateMapping(detected.mapping,rows,0));
 const categories=[{id:'grant',name:'지원금',group_name:'영업수입',is_operating:true,is_internal:false}];
 const result=await parseRows(rows,detected.mapping,'account',categories,[],[],{headerRow:0});
 assert.deepEqual(result.errors,[]);assert.equal(result.parsed[0].description,'급여');assert.equal(result.parsed[0].category_id,'grant');
 assert.deepEqual(result.parsed[0].source_details,{basic:'ICD수당8',detail:'8월 지급분',counterparty:'지원 기관',record:'정산 입금',memo:'보낸 분 메모',note:'검토 완료'});
 const changed=[...row];changed[4]='다른 원본 설명';changed[6]='다른 기관';changed[8]='다른 메모';
 const second=await parseRows([headers,changed],detected.mapping,'account',categories,[],[],{headerRow:0});
 assert.equal(second.parsed[0].dedup_hash,result.parsed[0].dedup_hash);
 assert.equal(second.parsed[0].category_id,result.parsed[0].category_id);
 assert.equal(second.parsed[0].amount,result.parsed[0].amount);
});

test('only explicit counterparty headings identify a sender or recipient',()=>{
 const details=extractSourceDetails(['거래내용','기본내역','받는 분 (상대방)','보낸분','예금주'],['급여','홍길동','수취인 예시','송금인 예시','본인 예금주']);
 assert.equal(details?.basic,'홍길동');
 assert.equal(details?.counterparty,'받는 분 (상대방): 수취인 예시 · 보낸분: 송금인 예시');
 assert.equal(sourceCounterparty({source_details:{basic:'홍길동',detail:'수취인 추정 금지'}}),null);
 assert.equal(sourceCounterparty({source_details:{counterparty:'명시된 상대방'}}),'명시된 상대방');
});

test('a directional source heading keeps its role even when it opposes the transaction direction',async()=>{
 for(const [header,income,expense,expectedDirection] of [['수취인',100,0,'in'],['보낸분',0,100,'out']] as const){
  const rows=[['거래일자','입금','출금','거래내용',header],['2026-09-01',income,expense,'급여','원본에 적힌 사람']];
  const detected=detect(rows),result=await parseRows(rows,detected.mapping,'account',[],[],[],{headerRow:0});
  assert.equal(result.parsed[0].direction,expectedDirection);
  assert.equal(sourceCounterparty(result.parsed[0]),`${header}: 원본에 적힌 사람`);
 }
 assert.equal(extractSourceDetails(['보낸분/받는분'],['상대방 예시'])?.counterparty,'상대방 예시');
 assert.equal(extractSourceDetails(['거래처명'],['거래처 예시'])?.counterparty,'거래처 예시');
 assert.equal(extractSourceDetails(['보낸분','받는분'],['같은 이름','같은 이름'])?.counterparty,'보낸분: 같은 이름 · 받는분: 같은 이름');
});

test('blank columns never erase existing metadata or its source and all strings are bounded',()=>{
 const previous={basic:'기존 기본내역',detail:'기존 설명',record:'은행 기록',memo:'기존 이체메모',provenance:{sheet:'이전 원본',row:5}};
 assert.deepEqual(mergeSourceDetails(previous,{basic:' ',memo:'',provenance:{sheet:'빈 새 원본',row:7}}),previous);
 assert.deepEqual(mergeSourceDetails(previous,{basic:'새 기본내역',detail:'',provenance:{sheet:'현재 원본',row:8}}),{...previous,basic:'새 기본내역',provenance:{sheet:'현재 원본',row:8}});
 const normalized=normalizeSourceDetails({basic:'x'.repeat(1100),memo:12,note:' ',unknown:'삭제',provenance:{sheet:'현재 원본',row:0}});
 assert.deepEqual(normalized,{basic:'x'.repeat(1000)});
 assert.equal(extractSourceDetails(['기본내역','이체메모'],['','']),null);
});

test('display entries use explicit labels and keep provenance separate',()=>{
 const transaction={source_details:{basic:'기본',detail:'상세',counterparty:'상대방',record:'기록',memo:'메모',note:'비고',provenance:{sheet:'원본',row:3,url:'https://docs.google.com/spreadsheets/d/example/edit'}}};
 assert.deepEqual(getSourceDetailEntries(transaction),[
  {label:'기본내역',value:'기본'},{label:'세부내역',value:'상세'},{label:'거래 상대방',value:'상대방'},
  {label:'거래기록사항',value:'기록'},{label:'이체메모',value:'메모'},{label:'비고',value:'비고'},
 ]);
 assert.deepEqual(getSourceDetailEntries({}),[]);
});

test('Google sheet ingestion adds exact sheet and row provenance without replacing the original description',async()=>{
 const wb=utils.book_new();
 utils.book_append_sheet(wb,utils.aoa_to_sheet([['거래일자','입금','출금','거래내용','기본내역','세부내역','거래기록사항','이체메모'],['2026-09-01',500,0,'급여','ICD수당8','8월 지급분','지원 기관 기록','송금 안내']]),'은행');
 const bytes=new Uint8Array(write(wb,{type:'array',bookType:'xlsx'}));
 const data={...emptyDataset,accounts:[{id:'account',business_id:'business',name:'통장',bank:'은행',masked_number:'1234',opening_balance:0,opening_balance_date:null}]};
 const url='https://docs.google.com/spreadsheets/d/example/edit';
 const result=await prepareSheetRows(bytes,data,[{sheet:'은행',account_id:'account',selected:true}],url);
 assert.equal(result.incoming[0].description,'급여');
 assert.deepEqual(result.incoming[0].source_details,{basic:'ICD수당8',detail:'8월 지급분',record:'지원 기관 기록',memo:'송금 안내',provenance:{sheet:'은행',row:2,url}});
});
