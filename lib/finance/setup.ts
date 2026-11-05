import type {SupabaseClient} from '@supabase/supabase-js';
import {categoryGroups,aliasSeeds,ruleSeeds} from './seed';

/** Prepare the shared catalog only. Businesses and bank accounts are entered by
 * the installer through Settings; retries preserve all existing catalog rows. */
export async function initializeFinanceCatalog(db:Pick<SupabaseClient,'from'>,ownerId:string){
 const categories=Object.entries(categoryGroups).flatMap(([group_name,names])=>names.map(name=>({
  owner_id:ownerId,name,group_name,is_operating:['영업수입','영업지출','조정·환입'].includes(group_name),is_internal:group_name==='내부이동',
 })));
 const {error:categoryError}=await db.from('fd_categories').upsert(categories,{onConflict:'owner_id,name',ignoreDuplicates:true});
 if(categoryError)throw Error('초기 테이블 설정을 확인하세요.');
 const {data:cats,error:readError}=await db.from('fd_categories').select('id,name');
 if(readError||!cats)throw Error('기본 계정과목을 읽지 못했습니다.');
 const rules=ruleSeeds.map(rule=>{
  const category=cats.find(row=>row.name===rule.category);
  if(!category)throw Error('기본 계정과목을 확인하지 못했습니다.');
  return {owner_id:ownerId,priority:rule.priority,field:rule.field,pattern:rule.pattern,is_internal:rule.is_internal,category_id:category.id};
 });
 for(const [table,rows,conflict] of [
  ['fd_gwamok_aliases',Object.entries(aliasSeeds).map(([raw_name,standard_name])=>({owner_id:ownerId,raw_name,standard_name})),'owner_id,raw_name'],
  ['fd_category_rules',rules,'owner_id,pattern,field,account_id,direction'],
 ] as const){
  const {error}=await db.from(table).upsert(rows as Record<string,unknown>[],{onConflict:conflict,ignoreDuplicates:true});
  if(error)throw Error('기본 자료를 저장하지 못했습니다. 다시 시도하세요.');
 }
 const {error:auditError}=await db.from('fd_audit_log').insert({owner_id:ownerId,action:'초기 설정',detail:'표준 계정과목·과목 별칭·기본 분류 규칙 준비 · 사업자와 계좌는 직접 등록'});
 if(auditError)throw Error('기본 설정은 저장했지만 작업 기록을 남기지 못했습니다. 다시 시도하세요.');
 return {ok:true};
}
