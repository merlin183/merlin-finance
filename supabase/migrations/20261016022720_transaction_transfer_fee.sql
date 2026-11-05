begin;

-- Classification allocation only. The bank row, its identity and provider refs stay intact.
alter table public.fd_transactions
 add column transfer_fee_amount bigint not null default 0,
 add column transfer_fee_category_id uuid,
 add constraint fd_transfer_fee_category_owner foreign key(owner_id,transfer_fee_category_id) references public.fd_categories(owner_id,id),
 add constraint fd_transfer_fee_amount_valid check(transfer_fee_amount>=0 and transfer_fee_amount<amount),
 add constraint fd_transfer_fee_allocation_valid check(
  (transfer_fee_amount=0 and transfer_fee_category_id is null)
  or (transfer_fee_amount>0 and transfer_fee_category_id is not null and direction='out' and is_internal and manually_classified and category_id is not null and category_id<>transfer_fee_category_id));

create function private.fd_validate_transfer_fee() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 -- Existing classification endpoints intentionally remove a previous allocation.
 -- Explicit RPC replacement clears it under the same row lock before changing the category.
 if tg_op='UPDATE' and row(new.category_id,new.is_internal) is distinct from row(old.category_id,old.is_internal)
  and row(new.transfer_fee_amount,new.transfer_fee_category_id) is not distinct from row(old.transfer_fee_amount,old.transfer_fee_category_id) then
  new.transfer_fee_amount:=0;new.transfer_fee_category_id:=null;
 end if;
 if new.transfer_fee_amount>0 then
  perform c.id from public.fd_categories c where c.owner_id=new.owner_id and c.id in(new.category_id,new.transfer_fee_category_id) order by c.id for share;
  if new.direction<>'out' or not new.is_internal or not new.manually_classified
   or not exists(select 1 from public.fd_categories c where c.owner_id=new.owner_id and c.id=new.category_id and c.is_internal)
   or not exists(select 1 from public.fd_categories c where c.owner_id=new.owner_id and c.id=new.transfer_fee_category_id and not c.is_internal) then
   raise exception 'INVALID_TRANSFER_FEE_CATEGORY';
  end if;
 end if;
 return new;
end $$;
revoke all on function private.fd_validate_transfer_fee() from public,anon,authenticated;
create trigger fd_validate_transfer_fee before insert or update on public.fd_transactions
 for each row execute function private.fd_validate_transfer_fee();

-- Category flag edits must not silently turn existing allocated fees into transfers.
create function private.fd_guard_transfer_fee_category() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.is_internal is distinct from old.is_internal and exists(select 1 from public.fd_transactions t
  where t.owner_id=old.owner_id and t.transfer_fee_amount>0 and old.id in(t.category_id,t.transfer_fee_category_id)) then
  raise exception 'TRANSFER_FEE_CATEGORY_IN_USE';
 end if;
 return new;
end $$;
revoke all on function private.fd_guard_transfer_fee_category() from public,anon,authenticated;
create trigger fd_guard_transfer_fee_category before update of is_internal on public.fd_categories
 for each row execute function private.fd_guard_transfer_fee_category();

create function public.fd_set_transaction_transfer_fee(p_payload jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
 workspace_owner uuid:=private.finance_workspace_owner();
 row_id uuid;transfer_category uuid;fee_category uuid;fee bigint;expected jsonb;current_row public.fd_transactions;
 transfer_internal boolean;fee_internal boolean;
begin
 if auth.uid() is null then raise exception 'UNAUTHORIZED';end if;
 if workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if jsonb_typeof(p_payload) is distinct from 'object'
  or not(p_payload?&array['transaction_id','transfer_category_id','fee_category_id','fee_amount','expected'])
  or exists(select 1 from jsonb_object_keys(p_payload) k where k not in('transaction_id','transfer_category_id','fee_category_id','fee_amount','expected')) then
  raise exception 'INVALID_TRANSFER_FEE';
 end if;
 expected:=p_payload->'expected';
 if jsonb_typeof(expected) is distinct from 'object'
  or not(expected?&array['amount','category_id','manually_classified','transfer_fee_amount','transfer_fee_category_id'])
  or exists(select 1 from jsonb_object_keys(expected) k where k not in('amount','category_id','manually_classified','transfer_fee_amount','transfer_fee_category_id'))
  or jsonb_typeof(expected->'manually_classified') is distinct from 'boolean'
  or jsonb_typeof(p_payload->'fee_amount') is distinct from 'number'
  or jsonb_typeof(expected->'amount') is distinct from 'number'
  or jsonb_typeof(expected->'transfer_fee_amount') is distinct from 'number'
  or (p_payload->>'fee_amount')!~'^(0|[1-9][0-9]*)$'
  or (expected->>'amount')!~'^[1-9][0-9]*$'
  or (expected->>'transfer_fee_amount')!~'^(0|[1-9][0-9]*)$'
  or (p_payload->>'fee_amount')::numeric>9007199254740991
  or (expected->>'amount')::numeric>9007199254740991
  or (expected->>'transfer_fee_amount')::numeric>9007199254740991 then
  raise exception 'INVALID_TRANSFER_FEE';
 end if;
 begin
  row_id:=(p_payload->>'transaction_id')::uuid;transfer_category:=(p_payload->>'transfer_category_id')::uuid;
  fee_category:=(p_payload->>'fee_category_id')::uuid;fee:=(p_payload->>'fee_amount')::bigint;
  perform (expected->>'category_id')::uuid,(expected->>'transfer_fee_category_id')::uuid;
 exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'INVALID_TRANSFER_FEE';end;
 if row_id is null or transfer_category is null
  or jsonb_typeof(p_payload->'transaction_id') is distinct from 'string'
  or jsonb_typeof(p_payload->'transfer_category_id') is distinct from 'string'
  or jsonb_typeof(p_payload->'fee_category_id') not in('string','null')
  or jsonb_typeof(expected->'category_id') not in('string','null')
  or jsonb_typeof(expected->'transfer_fee_category_id') not in('string','null')
  or fee>=(expected->>'amount')::bigint or (fee=0)<>(fee_category is null)
  or (expected->>'transfer_fee_amount')::bigint>=(expected->>'amount')::bigint
  or ((expected->>'transfer_fee_amount')::bigint=0)<>((expected->>'transfer_fee_category_id') is null) then
  raise exception 'INVALID_TRANSFER_FEE';
 end if;
 select * into current_row from public.fd_transactions t where t.id=row_id and t.owner_id=workspace_owner for update;
 if not found then raise exception 'TRANSFER_FEE_NOT_FOUND';end if;
 if current_row.amount is distinct from (expected->>'amount')::bigint
  or current_row.category_id is distinct from (expected->>'category_id')::uuid
  or current_row.manually_classified is distinct from (expected->>'manually_classified')::boolean
  or current_row.transfer_fee_amount is distinct from (expected->>'transfer_fee_amount')::bigint
  or current_row.transfer_fee_category_id is distinct from (expected->>'transfer_fee_category_id')::uuid then
  raise exception 'TRANSFER_FEE_STALE';
 end if;
 if current_row.direction<>'out' then raise exception 'INVALID_TRANSFER_FEE';end if;
 -- Lock selected categories too, preventing a concurrent internal/external flag change.
 perform c.id from public.fd_categories c where c.owner_id=workspace_owner and c.id in(transfer_category,fee_category) order by c.id for share;
 select c.is_internal into transfer_internal from public.fd_categories c where c.owner_id=workspace_owner and c.id=transfer_category;
 if transfer_internal is distinct from true then raise exception 'INVALID_TRANSFER_FEE_CATEGORY';end if;
 if fee>0 then
  select c.is_internal into fee_internal from public.fd_categories c where c.owner_id=workspace_owner and c.id=fee_category;
  if fee_internal is distinct from false or fee_category=transfer_category then raise exception 'INVALID_TRANSFER_FEE_CATEGORY';end if;
 end if;
 -- One atomic transaction, no insert and no change to any original financial/source field.
 if current_row.transfer_fee_amount>0 then
  update public.fd_transactions set transfer_fee_amount=0,transfer_fee_category_id=null where id=row_id and owner_id=workspace_owner;
 end if;
 update public.fd_transactions set category_id=transfer_category,is_internal=true,manually_classified=true,
  transfer_fee_amount=fee,transfer_fee_category_id=fee_category where id=row_id and owner_id=workspace_owner returning * into current_row;
 insert into public.fd_audit_log(owner_id,action,detail) values(workspace_owner,'계좌이체 수수료 분리',format('거래 %s · 수수료 %s원 · 은행 원본 금액 보존',row_id,fee));
 return jsonb_build_object('id',current_row.id,'amount',current_row.amount,'category_id',current_row.category_id,
  'is_internal',current_row.is_internal,'manually_classified',current_row.manually_classified,
  'transfer_fee_amount',current_row.transfer_fee_amount,'transfer_fee_category_id',current_row.transfer_fee_category_id);
end $$;
revoke all on function public.fd_set_transaction_transfer_fee(jsonb) from public,anon,authenticated;
grant execute on function public.fd_set_transaction_transfer_fee(jsonb) to authenticated;

-- Classification summaries split the allocation; cash/bank views still use the
-- untouched gross bank amount. Existing columns, grants and invoker RLS remain.
create or replace view public.fd_v_consolidated_monthly with(security_invoker=true) as
 select owner_id,date_trunc('month',txn_date)::date as month,
  sum(case when direction='in' and not is_internal then amount else 0 end) as income,
  sum(case when direction='out' and not is_internal then amount when direction='out' then transfer_fee_amount else 0 end) as expense
 from public.fd_transactions where not is_internal or transfer_fee_amount>0
 group by owner_id,date_trunc('month',txn_date);
create or replace view public.fd_v_category_summary with(security_invoker=true) as
 select owner_id,business_id,category_id,direction,sum(amount) as amount from (
  select owner_id,business_id,category_id,direction,amount-transfer_fee_amount as amount from public.fd_transactions
  union all
  select owner_id,business_id,transfer_fee_category_id as category_id,direction,transfer_fee_amount as amount from public.fd_transactions where transfer_fee_amount>0
 ) allocated group by owner_id,business_id,category_id,direction;

-- Extend only the transaction projection in the CURRENT reader. Keep the later balance,
-- bank-plan evidence, coverage arrays, one-statement snapshot and invoker auth intact.
do $$declare definition text;anchor text:=E'dedup_hash,manually_classified\n   from public.fd_transactions';begin
 definition:=replace(pg_get_functiondef('public.fd_read_finance_dataset()'::regprocedure),E'\r\n',E'\n');
 if strpos(definition,anchor)=0 or strpos(definition,'transfer_fee_amount')>0 then raise exception 'TRANSFER_FEE_DATASET_ANCHOR_MISSING';end if;
 execute replace(definition,anchor,E'dedup_hash,manually_classified,transfer_fee_amount,transfer_fee_category_id\n   from public.fd_transactions');
end $$;
notify pgrst,'reload schema';
commit;
