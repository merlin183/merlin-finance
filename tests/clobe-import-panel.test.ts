import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyDataset,type Dataset,type Category} from '../lib/finance/types';
import type {ClobeAccountsResponse} from '../lib/clobe/types';
import {chosenClobeCategory,clobeImportAccountOptions,clobeImportBankKey,clobeImportBanks,clobeImportLinkError,clobeImportNeedsCategoryReview,clobeImportSearchMatches,restoreClobeImportLinks,setSelectedClobeCategories} from '../components/finance/clobe-import-model';
import {clobeManualImportSyncBlocked} from '../components/finance/clobe-import-ui';

const accounts:ClobeAccountsResponse={fetchedAt:'2026-10-07T03:00:00Z',companies:[{id:'synthetic-company',name:'합성사업자',role:'MASTER',error:null,scraping:{status:'SUCCESS',lastCollectedAt:'2026-10-07T11:00:00',error:null},accounts:[{id:1,name:'같은 이름 운영통장',bankName:'합성은행',maskedNumber:'•••• 0001',currency:'KRW',balance:1000,krwBalance:1000,isHidden:false},{id:2,name:'외화통장',bankName:null,maskedNumber:'•••• 0002',currency:'USD',balance:10,krwBalance:null,isHidden:false}]}]};
const data:Dataset={...emptyDataset,businesses:[{id:'b1',name:'합성사업자',kind:'법인',representative:'합성대표',reserve:0,color:'#123456'}],accounts:[{id:'a1',business_id:'b1',name:'같은 이름 운영통장',bank:'합성은행',masked_number:'•••• 0001',opening_balance:0,opening_balance_date:null},{id:'a2',business_id:'b1',name:'두번째 통장',bank:'합성은행',masked_number:'•••• 0002',opening_balance:0,opening_balance_date:null}]};
const categories:Category[]=[{id:'fee',name:'지급수수료',group_name:'영업지출',is_operating:true,is_internal:false},{id:'pay',name:'급여',group_name:'영업지출',is_operating:true,is_internal:false}];

test('전체 동기화의 조회·저장·잔액·갱신 동안 개별 미리보기와 적용을 막는다',()=>{
 for(const phase of ['preparing','applying','balances','refreshing'] as const)assert.equal(clobeManualImportSyncBlocked(phase),true,phase);
 assert.equal(clobeManualImportSyncBlocked('idle'),false);
 assert.equal(clobeManualImportSyncBlocked('done'),false);
});

test('전체 저장 후 화면 재조회 실패가 남아 있으면 개별 가져오기 저장도 잠근다',()=>{
 assert.equal(clobeManualImportSyncBlocked('refresh-needed'),true);
 assert.equal(clobeManualImportSyncBlocked('done'),false);
});

test('공통 provider가 없는 이전 사용 경로도 잠금 판단 시 오류 없이 유지한다',()=>{
 assert.equal(clobeManualImportSyncBlocked(undefined),false);
});

test('가져오기에는 원화 계좌만 제공하고 같은 이름·번호라도 미확인 멀린 계좌를 자동 연결하지 않는다',()=>{
 const banks=clobeImportBanks(accounts);assert.equal(banks.length,1);assert.equal(banks[0].external_account_id,'1');
 assert.deepEqual(restoreClobeImportLinks(banks,[],data),[{company_id:'synthetic-company',external_account_id:'1',account_id:null,selected:false}]);
 assert.equal(clobeImportBankKey({company_id:'a:b',external_account_id:'c'})===clobeImportBankKey({company_id:'a',external_account_id:'b:c'}),false);
});

test('사용자가 과거에 확정한 연결만 복원하고 삭제된 저장 계좌는 선택하지 않는다',()=>{
 const banks=clobeImportBanks(accounts);
 const confirmed=restoreClobeImportLinks(banks,[{company_id:'synthetic-company',external_account_id:'1',account_id:'a1'}],data);
 assert.equal(confirmed[0].selected,true);assert.equal(confirmed[0].account_id,'a1');
 const removed=restoreClobeImportLinks(banks,[{company_id:'synthetic-company',external_account_id:'1',account_id:'removed'}],data);
 assert.equal(removed[0].selected,false);assert.equal(removed[0].account_id,null);
});

test('통장 선택 누락·저장 계좌 누락·동일 멀린 계좌의 중복 연결은 조회 전에 막는다',()=>{
 const first={company_id:'synthetic-company',external_account_id:'1',account_id:'a1',selected:true};
 assert.match(clobeImportLinkError([],data),/통장을 선택/);
 assert.match(clobeImportLinkError([{...first,account_id:null}],data),/모든 통장/);
 assert.match(clobeImportLinkError([{...first,account_id:'deleted'}],data),/모든 통장/);
 assert.match(clobeImportLinkError([first,{...first,external_account_id:'3'}],data),/여러 Clobe 통장/);
 assert.equal(clobeImportLinkError([first,{...first,external_account_id:'3',account_id:'a2'}],data),'');
 assert.equal(clobeImportLinkError([first,{...first,external_account_id:'3',selected:false,account_id:null}],data),'');
});

test('저장 계좌 목록은 사업자·은행·통장·마스킹 번호를 함께 표시한다',()=>{
 const options=clobeImportAccountOptions(data);
 assert.equal(options[0].value,'none');assert.equal(options[1].label,'합성사업자 · 합성은행 · 같은 이름 운영통장 · •••• 0001');
});

test('일괄 분류는 명시적으로 선택한 신규행만 바꾸고 기존 분류와 선택하지 않은 행을 보존한다',()=>{
 const rows=[{key:'new-a',category_id:null},{key:'new-b',category_id:'pay'}],selected=new Set(['new-a','existing-row','foreign-row']);
 const choices={'new-b':'pay','existing-row':'pay'};
 const changed=setSelectedClobeCategories(rows,selected,choices,'fee',categories);
 assert.deepEqual(changed,{'new-a':'fee','new-b':'pay','existing-row':'pay'});
 assert.deepEqual(choices,{'new-b':'pay','existing-row':'pay'});
 assert.equal(chosenClobeCategory(rows[0],changed),'fee');assert.equal(chosenClobeCategory(rows[1],{}),'pay');
 assert.equal(chosenClobeCategory(rows[1],{'new-b':null}),null);
 assert.deepEqual(setSelectedClobeCategories(rows,selected,choices,'unknown-category',categories),choices);
});

test('미리보기 검색은 사업자·원본 거래처·적요의 공백과 영문 대소문자를 정규화한다',()=>{
 assert.equal(clobeImportSearchMatches(['합성 사업자','Example Fee',null],'합성사업자'),true);
 assert.equal(clobeImportSearchMatches(['합성 사업자','Example Fee'],'ＥＸＡＭＰＬＥ'),true);
 assert.equal(clobeImportSearchMatches(['합성 사업자','Example Fee'],'급여'),false);
 assert.equal(clobeImportSearchMatches([null],'  '),true);
});

test('신규행의 미매핑·입금·출금 placeholder ID와 null·미등록 ID는 모두 분류 확인이 필요하다',()=>{
 const options=[...categories,...['미매핑','입금','출금'].map((name,index)=>({id:`placeholder-${index}`,name,group_name:'정리필요',is_operating:false,is_internal:false}))];
 for(const category_id of [null,'deleted','placeholder-0','placeholder-1','placeholder-2']){
  assert.equal(clobeImportNeedsCategoryReview({key:'new-row',category_id},{},options),true,String(category_id));
 }
 assert.equal(clobeImportNeedsCategoryReview({key:'new-row',category_id:'fee'},{},options),false);
});

test('선택한 실제 과목으로 분류하면 확인 필요가 해제되고 과거완료도 정상 완료로 인정한다',()=>{
 const options=[...categories,{id:'unmapped',name:'미매핑',group_name:'정리필요',is_operating:false,is_internal:false},{id:'history',name:'과거완료',group_name:'정리필요',is_operating:false,is_internal:false}];
 const row={key:'new-row',category_id:'unmapped'};
 assert.equal(clobeImportNeedsCategoryReview(row,{'new-row':'fee'},options),false);
 assert.equal(clobeImportNeedsCategoryReview(row,{'new-row':'history'},options),false);
 assert.equal(clobeImportNeedsCategoryReview({key:'new-row',category_id:'pay'},{'new-row':'unmapped'},options),true);
 assert.equal(clobeImportNeedsCategoryReview({key:'new-row',category_id:'pay'},{'new-row':null},options),true);
});
