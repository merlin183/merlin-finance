import test from 'node:test';
import assert from 'node:assert/strict';
import {initialPaymentConfirmationDraft,paymentConfirmationSourceGross,paymentConfirmationReturnPatch,initialPaymentConfirmationMode,initialPlannedPaymentDraft,paymentConfirmationDraftError,paymentConfirmationDraftValues,paymentConfirmationDraftsDirty,plannedPaymentDraftError,plannedPaymentDraftValues,updatePaymentConfirmationDraft,type PaymentConfirmationDraft,type PaymentConfirmationDrafts} from '../components/finance/payment-confirmation-draft';

const draft:PaymentConfirmationDraft={amount:'100,000',date:'2027-04-10',complete:false,memo:'확인 메모'};

test('계획일이 없는 새 출금 확인은 날짜를 빈칸으로 두고 완료 상태를 자동 선택하지 않는다',()=>{
 const fresh=initialPaymentConfirmationDraft({confirmation:null,recordedAmount:null,originalAmount:100000});
 assert.deepEqual(fresh,{amount:'100000',date:'',complete:false,memo:''});
 const bank=initialPaymentConfirmationDraft({confirmation:null,recordedAmount:80000,originalAmount:100000});
 assert.deepEqual(bank,{amount:'80000',date:'',complete:false,memo:''});
 assert.match(paymentConfirmationDraftError(fresh,'2027-04','2027-04-12'),/출금일/);
});

test('직접 확인 수정은 저장된 실제 일자·금액·완료·메모를 유지한다',()=>{
 const confirmation={amount:75000,date:'2027-04-05',complete:true,memo:'영수증 확인'};
 assert.deepEqual(initialPaymentConfirmationDraft({confirmation,recordedAmount:100000,originalAmount:150000,date:'2027-04-10'}),{amount:'75000',date:'2027-04-05',complete:true,memo:'영수증 확인'});
});

test('유효한 계획일을 먼저 제안하되 날짜 미정이나 잘못된 날짜에는 오늘 날짜를 만들지 않는다',()=>{
 const source={confirmation:null,recordedAmount:null,originalAmount:100000};
 const planned=initialPaymentConfirmationDraft({...source,date:'2027-04-05'});
 assert.deepEqual(planned,{amount:'100000',date:'2027-04-05',complete:false,memo:''});
 for(const date of [null,'','2027-02-30','not-a-date'])assert.equal(initialPaymentConfirmationDraft({...source,date}).date,'');
 const future=initialPaymentConfirmationDraft({...source,date:'2027-04-20'});
 assert.equal(future.date,'2027-04-20');assert.equal(future.complete,false);
 assert.match(paymentConfirmationDraftError(future,'2027-04','2027-04-12'),/지나지 않은 날짜/);
 assert.equal(paymentConfirmationDraftError({...future,date:'2027-04-10'},'2027-04','2027-04-12'),'');
});

test('양의 원 단위 금액과 같은 달의 지난 실제 날짜만 제출할 수 있다',()=>{
 assert.equal(paymentConfirmationDraftError(draft,'2027-04','2027-04-12'),'');
 assert.deepEqual(paymentConfirmationDraftValues({...draft,memo:' 확인 메모 '}),{amount:100000,date:'2027-04-10',complete:false,memo:'확인 메모'});
 for(const amount of ['0','-1','1.5','1e4','',String(Number.MAX_SAFE_INTEGER+1)])assert.match(paymentConfirmationDraftError({...draft,amount},'2027-04','2027-04-12'),/출금액/);
 for(const date of ['','2027-02-30','2027-03-31','2027-05-01'])assert.match(paymentConfirmationDraftError({...draft,date},'2027-04','2027-04-12'),/출금일/);
 assert.match(paymentConfirmationDraftError({...draft,date:'2027-04-13'},'2027-04','2027-04-12'),/지나지 않은 날짜/);
 assert.match(paymentConfirmationDraftError({...draft,memo:'가'.repeat(2001)},'2027-04','2027-04-12'),/2,000자/);
});

test('미래 계획은 예정 수정으로 시작하고 기존 실제 확인은 계획일보다 우선한다',()=>{
 assert.equal(initialPaymentConfirmationMode({confirmation:null,date:'2027-04-20'},'2027-04-12'),'planned');
 for(const date of [null,'','invalid','2027-02-30','2027-04-12','2027-04-10'])assert.equal(initialPaymentConfirmationMode({confirmation:null,date},'2027-04-12'),'actual');
 assert.equal(initialPaymentConfirmationMode({confirmation:{amount:75000,date:'2027-04-05',complete:true},date:'2027-04-20'},'2027-04-12'),'actual');
 const error=paymentConfirmationDraftError({...draft,date:'2027-04-20'},'2027-04','2027-04-12');
 assert.match(error,/지나지 않은 날짜/);assert.match(error,/예정 금액 수정/);
});

test('예정 수정 초기값은 편집된 월 계획 금액·날짜·사용자 메모를 그대로 사용한다',()=>{
 const initial=initialPlannedPaymentDraft({amount:9598655,date:'2027-04-20',memo:'[clobe-card-bill:synthetic-company:synthetic-key]\n대체 계획 키: ["synthetic-source"]\n청구서 확인'});
 assert.deepEqual(initial,{amount:'9598655',date:'2027-04-20',memo:'청구서 확인'});
 assert.equal(initialPlannedPaymentDraft({amount:0,date:null,memo:''}).date,'');
 assert.equal(initialPlannedPaymentDraft({amount:0,date:'2027-02-30',memo:''}).date,'');
});

test('예정 수정은 같은 달 미래일·0원·날짜 미정을 허용하고 실제 완료 정보를 제출하지 않는다',()=>{
 const planned={amount:'9,598,655',date:'2027-04-20',memo:' 청구서 확인 '};
 assert.equal(plannedPaymentDraftError(planned,'2027-04'),'');
 assert.deepEqual(plannedPaymentDraftValues(planned),{amount:9598655,date:'2027-04-20',memo:'청구서 확인'});
 assert.equal(plannedPaymentDraftError({...planned,amount:'0',date:''},'2027-04'),'');
 assert.deepEqual(plannedPaymentDraftValues({...planned,amount:'0',date:''}),{amount:0,date:null,memo:'청구서 확인'});
 for(const amount of ['-1','1.5','1e4','',String(Number.MAX_SAFE_INTEGER+1)])assert.match(plannedPaymentDraftError({...planned,amount},'2027-04'),/예정 출금액/);
 for(const date of ['2027-03-31','2027-05-01','2027-02-30','invalid'])assert.match(plannedPaymentDraftError({...planned,date},'2027-04'),/예정 출금일/);
 assert.match(plannedPaymentDraftError({...planned,memo:'가'.repeat(2001)},'2027-04'),/2,000자/);
 const hiddenActual={...planned,complete:true};
 assert.equal('complete' in plannedPaymentDraftValues(hiddenActual),false);
 assert.equal('confirmed_amount' in plannedPaymentDraftValues(hiddenActual),false);
});

test('모드를 오가도 각 입력을 보존하고 어느 쪽의 미저장 변경도 닫기 전에 감지한다',()=>{
 const original:PaymentConfirmationDrafts={planned:{amount:'100000',date:'2027-04-20',memo:'예정 메모'},actual:{...draft,complete:true}};
 assert.equal(paymentConfirmationDraftsDirty(original,original),false);
 const planned=updatePaymentConfirmationDraft(original,'planned',{amount:'9598655',memo:'새 청구서',complete:true});
 assert.equal(planned.actual,original.actual);assert.equal('complete' in planned.planned,false);
 assert.deepEqual(original.planned,{amount:'100000',date:'2027-04-20',memo:'예정 메모'});
 const actual=updatePaymentConfirmationDraft(planned,'actual',{date:'2027-04-10',amount:'80000',complete:false});
 assert.equal(actual.planned,planned.planned);assert.equal(actual.actual.amount,'80000');assert.equal(actual.actual.complete,false);
 assert.equal(paymentConfirmationDraftsDirty(original,actual),true);
 assert.equal(paymentConfirmationDraftsDirty(original,updatePaymentConfirmationDraft(original,'actual',{complete:false})),true);
});


test('반환은 명시적으로 선택해야 하며 저장된 작은 확인액을 자동으로 반환으로 해석하지 않는다',()=>{
 const old=initialPaymentConfirmationDraft({confirmation:{amount:90000,date:'2027-04-06',complete:true,memo:''},recordedAmount:240000,originalAmount:200000});
 assert.equal(old.returnEnabled,undefined);assert.equal(old.amount,'90000');
 const enabled={...old,...paymentConfirmationReturnPatch(old,true,240000,'2027-04-12')};
 assert.equal(enabled.amount,'240000');assert.equal(enabled.returnedAmount,'150000');assert.equal(enabled.returnedDate,'2027-04-06');
 assert.equal(paymentConfirmationDraftError(enabled,'2027-04','2027-04-12'),'');
 assert.deepEqual(paymentConfirmationDraftValues(enabled),{amount:240000,date:'2027-04-06',complete:true,memo:'',returnedAmount:150000,returnedDate:'2027-04-06'});
 const cleared={...enabled,...paymentConfirmationReturnPatch(enabled,false)};
 assert.equal('returnedAmount' in paymentConfirmationDraftValues(cleared),false);
 assert.equal(old.amount,'90000');
});

test('반환 입력은 원 출금 총액과 실제 같은 달의 입금일을 검증하고 전액 반환을 허용한다',()=>{
 const returned:PaymentConfirmationDraft={...draft,returnEnabled:true,returnedAmount:'100,000',returnedDate:'2027-04-11'};
 assert.equal(paymentConfirmationDraftError(returned,'2027-04','2027-04-12'),'');
 for(const amount of ['0','-1','1.5','1e4','',String(Number.MAX_SAFE_INTEGER+1)])assert.match(paymentConfirmationDraftError({...returned,returnedAmount:amount},'2027-04','2027-04-12'),/돌려받은 금액/);
 assert.match(paymentConfirmationDraftError({...returned,returnedAmount:'100001'},'2027-04','2027-04-12'),/누적 출금액을 넘을/);
 for(const date of ['', '2027-02-30','2027-03-31','2027-05-01'])assert.match(paymentConfirmationDraftError({...returned,returnedDate:date},'2027-04','2027-04-12'),/반환 입금일/);
 assert.match(paymentConfirmationDraftError({...returned,returnedDate:'2027-04-13'},'2027-04','2027-04-12'),/지나지 않은 날짜/);
 assert.equal(paymentConfirmationDraftError({...returned,returnEnabled:false,returnedAmount:'invalid',returnedDate:'invalid'},'2027-04','2027-04-12'),'');
});

test('반환 확인을 다시 열면 원 출금·반환·메모를 보존하고 모드 전환과 미저장 감지에 포함한다',()=>{
 const confirmation={amount:240000,date:'2027-04-06',complete:false,memo:'반환 근거',returnedAmount:50000,returnedDate:'2027-04-08'};
 const actual=initialPaymentConfirmationDraft({confirmation,recordedAmount:260000,originalAmount:300000});
 assert.deepEqual(actual,{amount:'240000',date:'2027-04-06',complete:false,memo:'반환 근거',returnEnabled:true,returnedAmount:'50000',returnedDate:'2027-04-08'});
 const original:PaymentConfirmationDrafts={actual,planned:{amount:'300000',date:'2027-04-20',memo:''}};
 assert.equal(paymentConfirmationDraftsDirty(original,original),false);
 for(const patch of [{returnEnabled:false},{returnedAmount:'60000'},{returnedDate:'2027-04-09'}])assert.equal(paymentConfirmationDraftsDirty(original,updatePaymentConfirmationDraft(original,'actual',patch)),true);
 const planned=updatePaymentConfirmationDraft(original,'planned',{returnedAmount:'99999',returnedDate:'2027-04-10',returnEnabled:true});
 assert.equal(planned.actual,actual);assert.equal('returnedAmount' in planned.planned,false);
 assert.equal('returnedAmount' in plannedPaymentDraftValues({...original.planned,...actual}),false);
});


test('출금 확인의 은행 근거는 수동 확인액을 제외한 같은 달 원본 출금을 중복 없이 합산한다',()=>{
 const source={businessId:'synthetic-source-business',month:'2027-04',asOf:'2027-04-12'};
 const actual={id:'synthetic-bank',business_id:source.businessId,txn_date:'2027-04-02',amount:45000,direction:'out'};
 const transactions=[actual,{...actual},{...actual,id:'synthetic-ledger',txn_date:'2027-04-10',amount:25000},
  {...actual,id:'incoming',direction:'in',amount:999999},{...actual,id:'other-business',business_id:'other'},
  {...actual,id:'old-month',txn_date:'2027-03-31'},{...actual,id:'future',txn_date:'2027-04-13'},
  {...actual,id:'bad-date',txn_date:'2027-04-31'},...[-1,0,Infinity,Number.MAX_SAFE_INTEGER+1].map((amount,index)=>({...actual,id:'bad-amount-'+index,amount}))];
 const fallback=[{date:'2027-04-10',amount:25000}];
 assert.equal(paymentConfirmationSourceGross({...source,recordedTransactions:transactions,recordedPaymentDates:fallback}),70000);
 assert.equal(paymentConfirmationSourceGross({...source,recordedTransactions:[],recordedPaymentDates:fallback}),0);
 assert.equal(paymentConfirmationSourceGross({...source,recordedPaymentDates:fallback}),25000);
});
