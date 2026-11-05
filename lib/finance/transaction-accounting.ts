import type {Category,Dataset,Transaction} from './types';

/** Validated attribution only. The original bank transaction is never mutated. */
export function transferFeeDetails(data:Pick<Dataset,'categories'>,transaction:Transaction):{principal:number;fee:number;transferCategory:Category;feeCategory:Category}|null{
 const fee=transaction.transfer_fee_amount??0;
 if(transaction.direction!=='out'||!transaction.is_internal||!Number.isSafeInteger(transaction.amount)||!Number.isSafeInteger(fee)||fee<=0||fee>=transaction.amount)return null;
 const transferCategory=data.categories.find(c=>c.id===transaction.category_id);
 const feeCategory=data.categories.find(c=>c.id===transaction.transfer_fee_category_id);
 if(!transferCategory?.is_internal||!feeCategory||feeCategory.is_internal)return null;
 return {principal:transaction.amount-fee,fee,transferCategory,feeCategory};
}

/** Read-only analysis components; never store these in Dataset.transactions. */
export type AccountingTransaction=Transaction&{
 accounting_component?:'principal'|'fee';
 accounting_source_id?:string;
 accounting_source_amount?:number;
};

export function accountingTransactions(data:Pick<Dataset,'categories'>,rows:readonly Transaction[],excludeInternal=false):AccountingTransaction[]{
 const categories=new Map(data.categories.map(c=>[c.id,c]));
 const projected:AccountingTransaction[]=rows.flatMap((raw:AccountingTransaction)=>{
  // Makes independent analysis consumers safe when passed an existing projection.
  if(raw.accounting_component)return [raw];
  const detail=transferFeeDetails(data,raw);
  if(!detail)return [raw];
  const attribution={accounting_source_id:raw.id,accounting_source_amount:raw.amount,balance:null,transfer_fee_amount:0,transfer_fee_category_id:null};
  return [
   {...raw,...attribution,id:raw.id+':principal',amount:detail.principal,accounting_component:'principal' as const},
   {...raw,...attribution,id:raw.id+':fee',amount:detail.fee,category_id:detail.feeCategory.id,is_internal:false,accounting_component:'fee' as const},
  ];
 });
 return excludeInternal?projected.filter(t=>!t.is_internal&&!categories.get(t.category_id??'')?.is_internal):projected;
}
