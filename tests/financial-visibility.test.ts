import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {FINANCIAL_MASK,FINANCIAL_VISIBILITY_KEY,createFinancialVisibilityStore,financialDisplayValue,redactFinancialText} from '../lib/finance/financial-visibility';
import {FinancialVisibilityContext,FinancialVisibilityProvider,FinancialVisibilityToggle,FinancialValue,FinancialText,FinancialInput,FinancialTextarea,FinancialChart} from '../components/finance/financial-visibility';

function memoryStorage(initial:string|null=null){
 let value=initial;
 return {getItem:(key:string)=>key===FINANCIAL_VISIBILITY_KEY?value:null,setItem:(key:string,next:string)=>{assert.equal(key,FINANCIAL_VISIBILITY_KEY);value=next;}};
}
function renderVisibility(visible:boolean,children:ReactNode){
 return renderToStaticMarkup(createElement(FinancialVisibilityContext.Provider,{value:{amountsVisible:visible,preferenceReady:true,toggleAmountsVisible:()=>{},privateValue:value=>financialDisplayValue(value,visible),privateText:text=>visible?text:redactFinancialText(text)}},children));
}

test('저장된 OFF·ON 모두 서버와 첫 수화 스냅샷은 숨김이며 읽기 전 토글은 무시한다',()=>{
 for(const preference of ['off','on',null]){
  const storage=memoryStorage(preference),store=createFinancialVisibilityStore(()=>storage);
  assert.deepEqual(store.getServerSnapshot(),{amountsVisible:false,preferenceReady:false});
  assert.deepEqual(store.getSnapshot(),{amountsVisible:false,preferenceReady:false});
  store.toggle();assert.equal(storage.getItem(FINANCIAL_VISIBILITY_KEY),preference);
  store.reload();
  assert.deepEqual(store.getSnapshot(),{amountsVisible:preference!=='off',preferenceReady:true});
  assert.deepEqual(store.getServerSnapshot(),{amountsVisible:false,preferenceReady:false});
 }
});

test('토글은 브라우저에 보존되며 새 provider·다른 탭 재조회에서도 동일 상태를 따른다',()=>{
 const storage=memoryStorage(),first=createFinancialVisibilityStore(()=>storage),second=createFinancialVisibilityStore(()=>storage);
 let updates=0;const unsubscribe=first.subscribe(()=>updates++);
 first.reload();assert.equal(first.getSnapshot().amountsVisible,true);
 first.toggle();assert.equal(first.getSnapshot().amountsVisible,false);
 assert.equal(storage.getItem(FINANCIAL_VISIBILITY_KEY),'off');
 second.reload();assert.equal(second.getSnapshot().amountsVisible,false);
 second.toggle();first.reload();assert.equal(first.getSnapshot().amountsVisible,true);
 assert.equal(updates,3);
 unsubscribe();first.toggle();assert.equal(updates,3);
});

test('잘못된 설정과 저장소 읽기 실패는 숨김을 유지하고 쓰기 실패에도 현재 세션 토글은 동작한다',()=>{
 for(const value of ['false','damaged','']){
  const store=createFinancialVisibilityStore(()=>memoryStorage(value));store.reload();assert.equal(store.getSnapshot().amountsVisible,false);
 }
 const inaccessible=createFinancialVisibilityStore(()=>{throw Error('Synthetic blocked storage');});
 inaccessible.reload();assert.deepEqual(inaccessible.getSnapshot(),{amountsVisible:false,preferenceReady:true});
 inaccessible.toggle();assert.equal(inaccessible.getSnapshot().amountsVisible,true);
 inaccessible.toggle();assert.equal(inaccessible.getSnapshot().amountsVisible,false);
});

test('숨김 문자열은 자릿수·부호·금액·비율과 무관하게 항상 동일하다',()=>{
 for(const amount of [0,-17,987654321,'9,876,543원','23.7%'])assert.equal(financialDisplayValue(amount,false),FINANCIAL_MASK);
 assert.equal(financialDisplayValue('9,876,543원',true),'9,876,543원');
 const text='2026-11-06 지급 3건 · 임차료 1,234,567원 · 수수료 500원 · 비율 12.5% · $25.50';
 assert.equal(redactFinancialText(text),`2026-11-06 지급 3건 · 임차료 ${FINANCIAL_MASK} · 수수료 ${FINANCIAL_MASK} · 비율 ${FINANCIAL_MASK} · ${FINANCIAL_MASK}`);
 assert.equal(redactFinancialText('2026년 11월 6일 · 2회차 · 급여 외 12건'),'2026년 11월 6일 · 2회차 · 급여 외 12건');
 assert.equal(redactFinancialText('보증금 3억원 · 월세 ₩1,000,000 · 정산 -2,000'),`보증금 ${FINANCIAL_MASK} · 월세 ${FINANCIAL_MASK} · 정산 ${FINANCIAL_MASK}`);
 assert.equal(redactFinancialText('2026-11-06 12:00 · 계좌번호 123-4567-890123 · 통장 12345678 · 끝자리 123'),`2026-11-06 12:00 · 계좌번호 ${FINANCIAL_MASK} · 통장 ${FINANCIAL_MASK} · 끝자리 123`);
 assert.equal(redactFinancialText('원천세 8642197 / 광고비 500만 / 보증금 3억 / 수수료 5천'),`원천세 ${FINANCIAL_MASK} / 광고비 ${FINANCIAL_MASK} / 보증금 ${FINANCIAL_MASK} / 수수료 ${FINANCIAL_MASK}`);
 assert.equal(redactFinancialText('조회 2026-11-06 / 2026년 / 3건 / 1,000건 / 2026-11-01~2026-11-30'),'조회 2026-11-06 / 2026년 / 3건 / 1,000건 / 2026-11-01~2026-11-30');
 assert.equal(redactFinancialText('시각 2026-11-06T12:34:56+09:00 / 기간 2026.11.01 ~ 2026/11/30'),'시각 2026-11-06T12:34:56+09:00 / 기간 2026.11.01 ~ 2026/11/30');
});

test('숨김 상태에서도 명시된 미설정·확인 상태는 유지하고 0과 알 수 없는 문자열은 마스킹한다',()=>{
 for(const value of ['확인 필요','잔액 확인 필요','등록 전','미설정','미지정','제외','없음','대상 없음','미연결','—','-','']){
  assert.equal(financialDisplayValue(value,false),value);
  assert.equal(renderVisibility(false,createElement(FinancialValue,{value})),value);
 }
 for(const value of [0,'0','0원','1234567890','알 수 없는 500원','확인 필요 500원']){
  assert.equal(financialDisplayValue(value,false),FINANCIAL_MASK);
  assert.match(renderVisibility(false,createElement(FinancialValue,{value})),/data-financial-masked="true"/);
 }
 const status=renderVisibility(false,createElement(FinancialValue,{value:'확인 필요',title:'8642197원','aria-valuenow':8642197,'aria-label':'8642197원'}));
 assert.doesNotMatch(status,/8642197/);assert.match(status,/확인 필요/);
});

test('여러 구분자와 한 자리 끝번호가 있는 합성 계좌 전체를 숨기고 날짜·다음 건수는 보존한다',()=>{
 assert.equal(redactFinancialText('합성은행 123-456789-12-34-5 이체 예정'),`합성은행 ${FINANCIAL_MASK} 이체 예정`);
 assert.equal(redactFinancialText('합성은행 1-234567-8-90-12-3 이체 예정'),`합성은행 ${FINANCIAL_MASK} 이체 예정`);
 assert.equal(redactFinancialText('합성은행 123456789012345678 이체 예정'),`합성은행 ${FINANCIAL_MASK} 이체 예정`);
 assert.equal(redactFinancialText('합성은행 123-4567-890123 이체 예정'),`합성은행 ${FINANCIAL_MASK} 이체 예정`);
 for(const text of ['2026-11-06 1000건','2026-11-06 12:00 1000건','2026.11.06 1,000건','2026/11/06 2026년 3건','2026-11-01~2026-11-30','2026-11-06T12:34:56+09:00'])assert.equal(redactFinancialText(text),text);
 assert.equal(redactFinancialText('2026-11-06 1000건 · 합성은행 123-456789-12-34-5 이체 예정'),`2026-11-06 1000건 · 합성은행 ${FINANCIAL_MASK} 이체 예정`);
});

test('실제 provider SSR에는 원금·비율·차트·입력값을 출력하지 않는다',()=>{
 const child=createElement('section',null,
  createElement(FinancialVisibilityToggle),
  createElement(FinancialValue,{value:'987,654,321원',title:'987654321',className:'negative','aria-label':'987654321'}),
  createElement(FinancialText,{value:'2026-11-06 · 정산 9,876원 · 3건'}),
  createElement(FinancialInput,{type:'number',value:987654321,min:123456,max:999999999,step:54321,title:'987654321',placeholder:'987654321','aria-label':'987654321','aria-valuenow':987654321,onChange:()=>{}}),
  createElement(FinancialTextarea,{value:'정산 메모 987654321',title:'정산 987654321',onChange:()=>{}}),
  createElement(FinancialChart,null,createElement('svg',{'aria-label':'987654321'},createElement('text',null,'987654321'))),
 );
 const html=renderToStaticMarkup(createElement(FinancialVisibilityProvider,null,child));
 assert.doesNotMatch(html,/987.?654.?321|9,876|123456|999999999|54321|<svg[^>]*aria-label="987/);
 assert.match(html,/aria-checked="false"/);assert.match(html,/disabled=""/);
 assert.match(html,/2026-11-06 · 정산 •••••• · 3건/);
 assert.match(html,/readOnly=""/);assert.match(html,/value="••••••"/);
 assert.match(html,/financial-value-masked negative/);assert.match(html,/금액 숨김 중/);
});

test('명시된 ON은 원문과 입력 속성을 보존하고 OFF는 원본 form state를 바꾸지 않는다',()=>{
 const onChange=()=>{},props=Object.freeze({value:7654321,type:'number',name:'amount',min:10,title:'7,654,321원',onChange});
 const shown=renderVisibility(true,createElement(FinancialInput,props));
 assert.match(shown,/value="7654321"/);assert.match(shown,/type="number"/);assert.match(shown,/name="amount"/);assert.match(shown,/min="10"/);
 const hidden=renderVisibility(false,createElement(FinancialInput,props));
 assert.doesNotMatch(hidden,/7654321|7,654,321|name="amount"|type="number"|min="10"/);
 assert.equal(props.value,7654321);assert.equal(props.onChange,onChange);
 assert.match(renderVisibility(true,createElement(FinancialValue,{value:'7,654,321원'})),/7,654,321원/);
 assert.match(renderVisibility(false,createElement(FinancialText,{value:'수수료 1,234원',title:'수수료 1,234원','aria-label':'수수료 1,234원'})),/title="수수료 ••••••"/);
 assert.match(renderToStaticMarkup(createElement(FinancialValue,{value:'7,654,321원'})),/7,654,321원/);
 assert.equal(renderVisibility(true,createElement('strong',null,createElement(FinancialValue,{value:'7,654,321원'}))),'<strong>7,654,321원</strong>');
 assert.equal(renderVisibility(true,createElement(FinancialText,{value:'수수료 1,234원'})),'수수료 1,234원');
 assert.equal(renderVisibility(false,createElement(FinancialText,{value:'2026-11-06 · 3건'})),'2026-11-06 · 3건');
});
