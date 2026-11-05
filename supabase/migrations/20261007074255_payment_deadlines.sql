begin;

-- Explicit one-time obligations remain plans, never fabricated bank outflows.
alter table public.fd_cash_plan_edits
 add column payment_kind text not null default 'general',
 add column payment_status text not null default 'pending',
 add constraint finance_payment_kind check(payment_kind in ('general','tax')),
 add constraint finance_payment_status check(payment_status in ('pending','paid')),
 add constraint finance_tax_deadline check(payment_kind<>'tax' or (source_type='manual' and month<>'*' and plan_date is not null and amount>0)),
 add constraint finance_tax_paid_status check(payment_kind='tax' or payment_status='pending');

create function private.finance_tax_payment_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='DELETE' then
  if old.payment_kind='tax' and old.payment_status='pending' then raise exception 'CASH_PLAN_TAX_PENDING';end if;
  return old;
 end if;
 if old.payment_kind='tax' and new.payment_kind is distinct from old.payment_kind then raise exception 'CASH_PLAN_TAX_KIND_IMMUTABLE';end if;
 return new;
end $$;
revoke all on function private.finance_tax_payment_guard() from public,anon,authenticated;
create trigger finance_tax_payment_guard before update or delete on public.fd_cash_plan_edits
 for each row execute function private.finance_tax_payment_guard();

create or replace function public.fd_read_cash_plan_edits() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner(); result jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'business_id',business_id,'source_type',source_type,'source_key',source_key,'month',month,
  'title',title,'account_id',account_id,'plan_date',plan_date,'amount',amount,'memo',memo,
  'excluded',excluded,'payment_kind',payment_kind,'payment_status',payment_status,'version',version,'updated_at',updated_at
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
   or action is null or action not in ('save','delete','payment_status') or change_id=any(seen_ids)
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
 insert into public.fd_audit_log(owner_id,action,detail)
 values(item.owner_id,'지출 계획 '||label,jsonb_build_object('id',item.id,'business_id',item.business_id,'month',item.month,'version',item.version,'payment_kind',item.payment_kind,'payment_status',item.payment_status)::text);
 return null;
end $$;
revoke all on function private.finance_cash_plan_audit() from public,anon,authenticated;

notify pgrst,'reload schema';
commit;
