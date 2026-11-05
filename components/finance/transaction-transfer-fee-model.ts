import {needsCategoryReview} from '@/lib/finance/category-status';
import type {Category,Transaction} from '@/lib/finance/types';

export function transferFeeExpected(transaction:Transaction){
 return {amount:transaction.amount,category_id:transaction.category_id,manually_classified:transaction.manually_classified,transfer_fee_amount:transaction.transfer_fee_amount??0,transfer_fee_category_id:transaction.transfer_fee_category_id??null};
}

export function sameTransferFeeVersion(left:Transaction,right:Transaction){
 return left.id===right.id&&left.direction===right.direction&&JSON.stringify(transferFeeExpected(left))===JSON.stringify(transferFeeExpected(right));
}

export function transferFeeRequest(transaction:Transaction,categories:Category[],fields:{transferCategoryId:string;feeCategoryId:string;feeAmount:string}){
 if(transaction.direction!=='out'||!Number.isSafeInteger(transaction.amount)||transaction.amount<=0)throw Error('금액이 확인된 출금 거래만 분리할 수 있습니다.');
 const transferCategory=categories.find(category=>category.id===fields.transferCategoryId);
 if(!transferCategory?.is_internal||needsCategoryReview(transferCategory.name))throw Error('내부이동 계정과목을 선택해주세요.');
 if(!/^\d+$/.test(fields.feeAmount))throw Error('수수료를 0 이상의 원 단위 숫자로 입력해주세요.');
 const fee=Number(fields.feeAmount);
 if(!Number.isSafeInteger(fee)||fee>=transaction.amount)throw Error('수수료는 통장 출금액보다 작아야 합니다.');
 const feeCategory=categories.find(category=>category.id===fields.feeCategoryId);
 if(fee>0&&(!feeCategory||feeCategory.is_internal||needsCategoryReview(feeCategory.name)))throw Error('수수료 계정과목을 선택해주세요.');
 return {transaction_id:transaction.id,transfer_category_id:transferCategory.id,fee_category_id:fee>0?feeCategory!.id:null,fee_amount:fee,expected:transferFeeExpected(transaction)};
}
