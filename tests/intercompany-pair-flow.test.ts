import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {IntercompanyPairFlow} from '../components/finance/intercompany-pair-flow';
import {buildIntercompanyRegister,type IntercompanyBaseline,type IntercompanyEntry,type IntercompanyPair} from '../lib/finance/intercompany-register';

const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002';
const baseline=(sent=4000,received=1000):IntercompanyBaseline=>({
 source_url:'https://docs.google.com/spreadsheets/d/synthetic-document/edit?gid=1',gid:'1',mirror_gid:'2',mirror_sheet_name:'Synthetic register',as_of:'2020-10-10',coverage_start:null,opening_balance_known:false,totals_include_additions:true,notes:[],
 businesses:[{key:'z',name:'합성법인A',business_id:a},{key:'a',name:'합성법인B',business_id:b},{key:'external',name:'합성 외부사업자',business_id:null}],
 pairs:[{business_a:'z',business_b:'a',a_to_b:sent,b_to_a:received,note:''}],additions:[],
});
const entry=(extra:Partial<IntercompanyEntry>={}):IntercompanyEntry=>({id:'20000000-0000-4000-8000-000000000001',from_party:'z',to_party:'a',entry_date:'2020-10-11',amount:250,kind:'loan',memo:'정상 등록 메모',version:1,voided:false,sheet_row:2,created_at:'2020-10-11T01:00:00Z',updated_at:'2020-10-11T01:00:00Z',sheet_status:'synced',sheet_synced_at:'2020-10-11T01:01:00Z',sheet_error:'',...extra});
const render=(pair:IntercompanyPair,sourceAdditions:IntercompanyBaseline['additions']=[])=>renderToStaticMarkup(createElement(IntercompanyPairFlow,{pair,sourceAdditions}));
const visibleWords=(html:string)=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();

test('키 정렬로 순서가 바뀌어도 각 송금 방향과 금액·받을 차액을 실명으로 보여준다',()=>{
 const model=buildIntercompanyRegister({baseline:baseline(),entries:[]},[]),pair=model.pairs[0],before=JSON.stringify(pair),text=visibleWords(render(pair));
 assert.equal(pair.businessA.key,'a');
 assert.match(text,/합성법인B → 합성법인A 1,000원 보냄/);
 assert.match(text,/합성법인A → 합성법인B 4,000원 보냄/);
 assert.match(text,/합성법인A가 합성법인B에서 받을 차액 3,000원/);
 assert.match(text,/4,000원 − 1,000원 = 3,000원/);
 assert.equal(JSON.stringify(pair),before);
});

test('반대 방향 차액도 모델의 채권자와 채무자를 따라 표시한다',()=>{
 const pair=buildIntercompanyRegister({baseline:baseline(1000,4000),entries:[]},[]).pairs[0],text=visibleWords(render(pair));
 assert.match(text,/합성법인A → 합성법인B 1,000원 보냄/);
 assert.match(text,/합성법인B → 합성법인A 4,000원 보냄/);
 assert.match(text,/합성법인B가 합성법인A에서 받을 차액 3,000원/);
 assert.doesNotMatch(text,/합성법인A가 합성법인B에서 받을 차액/);
});

test('같은 누계는 0원 차액으로 표현하고 전액 상환으로 단정하지 않는다',()=>{
 const pair=buildIntercompanyRegister({baseline:baseline(1500,1500),entries:[]},[]).pairs[0],text=visibleWords(render(pair));
 assert.match(text,/양쪽이 보낸 누계가 같습니다\./);
 assert.match(text,/1,500원 − 1,500원 = 0원/);
 assert.doesNotMatch(text,/상환 완료|전액 상환|채권자 확인 필요/);
});

test('근거는 해당 쌍만 보여주며 원본 추가기재를 재합산하지 않고 취소 등록을 제외한다',()=>{
 const source=baseline();source.pairs[0].note='<script>원본 메모</script>';
 source.additions=[{id:'source-match',date:'2020-10-01',from_business:'z',to_business:'a',amount:999,kind:'repayment',memo:'이미 누계에 포함된 원본'},
  {id:'source-other',date:'2020-10-02',from_business:'z',to_business:'external',amount:777,kind:'loan',memo:'다른 쌍의 원본'}];
 const pair=buildIntercompanyRegister({baseline:source,entries:[entry()]},[]).pairs[0];
 pair.manualEntries.push(entry({id:'20000000-0000-4000-8000-000000000002',amount:888,voided:true,memo:'취소된 등록 메모'}));
 const before=JSON.stringify({pair,source}),html=render(pair,source.additions),text=visibleWords(html);
 assert.match(text,/합성법인A → 합성법인B 4,250원 보냄/);
 assert.match(text,/4,250원 − 1,000원 = 3,250원/);
 assert.match(text,/원본 기재 자금이동/);assert.match(text,/위 보낸 누계에 반영된 기록입니다/);
 assert.match(text,/등록 · 대여금 지급/);assert.match(text,/정상 등록 메모/);
 assert.doesNotMatch(text,/다른 쌍의 원본|취소된 등록 메모/);
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
 assert.equal(JSON.stringify({pair,source}),before);
});

test('개별 기록이 없는 외부 상대방도 양방향 누계와 받을 금액을 보존한다',()=>{
 const source=baseline();source.pairs=[{business_a:'z',business_b:'external',a_to_b:2000,b_to_a:0,note:'합성 외부 대여'}];
 const pair=buildIntercompanyRegister({baseline:source,entries:[]},[]).pairs[0],text=visibleWords(render(pair));
 assert.match(text,/합성법인A → 합성 외부사업자 2,000원 보냄/);
 assert.match(text,/합성 외부사업자 → 합성법인A 0원 보냄/);
 assert.match(text,/합성법인A가 합성 외부사업자에서 받을 차액 2,000원/);
 assert.match(text,/이 쌍은 누계 자료만 저장되어 있습니다\. 개별 기재 내역이 없습니다\./);
});
