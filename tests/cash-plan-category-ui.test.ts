import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {saveCashPlanActualCategory} from '../components/finance/cash-plan-actual-category-dialog';
import {CategoryPicker} from '../components/finance/category-picker';
import {FinancialVisibilityContext} from '../components/finance/financial-visibility';
import {financialDisplayValue,redactFinancialText} from '../lib/finance/financial-visibility';

test('실제 과목 저장과 공유 자료 조회는 순서대로 수행하고 조회 실패 재시도는 POST를 반복하지 않는다',async()=>{
 const savedRef:{current:string|null}={current:null},busyRef={current:false},bodies:unknown[]=[],events:string[]=[];
 let failRefresh=true;
 const options={transactionId:'synthetic-saved-ledger',categoryId:'synthetic-category',savedRef,busyRef,post:async(body:unknown)=>{bodies.push(body);events.push('post');},refresh:async()=>{events.push('refresh');if(failRefresh)throw Error('synthetic refresh failure');},onSaved:(id:string)=>{assert.equal(id,'synthetic-category');events.push('saved');}};
 await assert.rejects(saveCashPlanActualCategory(options),/synthetic refresh failure/);
 assert.equal(savedRef.current,'synthetic-category');assert.equal(busyRef.current,false);
 assert.deepEqual(bodies,[{ids:['synthetic-saved-ledger'],category_id:'synthetic-category'}]);
 failRefresh=false;
 assert.equal(await saveCashPlanActualCategory(options),true);
 assert.equal(bodies.length,1);assert.deepEqual(events,['post','saved','refresh','refresh']);
});

test('과목 쓰기 실패는 저장 완료로 간주하지 않으며 같은 선택값으로 재시도할 수 있다',async()=>{
 const savedRef:{current:string|null}={current:null},busyRef={current:false};
 let requests=0,refreshes=0;
 const options={transactionId:'synthetic-saved-ledger',categoryId:'synthetic-category',savedRef,busyRef,post:async()=>{requests++;if(requests===1)throw Error('synthetic write failure');},refresh:async()=>{refreshes++;},onSaved:()=>{}};
 await assert.rejects(saveCashPlanActualCategory(options),/synthetic write failure/);
 assert.equal(savedRef.current,null);assert.equal(busyRef.current,false);assert.equal(refreshes,0);
 assert.equal(await saveCashPlanActualCategory(options),true);
 assert.equal(requests,2);assert.equal(refreshes,1);assert.equal(savedRef.current,'synthetic-category');
});

test('연속 저장 입력은 첫 요청이 끝날 때까지 같은 실제 거래를 다시 쓰지 않는다',async()=>{
 const savedRef:{current:string|null}={current:null},busyRef={current:false};
 let release:()=>void=()=>{},requests=0,refreshes=0;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const options={transactionId:'synthetic-saved-ledger',categoryId:'synthetic-category',savedRef,busyRef,post:async()=>{requests++;await gate;},refresh:async()=>{refreshes++;},onSaved:()=>{}};
 const first=saveCashPlanActualCategory(options);
 assert.equal(await saveCashPlanActualCategory(options),false);
 assert.equal(requests,1);assert.equal(busyRef.current,true);
 release();assert.equal(await first,true);assert.equal(refreshes,1);assert.equal(busyRef.current,false);
});

test('계정과목 검색 선택기는 기존 금액 숨김과 저장 중 비활성화를 유지한다',()=>{
 const category={id:'synthetic-category',name:'합성 과목 43,210원',group_name:'영업지출',is_internal:false,is_operating:true};
 const context={amountsVisible:false,preferenceReady:true,toggleAmountsVisible:()=>{},privateValue:(value:string|number)=>financialDisplayValue(value,false),privateText:(value:string)=>redactFinancialText(value)};
 const html=renderToStaticMarkup(createElement(FinancialVisibilityContext.Provider,{value:context},createElement(CategoryPicker,{label:'계획 계정과목',value:category.id,categories:[category],aliases:[],onChange:()=>{},disabled:true})));
 assert.match(html,/role="combobox"/);assert.match(html,/aria-label="계획 계정과목"/);assert.match(html,/disabled=""/);
 assert.match(html,/합성 과목/);assert.doesNotMatch(html,/43,210|43210/);
 const inherited=renderToStaticMarkup(createElement(CategoryPicker,{label:'계획 계정과목',value:'all',allLabel:'원본 과목 유지 · 합성 과목',categories:[category],onChange:()=>{}}));
 assert.match(inherited,/원본 과목 유지 · 합성 과목/);
});
