import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement,createRef} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {PaymentConfirmationFields,PaymentConfirmationModePicker} from '../components/finance/payment-confirmation-fields';
import {initialPaymentConfirmationDraft,updatePaymentConfirmationDraft,paymentConfirmationSourceGross,paymentConfirmationDraftValues,type PaymentConfirmationMode} from '../components/finance/payment-confirmation-draft';
import {cashPlanPaymentConfirmationNetAmount} from '../lib/finance/cash-plan-payment-confirmation';

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


test('반환 선택은 실제 확인에만 표시되고 원 출금·반환·순지출을 별도로 보여준다',()=>{
 const props={...fieldProps,mode:'actual' as const,draft:{...fieldProps.draft,amount:'731249',date:'2027-04-06',returnEnabled:true,returnedAmount:'183057',returnedDate:'2027-04-08'}};
 const html=renderToStaticMarkup(createElement(PaymentConfirmationFields,props));
 assert.match(html,/반환 입금 반영/);assert.match(html,/누적 출금액 \(반환 전\)/);assert.match(html,/돌려받은 금액 \(원\)/);assert.match(html,/반환 입금일/);
 assert.match(html,/id="payment-confirmation-returned-amount"[^>]*value="183057"/);assert.match(html,/id="payment-confirmation-returned-date"[^>]*max="2027-04-12"[^>]*value="2027-04-08"/);
 assert.match(html,/순지출/);assert.match(html,/548,192/);
 const planned=renderToStaticMarkup(createElement(PaymentConfirmationFields,{...props,mode:'planned'}));
 assert.doesNotMatch(planned,/반환 입금|returned-amount|순지출/);
 const busy=renderToStaticMarkup(createElement(PaymentConfirmationFields,{...props,pending:true}));
 assert.match(busy,/id="payment-confirmation-returned-amount"[^>]*disabled=""/);assert.match(busy,/id="payment-confirmation-returned-date"[^>]*disabled=""/);
});


test('기존 수동 총액보다 낮춘 확인은 실제 은행 근거로 미리보기와 저장 순지출이 일치한다',()=>{
 const sourceGross=paymentConfirmationSourceGross({businessId:'synthetic-source',month:'2027-04',asOf:'2027-04-12',recordedTransactions:[{id:'synthetic-bank',business_id:'synthetic-source',direction:'out',txn_date:'2027-04-06',amount:65000}]});
 const original=initialPaymentConfirmationDraft({confirmation:{amount:170000,date:'2027-04-06',complete:true,memo:''},recordedAmount:170000,originalAmount:200000});
 const changed=updatePaymentConfirmationDraft({actual:original,planned:{amount:'200000',date:'2027-04-15',memo:''}},'actual',{amount:'125000',returnEnabled:true,returnedAmount:'35000',returnedDate:'2027-04-08'}).actual;
 const html=renderToStaticMarkup(createElement(PaymentConfirmationFields,{...fieldProps,mode:'actual',draft:changed,recordedAmount:sourceGross}));
 assert.equal(cashPlanPaymentConfirmationNetAmount(sourceGross,paymentConfirmationDraftValues(changed)),90000);
 assert.match(html,/순지출 <strong>90,000원/);assert.doesNotMatch(html,/135,000/);
 assert.equal(original.amount,'170000');
});

test('좁은 기간에서 연 확인창도 같은 달 전체 실제 출금을 순지출 미리보기 기준으로 삼는다',()=>{
 const sourceGross=paymentConfirmationSourceGross({businessId:'synthetic-source',month:'2027-04',asOf:'2027-04-12',recordedTransactions:[{id:'before-range',business_id:'synthetic-source',direction:'out',txn_date:'2027-04-02',amount:45000},{id:'within-range',business_id:'synthetic-source',direction:'out',txn_date:'2027-04-10',amount:25000}],recordedPaymentDates:[{date:'2027-04-10',amount:25000}]});
 const html=renderToStaticMarkup(createElement(PaymentConfirmationFields,{...fieldProps,mode:'actual',draft:{amount:'30000',date:'2027-04-10',complete:false,memo:'',returnEnabled:true,returnedAmount:'10000',returnedDate:'2027-04-11'},recordedAmount:sourceGross}));
 assert.equal(sourceGross,70000);assert.match(html,/순지출 <strong>60,000원/);assert.doesNotMatch(html,/순지출 <strong>20,000원/);
});
