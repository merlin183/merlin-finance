import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import type {Category,Transaction} from '../lib/finance/types';
import {transferFeeExpected,transferFeeRequest,sameTransferFeeVersion} from '../components/finance/transaction-transfer-fee-model';
import {TransferFeeBreakdown} from '../components/finance/transaction-transfer-fee-display';

const categories:Category[]=[
 {id:'synthetic-transfer',name:'합성 내부이동',group_name:'내부',is_internal:true,is_operating:false},
 {id:'synthetic-fee',name:'합성 수수료',group_name:'경비',is_internal:false,is_operating:true},
 {id:'synthetic-review',name:'미매핑',group_name:'확인',is_internal:false,is_operating:false},
];
const row=(extra:Partial<Transaction>={}):Transaction=>({id:'synthetic-row',business_id:'synthetic-business',account_id:'synthetic-account',upload_id:null,txn_date:'2031-05-09',txn_time:'09:41:12',amount:10275,direction:'out',description:'합성 자금 이동',raw_gwamok:'원본 값',category_id:null,is_internal:false,balance:87000,tax_invoice:false,dedup_hash:'synthetic-hash',manually_classified:false,...extra});
const fields={transferCategoryId:'synthetic-transfer',feeCategoryId:'synthetic-fee',feeAmount:'275'};

test('분리 요청은 통장 원본 값과 비교할 버전을 전송하고 별도 거래·원본 변경·규칙을 요청하지 않는다',()=>{
 const transaction=row(),before=JSON.stringify(transaction),request=transferFeeRequest(transaction,categories,fields);
 assert.deepEqual(request,{transaction_id:transaction.id,transfer_category_id:'synthetic-transfer',fee_category_id:'synthetic-fee',fee_amount:275,expected:{amount:10275,category_id:null,manually_classified:false,transfer_fee_amount:0,transfer_fee_category_id:null}});
 assert.equal(JSON.stringify(transaction),before);
 assert.equal('transactions' in request,false);assert.equal('rules' in request,false);assert.equal('amount' in request,false);
 assert.deepEqual(transferFeeRequest(transaction,categories,fields),request,'응답이 불명확한 요청을 재시도해도 같은 버전과 분류 내용으로 전송한다');
});

test('이전 저장 수수료와 수동 분류 변경은 충돌로 취급하고 기존 무수수료 자료는 기본값을 사용한다',()=>{
 const transaction=row(),same=row({transfer_fee_amount:0,transfer_fee_category_id:null});
 assert.equal(sameTransferFeeVersion(transaction,same),true);
 for(const changed of [row({amount:10276}),row({category_id:'synthetic-transfer'}),row({manually_classified:true}),row({transfer_fee_amount:275,transfer_fee_category_id:'synthetic-fee'}),row({direction:'in'})])assert.equal(sameTransferFeeVersion(transaction,changed),false);
 const allocated=row({category_id:'synthetic-transfer',is_internal:true,manually_classified:true,transfer_fee_amount:275,transfer_fee_category_id:'synthetic-fee'});
 assert.equal(transferFeeExpected(allocated).transfer_fee_amount,275);
 assert.equal(transferFeeExpected(allocated).transfer_fee_category_id,'synthetic-fee');
});

test('수수료 입력은 음수·소수·출금액 이상·비정상 금액과 잘못된 과목을 거부한다',()=>{
 for(const feeAmount of ['','-1','0.5','1e2','10,000','10275','10276','NaN','999999999999999999999'])assert.throws(()=>transferFeeRequest(row(),categories,{...fields,feeAmount}));
 assert.throws(()=>transferFeeRequest(row({direction:'in'}),categories,fields));
 assert.throws(()=>transferFeeRequest(row({amount:0}),categories,fields));
 assert.throws(()=>transferFeeRequest(row(),categories,{...fields,transferCategoryId:'synthetic-fee'}));
 for(const feeCategoryId of ['','synthetic-transfer','synthetic-review'])assert.throws(()=>transferFeeRequest(row(),categories,{...fields,feeCategoryId}));
});

test('기존 분리를 해제할 때에는 수수료 금액과 수수료 과목을 함께 제거한다',()=>{
 const request=transferFeeRequest(row({transfer_fee_amount:275,transfer_fee_category_id:'synthetic-fee'}),categories,{...fields,feeAmount:'0'});
 assert.equal(request.fee_amount,0);assert.equal(request.fee_category_id,null);
 assert.equal(request.expected.transfer_fee_amount,275);
});

test('표시 내역은 내부 원금과 실제 수수료 과목명을 구분하고 원본 금액은 변경하지 않는다',()=>{
 const transaction=row({category_id:'synthetic-transfer',is_internal:true,transfer_fee_amount:275,transfer_fee_category_id:'synthetic-fee'}),before=JSON.stringify(transaction);
 const html=renderToStaticMarkup(createElement(TransferFeeBreakdown,{data:{categories},transaction}));
 assert.match(html,/출금액 분류 내역/);assert.match(html,/합성 내부이동 10,000원/);assert.match(html,/합성 수수료 275원/);
 assert.equal(JSON.stringify(transaction),before);
 assert.equal(renderToStaticMarkup(createElement(TransferFeeBreakdown,{data:{categories},transaction:row()})), '');
 assert.equal(renderToStaticMarkup(createElement(TransferFeeBreakdown,{data:{categories:[]},transaction})), '');
});
