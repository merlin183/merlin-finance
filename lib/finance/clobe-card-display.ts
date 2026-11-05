import type {ClobeCardBill,ClobeCardBillsResponse} from '../clobe/card-billing-types';
import type {ClobeAccountMapping} from './clobe-import';
import type {Dataset} from './types';

/** Reuse only bank mappings previously confirmed by an administrator. */
export function confirmedClobeCardBusinesses(mappings:readonly ClobeAccountMapping[],data:Pick<Dataset,'accounts'>):Map<string,string>{
 const accounts=new Map(data.accounts.map(account=>[account.id,account.business_id]));
 const groups=new Map<string,Set<string>>();
 for(const mapping of mappings){const business=accounts.get(mapping.account_id);if(!business)continue;const ids=groups.get(mapping.company_id)??new Set<string>();ids.add(business);groups.set(mapping.company_id,ids);}
 return new Map([...groups].filter(([,ids])=>ids.size===1).map(([company,ids])=>[company,[...ids][0]]));
}

/** A fresh provider read must still match the reviewed bill before saving. */
export function reviewedClobeCardBill(response:ClobeCardBillsResponse,companyId:string,bill:ClobeCardBill):ClobeCardBill|undefined{
 const company=response.companies.find(company=>company.id===companyId);
 if(!company||company.error)return;
 const current=company.bills.find(row=>row.key===bill.key);
 if(!current||!current.replaceable||current.amount===null||current.amount<=0)return;
 if(current.date!==bill.date||current.amount!==bill.amount||current.kind!==bill.kind||current.maskedCard!==bill.maskedCard||current.itemCount!==bill.itemCount)return;
 return current;
}
