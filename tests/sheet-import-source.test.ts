import test from 'node:test';
import assert from 'node:assert/strict';
import {utils,write} from '@e965/xlsx';
import {parseSheetImportSource,resolveSheetImportMappings} from '../lib/finance/sheet-import-source';
import {prepareSheetRows,type SheetMapping} from '../lib/finance/google-sheets';
import {emptyDataset} from '../lib/finance/types';

const id='synthetic_manual_import_sheet_12345';
const url=`https://docs.google.com/spreadsheets/d/${id}/edit`;
const account='11111111-1111-4111-8111-111111111111';
const otherAccount='22222222-2222-4222-8222-222222222222';
const mappings:SheetMapping[]=[{sheet:'가상 사업자 통장',account_id:account,selected:true}];
const raw=JSON.stringify({url:`${url}?gid=123&usp=sharing#gid=123`,mappings});

test('수동 가져오기 기본 링크는 gid와 공유 쿼리를 제거한 canonical 주소다',()=>{
 const source=parseSheetImportSource(raw);
 assert.equal(source?.url,url);
 assert.deepEqual(source?.mappings,mappings);
 assert.deepEqual(resolveSheetImportMappings(`${url}?gid=456#gid=456`,undefined,raw),mappings);
 assert.deepEqual(resolveSheetImportMappings(`https://docs.google.com/spreadsheets/d/${id}/view`,undefined,raw),mappings);
});

test('설정한 계좌 연결은 동일 문서에만 적용하고 다른 링크의 기존 제안 방식은 유지한다',()=>{
 const another='https://docs.google.com/spreadsheets/d/synthetic_other_import_sheet_67890/edit';
 assert.equal(resolveSheetImportMappings(another,undefined,raw),undefined);
 assert.equal(parseSheetImportSource(undefined),null);
 assert.equal(parseSheetImportSource('  '),null);
 assert.equal(resolveSheetImportMappings(url,undefined,undefined),undefined);
});

test('사용자가 검토한 계좌 선택과 빈 명시 목록은 서버 기본값보다 우선한다',()=>{
 const explicit:SheetMapping[]=[{sheet:mappings[0].sheet,account_id:otherAccount,selected:true}];
 assert.strictEqual(resolveSheetImportMappings(url,explicit,raw),explicit);
 const empty:SheetMapping[]=[];
 assert.strictEqual(resolveSheetImportMappings(url,empty,raw),empty);
 // A reviewed apply/preview choice does not depend on the default configuration.
 assert.strictEqual(resolveSheetImportMappings(url,explicit,'invalid JSON'),explicit);
});

test('잘못된 시트 설정은 원문이나 비밀값을 노출하지 않고 명확하게 실패한다',()=>{
 const secretMarker='do-not-expose-config-content';
 const invalid=[
  secretMarker,
  JSON.stringify({url,mappings:'wrong'}),
  JSON.stringify({url,mappings:[]}),
  JSON.stringify({url,mappings:[{...mappings[0],account_id:'not-a-uuid'}]}),
  JSON.stringify({url,mappings:[{...mappings[0],selected:true,account_id:null}]}),
  JSON.stringify({url,mappings:[{...mappings[0],selected:false}]}),
  JSON.stringify({url,mappings:[{...mappings[0],sheet:'  '}]}),
  JSON.stringify({url,mappings:[mappings[0],mappings[0]]}),
  JSON.stringify({url,mappings:Array.from({length:41},(_,index)=>({...mappings[0],sheet:`가상 통장 ${index}`}))}),
  JSON.stringify({url,mappings,unexpected:secretMarker}),
  JSON.stringify({url,mappings:[{...mappings[0],unexpected:secretMarker}]}),
  JSON.stringify({url:`https://example.com/spreadsheets/d/${id}/edit`,mappings}),
  JSON.stringify({url:`https://${secretMarker}@docs.google.com/spreadsheets/d/${id}/edit`,mappings}),
  JSON.stringify({url:`http://docs.google.com/spreadsheets/d/${id}/edit`,mappings}),
 ];
 for(const config of invalid){
  assert.throws(()=>parseSheetImportSource(config),error=>error instanceof Error&&error.message.includes('설정')&&!error.message.includes(secretMarker));
  assert.throws(()=>resolveSheetImportMappings(url,undefined,config));
 }
});

test('허용된 최대 40개 연결과 선택하지 않은 시트의 null 계좌를 읽는다',()=>{
 const forty=Array.from({length:40},(_,index)=>({sheet:`가상 통장 ${index}`,account_id:index===0?account:null,selected:index===0}));
 assert.deepEqual(parseSheetImportSource(JSON.stringify({url,mappings:forty}))?.mappings,forty);
});

test('설정값에서 가져온 계좌도 기존 데이터의 계좌 소유 범위 검사를 통과해야 한다',async()=>{
 const book=utils.book_new();
 utils.book_append_sheet(book,utils.aoa_to_sheet([
  ['거래일자','거래내용','입금금액(원)','출금금액(원)','거래 후 잔액(원)'],
  ['2026-09-01','가상 거래',0,1000,9000],
 ]),mappings[0].sheet);
 const bytes=new Uint8Array(write(book,{type:'array',bookType:'xlsx'}) as ArrayBuffer);
 const configured=resolveSheetImportMappings(url,undefined,raw);
 await assert.rejects(prepareSheetRows(bytes,structuredClone(emptyDataset),configured,url),/연결할 계좌를 확인/);
});
