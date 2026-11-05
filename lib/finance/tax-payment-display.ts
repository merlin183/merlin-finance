import type {CashPlanEdit} from './cash-plan-edits';
import {parseFinanceDate} from './date-range';
import type {Account,Business} from './types';

export type TaxPaymentNotice={
 edit:CashPlanEdit;business:Business;account:Account|undefined;
 status:'pending'|'today'|'overdue'|'date-missing'|'paid';daysUntil:number|null;
};

/** Tax alerts deliberately ignore the selected analysis/planning period and
 * exclusions. Only an explicit saved payment confirmation clears an alert. */
export function taxPaymentNotices(edits:readonly CashPlanEdit[],businesses:readonly Business[],accounts:readonly Account[],businessId:string,asOf:string):TaxPaymentNotice[]{
 const owners=new Map(businesses.map(business=>[business.id,business]));
 const banks=new Map(accounts.map(account=>[account.id,account]));
 const newest=new Map<string,CashPlanEdit>();
 for(const edit of edits){const before=newest.get(edit.id);if(!before||edit.version>before.version)newest.set(edit.id,edit);}
 const validToday=!!parseFinanceDate(asOf);
 return [...newest.values()].flatMap(edit=>{
  const business=owners.get(edit.business_id);
  if(edit.payment_kind!=='tax'||!business||(businessId!=='all'&&edit.business_id!==businessId))return [];
  const account=banks.get(edit.account_id??'');
  const validDue=edit.plan_date!==null&&!!parseFinanceDate(edit.plan_date);
  const daysUntil=validToday&&validDue?Math.round((Date.parse(`${edit.plan_date}T00:00:00Z`)-Date.parse(`${asOf}T00:00:00Z`))/86400000):null;
  const status=edit.payment_status==='paid'?'paid':daysUntil===null?'date-missing':daysUntil<0?'overdue':daysUntil===0?'today':'pending';
  return [{edit,business,account:account?.business_id===business.id?account:undefined,status,daysUntil} satisfies TaxPaymentNotice];
 }).sort((left,right)=>(left.edit.plan_date??'9999-99-99').localeCompare(right.edit.plan_date??'9999-99-99')||left.business.name.localeCompare(right.business.name,'ko')||left.edit.id.localeCompare(right.edit.id));
}

export function taxPaymentStatusLabel(notice:Pick<TaxPaymentNotice,'status'|'daysUntil'>):string{
 if(notice.status==='paid')return '납부 완료';
 if(notice.status==='date-missing')return '납부일 확인 필요';
 if(notice.status==='today')return '오늘 납부';
 if(notice.status==='overdue')return `납기 ${Math.abs(notice.daysUntil??0)}일 경과 · 미납 확인`;
 return `납부까지 ${notice.daysUntil}일`;
}
