import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,createRef} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PaymentConfirmationFields,PaymentConfirmationModePicker} from '../components/finance/payment-confirmation-fields';
import type {PaymentConfirmationMode} from '../components/finance/payment-confirmation-draft';

const fieldProps={draft:{amount:'9598655',date:'2027-04-20',complete:true,memo:'청구서 확인'},pending:false,month:{from:'2027-04-01',to:'2027-04-30'},lastActualDate:'2027-04-12',suggestedDate:true,dateInput:createRef<HTMLInputElement>(),onChange:()=>{}};
const fields=(mode:PaymentConfirmationMode,pending=false)=>renderToStaticMarkup(createElement(PaymentConfirmationFields,{...fieldProps,mode,pending}));

test('예정 수정은 미래 날짜와 월 전체 금액을 보여주고 실제 완료 체크박스를 숨긴다',()=>{
 const html=fields('planned');
 assert.match(html,/예정 출금일/);assert.match(html,/예정 출금액 \(원\)/);assert.match(html,/계획 메모/);
 assert.match(html,/min="2027-04-01" max="2027-04-30"/);assert.match(html,/value="2027-04-20"/);assert.match(html,/value="9598655"/);
 assert.doesNotMatch(html,/type="checkbox"|지출을 모두 완료|확인한 누적 출금액/);
});

test('실제 확인은 지난 날짜 한도·누적 금액·명시적 완료 확인을 유지한다',()=>{
 const html=fields('actual');
 assert.match(html,/실제 출금일/);assert.match(html,/확인한 누적 출금액 \(원\)/);assert.match(html,/확인 메모/);
 assert.match(html,/max="2027-04-12"/);assert.match(html,/type="checkbox" checked=""/);
 assert.match(html,/지출을 모두 완료했습니다/);assert.match(html,/계획일 자동 입력 · 수정 가능/);
});

test('두 모드는 명시적 라디오 선택으로 구분하고 저장 중에는 선택과 입력을 잠근다',()=>{
 const picker=renderToStaticMarkup(createElement(PaymentConfirmationModePicker,{mode:'planned',pending:false,onChange:()=>{}}));
 assert.match(picker,/수정할 내용 선택/);assert.equal((picker.match(/type="radio"/g)||[]).length,2);
 assert.match(picker,/<input(?=[^>]*value="planned")(?=[^>]*checked="")[^>]*>/);assert.match(picker,/예정 금액 수정/);assert.match(picker,/실제 출금 확인/);
 const busy=renderToStaticMarkup(createElement(PaymentConfirmationModePicker,{mode:'actual',pending:true,onChange:()=>{}}));
 assert.match(busy,/<fieldset[^>]*disabled=""/);assert.match(busy,/<input(?=[^>]*value="actual")(?=[^>]*checked="")[^>]*>/);
 const busyFields=fields('planned',true);
 assert.equal((busyFields.match(/disabled=""/g)||[]).length,3);
});
