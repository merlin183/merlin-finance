import type {Category} from './types';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const marker=/^\[cash-plan-category:v1:([^\]\r\n]+)\]$/;
const reserved=(line:string)=>line.toLowerCase().includes('[cash-plan-category');

/** Plan-only metadata never changes the saved transaction classification. */
export function cashPlanCategoryMemoError(memo:string):string|null{
 const lines=memo.split('\n').map(line=>line.trim()).filter(reserved);
 return lines.length>1||lines.some(line=>!marker.test(line)||!uuid.test(marker.exec(line)![1]))?'지출계획의 계정과목 표식을 확인해주세요.':null;
}
export function cashPlanCategoryId(memo:string):string|null{
 if(cashPlanCategoryMemoError(memo))return null;
 const line=memo.split('\n').map(value=>value.trim()).find(reserved);
 return line?marker.exec(line)![1]:null;
}
export function readCashPlanCategory(memo:string,categories:readonly Pick<Category,'id'|'name'>[]):{categoryId:string;categoryName:string}|null{
 const id=cashPlanCategoryId(memo),category=id?categories.find(item=>item.id===id):undefined;
 return category?{categoryId:category.id,categoryName:category.name}:null;
}
/** Hide even malformed reserved metadata without granting it any evidence. */
export function stripCashPlanCategoryLines(memo:string):string{return memo.split('\n').some(reserved)?memo.split('\n').filter(line=>!reserved(line)).join('\n').trim():memo;}
export function mergeCashPlanCategory(memo:string,categoryId:string|null):string{
 if(categoryId!==null&&!uuid.test(categoryId))throw Error('지출계획의 계정과목을 확인해주세요.');
 const user=stripCashPlanCategoryLines(memo);
 return [categoryId?`[cash-plan-category:v1:${categoryId}]`:'',user].filter(Boolean).join('\n');
}
export function cashEstimateSourceIdentity(key:string,businessId?:string):{businessId:string;accountId:string;partyKey:string;categoryId:string|null;legacyKey:string}|null{
 try{
  const value:unknown=JSON.parse(key);
  if(!Array.isArray(value)||(value.length!==3&&value.length!==4)||value.some(part=>typeof part!=='string')||JSON.stringify(value)!==key
   ||businessId!==undefined&&value[0]!==businessId||value.length===4&&!value[3])return null;
  return {businessId:value[0],accountId:value[1],partyKey:value[2],categoryId:value[3]??null,legacyKey:JSON.stringify(value.slice(0,3))};
 }catch{return null;}
}
