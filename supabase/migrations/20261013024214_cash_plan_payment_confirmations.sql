begin;

-- User confirmation reduces a plan only. It never creates or changes a bank
-- transaction, category, balance snapshot, original budget or planned date.
alter table public.fd_cash_plan_edits
 add column confirmed_amount bigint,
 add column confirmed_date date,
 add column confirmation_complete boolean not null default false,
 add column confirmation_memo text not null default '',
 add constraint finance_plan_confirmation check(
  (confirmed_amount is null and confirmed_date is null and not confirmation_complete and confirmation_memo='')
  or (payment_kind='general' and month<>'*' and confirmed_amount is not null and confirmed_amount between 1 and 9007199254740991
   and confirmed_date is not null and to_char(confirmed_date,'YYYY-MM')=month and length(confirmation_memo)<=2000)
 );

create function private.finance_plan_confirmation_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.confirmed_date is not null and new.confirmed_date>(current_timestamp at time zone 'Asia/Seoul')::date
 then raise exception 'CASH_PLAN_CONFIRMATION_FUTURE';end if;
 return new;
end $$;
revoke all on function private.finance_plan_confirmation_guard() from public,anon,authenticated;
create trigger finance_plan_confirmation_guard before insert or update on public.fd_cash_plan_edits
 for each row execute function private.finance_plan_confirmation_guard();

create or replace function public.fd_read_cash_plan_edits() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner(); result jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'business_id',business_id,'source_type',source_type,'source_key',source_key,'month',month,
  'title',title,'account_id',account_id,'plan_date',plan_date,'amount',amount,'memo',memo,
  'excluded',excluded,'payment_kind',payment_kind,'payment_status',payment_status,
  'confirmed_amount',confirmed_amount,'confirmed_date',confirmed_date,'confirmation_complete',confirmation_complete,'confirmation_memo',confirmation_memo,
  'version',version,'updated_at',updated_at
 ) order by business_id,month,source_type,source_key,id),'[]'::jsonb) into result
 from public.fd_cash_plan_edits where owner_id=workspace_owner;
 return result;
end $$;
revoke all on function public.fd_read_cash_plan_edits() from public,anon,authenticated;
grant execute on function public.fd_read_cash_plan_edits() to authenticated;

create or replace function public.fd_save_cash_plan_edits(p_changes jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner(); change jsonb; item public.fd_cash_plan_edits;
 change_id uuid; expected_version integer; changed_id uuid; action text;
 seen_ids uuid[]:='{}';seen_keys text[]:='{}';scope_key text;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 100
 then raise exception 'INVALID_CASH_PLAN_CHANGES';end if;
 perform pg_advisory_xact_lock(hashtextextended(workspace_owner::text||':cash-plan',0));
 for change in select value from jsonb_array_elements(p_changes) loop
  if jsonb_typeof(change) is distinct from 'object' then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
  action:=change->>'action';change_id:=(change->>'id')::uuid;expected_version:=(change->>'version')::integer;
  if change_id is null or expected_version is null or expected_version<0 or expected_version>=2147483647
   or action is null or action not in ('save','delete','payment_status','payment_confirmation') or change_id=any(seen_ids)
  then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
  seen_ids:=array_append(seen_ids,change_id);
  changed_id:=null;
  if action='delete' then
   if expected_version=0 or exists(select 1 from jsonb_object_keys(change) key where key not in ('action','id','version'))
   then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
   delete from public.fd_cash_plan_edits where owner_id=workspace_owner and id=change_id and version=expected_version returning id into changed_id;
  elsif action='payment_status' then
   if expected_version=0 or not(change ? 'payment_status') or change->>'payment_status' is null
    or change->>'payment_status' not in ('pending','paid')
    or exists(select 1 from jsonb_object_keys(change) key where key not in ('action','id','version','payment_status'))
   then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
   update public.fd_cash_plan_edits set payment_status=change->>'payment_status',version=version+1
    where owner_id=workspace_owner and id=change_id and version=expected_version and payment_kind='tax'
    returning id into changed_id;
  elsif action='payment_confirmation' then
   if not(change ?& array['business_id','source_type','source_key','month','title','account_id','plan_date','amount','memo','excluded','confirmed_amount','confirmed_date','confirmation_complete','confirmation_memo'])
    or exists(select 1 from jsonb_object_keys(change) key where key not in ('action','id','version','business_id','source_type','source_key','month','title','account_id','plan_date','amount','memo','excluded','confirmed_amount','confirmed_date','confirmation_complete','confirmation_memo'))
    or jsonb_typeof(change->'confirmation_complete') is distinct from 'boolean'
    or jsonb_typeof(change->'confirmation_memo') is distinct from 'string'
    or change->>'month'='*' or change->'excluded' is distinct from 'false'::jsonb
    or (change->'confirmed_amount'<>'null'::jsonb and (jsonb_typeof(change->'confirmed_amount') is distinct from 'number' or change->>'confirmed_amount' !~ '^[0-9]+$'))
    or (change->'confirmed_date'<>'null'::jsonb and (jsonb_typeof(change->'confirmed_date') is distinct from 'string' or change->>'confirmed_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
   then raise exception 'INVALID_CASH_PLAN_CONFIRMATION';end if;
   select * into item from jsonb_populate_record(null::public.fd_cash_plan_edits,change-'action');
   scope_key:=jsonb_build_array(item.business_id,item.source_type,item.source_key,item.month)::text;
   if scope_key=any(seen_keys) then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
   seen_keys:=array_append(seen_keys,scope_key);
   if expected_version=0 then
    if item.confirmed_amount is null then raise exception 'INVALID_CASH_PLAN_CONFIRMATION';end if;
    insert into public.fd_cash_plan_edits(id,owner_id,business_id,source_type,source_key,month,title,account_id,plan_date,amount,memo,excluded,confirmed_amount,confirmed_date,confirmation_complete,confirmation_memo,updated_by)
    values(change_id,workspace_owner,item.business_id,item.source_type,item.source_key,item.month,item.title,item.account_id,item.plan_date,item.amount,item.memo,false,
     item.confirmed_amount,item.confirmed_date,item.confirmation_complete,item.confirmation_memo,auth.uid())
    on conflict do nothing returning id into changed_id;
   else
    if exists(select 1 from public.fd_cash_plan_edits where owner_id=workspace_owner and id=change_id and version=expected_version and payment_kind='tax')
    then raise exception 'CASH_PLAN_CONFIRMATION_TAX';end if;
    -- Full identity is a seed for unsaved estimates. Existing plans preserve
    -- all edited budget/date/title/account/memo/exclusion fields.
    update public.fd_cash_plan_edits set confirmed_amount=item.confirmed_amount,confirmed_date=item.confirmed_date,
     confirmation_complete=item.confirmation_complete,confirmation_memo=item.confirmation_memo,version=version+1
    where owner_id=workspace_owner and id=change_id and version=expected_version and payment_kind='general'
     and not excluded and business_id=item.business_id and source_type=item.source_type and source_key=item.source_key and month=item.month
     and account_id is not distinct from item.account_id returning id into changed_id;
   end if;
  else
   if not(change ?& array['business_id','source_type','source_key','month','title','account_id','plan_date','amount','memo','excluded'])
    or exists(select 1 from jsonb_object_keys(change) key where key not in ('action','id','version','business_id','source_type','source_key','month','title','account_id','plan_date','amount','memo','excluded','payment_kind','payment_status'))
   then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
   select * into item from jsonb_populate_record(null::public.fd_cash_plan_edits,change-'action');
   scope_key:=jsonb_build_array(item.business_id,item.source_type,item.source_key,item.month)::text;
   if scope_key=any(seen_keys) then raise exception 'INVALID_CASH_PLAN_CHANGE';end if;
   seen_keys:=array_append(seen_keys,scope_key);
   if expected_version=0 then
    insert into public.fd_cash_plan_edits(id,owner_id,business_id,source_type,source_key,month,title,account_id,plan_date,amount,memo,excluded,payment_kind,payment_status,updated_by)
    values(change_id,workspace_owner,item.business_id,item.source_type,item.source_key,item.month,item.title,item.account_id,item.plan_date,item.amount,item.memo,item.excluded,
     case when change ? 'payment_kind' then item.payment_kind else 'general' end,
     case when change ? 'payment_status' then item.payment_status else 'pending' end,auth.uid())
    on conflict do nothing returning id into changed_id;
   else
    -- Older editors do not send payment metadata; they must never clear an
    -- explicit obligation or accidentally reopen a settled notice.
    update public.fd_cash_plan_edits set title=item.title,account_id=item.account_id,plan_date=item.plan_date,amount=item.amount,memo=item.memo,excluded=item.excluded,
     payment_kind=case when change ? 'payment_kind' then item.payment_kind else payment_kind end,
     payment_status=case when change ? 'payment_status' then item.payment_status else payment_status end,version=version+1
    where owner_id=workspace_owner and id=change_id and version=expected_version and business_id=item.business_id
     and source_type=item.source_type and source_key=item.source_key and month=item.month returning id into changed_id;
   end if;
  end if;
  if changed_id is null then raise exception 'CASH_PLAN_STALE';end if;
 end loop;
 return public.fd_read_cash_plan_edits();
end $$;
revoke all on function public.fd_save_cash_plan_edits(jsonb) from public,anon,authenticated;
grant execute on function public.fd_save_cash_plan_edits(jsonb) to authenticated;

create or replace function private.finance_cash_plan_audit() returns trigger
language plpgsql security invoker set search_path='' as $$
declare item public.fd_cash_plan_edits; label text;
begin
 item:=case when tg_op='DELETE' then old else new end;
 label:=case when tg_op='DELETE' then '수정 원복' when item.excluded then '제외' else '저장' end;
 if tg_op='UPDATE' and new.payment_kind='tax' and new.payment_status is distinct from old.payment_status then
  label:=case when new.payment_status='paid' then '세금 납부완료' else '세금 미납 복원' end;
 end if;
 if (tg_op='INSERT' and new.confirmed_amount is not null) or (tg_op='UPDATE' and
  (new.confirmed_amount,new.confirmed_date,new.confirmation_complete,new.confirmation_memo) is distinct from
  (old.confirmed_amount,old.confirmed_date,old.confirmation_complete,old.confirmation_memo)) then
  label:=case when new.confirmed_amount is null then '출금 확인 해제' when new.confirmation_complete then '출금 완료 확인' else '출금 일부 확인' end;
 end if;
 insert into public.fd_audit_log(owner_id,action,detail)
 values(item.owner_id,'지출 계획 '||label,jsonb_build_object('id',item.id,'business_id',item.business_id,'month',item.month,'version',item.version,'payment_kind',item.payment_kind,'payment_status',item.payment_status,
  'confirmed_amount',item.confirmed_amount,'confirmed_date',item.confirmed_date,'confirmation_complete',item.confirmation_complete)::text);
 return null;
end $$;
revoke all on function private.finance_cash_plan_audit() from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
