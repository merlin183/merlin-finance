import type {ClobeAccountsResponse} from '@/lib/clobe/types';
import type {Category,Dataset} from '@/lib/finance/types';
import {needsCategoryReview} from '@/lib/finance/category-status';

export type ClobeImportLink={company_id:string;external_account_id:string;account_id:string|null;selected:boolean};
export type ClobeImportBank={company_id:string;external_account_id:string;company_name:string;name:string;bank_name:string|null;masked_number:string;currency:string;is_hidden:boolean};
export function clobeImportBankKey(bank:Pick<ClobeImportLink,'company_id'|'external_account_id'>){return JSON.stringify([bank.company_id,bank.external_account_id]);}
export function clobeImportBanks(accounts:ClobeAccountsResponse):ClobeImportBank[]{
 return accounts.companies.flatMap(company=>company.accounts.filter(account=>account.currency==='KRW').map(account=>({company_id:company.id,external_account_id:String(account.id),company_name:company.name,name:account.name,bank_name:account.bankName,masked_number:account.maskedNumber,currency:account.currency,is_hidden:account.isHidden})));
}
/** Only a previously confirmed mapping is restored. Similar names or masked
 * numbers never silently choose a business's bank account. */
export function restoreClobeImportLinks(banks:readonly ClobeImportBank[],saved:readonly {company_id:string;external_account_id:string;account_id:string}[],data:Pick<Dataset,'accounts'>):ClobeImportLink[]{
 const usable=new Set(data.accounts.map(account=>account.id));
 const confirmed=new Map(saved.map(mapping=>[clobeImportBankKey(mapping),mapping.account_id]));
 return banks.map(bank=>{const matched=confirmed.get(clobeImportBankKey(bank)),account_id=matched&&usable.has(matched)?matched:null;return {company_id:bank.company_id,external_account_id:bank.external_account_id,account_id,selected:!!account_id};});
}
export function clobeImportLinkError(links:readonly ClobeImportLink[],data:Pick<Dataset,'accounts'>){
 const selected=links.filter(link=>link.selected);
 if(!selected.length)return '가져올 Clobe 통장을 선택해주세요.';
 if(selected.some(link=>!link.account_id||!data.accounts.some(account=>account.id===link.account_id)))return '선택한 모든 통장에 멀린 저장 계좌를 지정해주세요.';
 if(new Set(selected.map(link=>link.account_id)).size!==selected.length)return '같은 멀린 계좌에 여러 Clobe 통장을 연결할 수 없습니다. 통장 연결을 확인해주세요.';
 return '';
}
export function clobeImportAccountOptions(data:Pick<Dataset,'accounts'|'businesses'>){
 return [{value:'none',label:'멀린 저장 계좌 선택'},...data.accounts.map(account=>({value:account.id,label:[data.businesses.find(business=>business.id===account.business_id)?.name||'사업자 미확인',account.bank,account.name,account.masked_number].filter(Boolean).join(' · ')}))];
}
export type ClobeImportClassifiable={key:string;category_id:string|null};
/** Batch editing is an explicit selection, never a merchant name guessed
 * across different businesses/accounts or existing saved transactions. */
export function setSelectedClobeCategories(rows:readonly ClobeImportClassifiable[],selected:ReadonlySet<string>,choices:Readonly<Record<string,string|null>>,categoryId:string,categories:readonly Category[]){
 if(!categories.some(category=>category.id===categoryId))return {...choices};
 const editable=new Set(rows.map(row=>row.key)),next={...choices};
 for(const key of selected)if(editable.has(key))next[key]=categoryId;
 return next;
}
export function chosenClobeCategory(row:ClobeImportClassifiable,choices:Readonly<Record<string,string|null>>){return Object.hasOwn(choices,row.key)?choices[row.key]:row.category_id;}
/** A stored ID is not proof of classification: the shared review categories
 * include placeholder IDs, while historical completion is a valid outcome. */
export function clobeImportNeedsCategoryReview(row:ClobeImportClassifiable,choices:Readonly<Record<string,string|null>>,categories:readonly Category[]){
 const categoryId=chosenClobeCategory(row,choices);
 return needsCategoryReview(categories.find(category=>category.id===categoryId)?.name);
}
export function clobeImportSearchMatches(values:readonly (string|null|undefined)[],search:string){
 const normalize=(value:string)=>value.normalize('NFKC').replace(/\s/g,'').toLowerCase();
 const query=normalize(search);return !query||values.some(value=>normalize(value||'').includes(query));
}
