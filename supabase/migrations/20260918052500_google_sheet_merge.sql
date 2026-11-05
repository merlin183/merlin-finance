begin;

create table public.fd_sheet_imports(
 id uuid primary key,
 owner_id uuid not null references auth.users(id) on delete cascade,
 source_url text not null check(length(source_url)<=2000 and source_url ~ '^https://docs[.]google[.]com/spreadsheets/d/[A-Za-z0-9_-]+([/?#][^[:space:]]*)?$'),
 source_hash text not null check(source_hash ~ '^[a-f0-9]{64}$'),
 result jsonb,
 changes jsonb not null,
 created_at timestamptz not null default now()
);
create index fd_sheet_imports_owner_created on public.fd_sheet_imports(owner_id,created_at desc);
alter table public.fd_sheet_imports enable row level security;
revoke all on public.fd_sheet_imports from public,anon,authenticated;
grant select,insert,update,delete on public.fd_sheet_imports to authenticated;
create policy finance_admin_workspace on public.fd_sheet_imports for all to authenticated
 using(owner_id=(select private.finance_workspace_owner()))
 with check(owner_id=(select private.finance_workspace_owner()));

-- Serialize note writes with a merge, including direct table writes. Without
-- this lock a new transaction note could appear after duplicate validation.
create function private.fd_lock_merchant_note_subject() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 perform a.id from public.fd_accounts a where a.owner_id=new.owner_id and a.id=new.account_id for update;
 if not found then return new;end if; -- RLS/FK constraints reject inaccessible accounts.
 if new.subject_key like 'transaction:%' then
  perform t.id from public.fd_transactions t where t.owner_id=new.owner_id and t.account_id=new.account_id
   and t.direction=new.direction and 'transaction:'||t.id::text=new.subject_key for key share;
  if not found then raise exception 'NOTE_TRANSACTION_MISSING';end if;
 end if;
 return new;
end $$;
revoke all on function private.fd_lock_merchant_note_subject() from public,anon,authenticated;
create trigger fd_lock_merchant_note_subject before insert or update on public.fd_merchant_notes
 for each row execute function private.fd_lock_merchant_note_subject();

-- The account lock is also taken by ordinary file imports below. No storage or
-- network operation occurs inside this transaction.
create function public.fd_apply_sheet_import(p_run uuid,p_source_url text,p_source_hash text,p_changes jsonb,p_summary jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 workspace_owner uuid:=private.finance_workspace_owner();
 saved_run public.fd_sheet_imports;
 change jsonb; duplicate jsonb; expected jsonb; duplicate_expected jsonb;
 incoming public.fd_transactions; existing public.fd_transactions; extra public.fd_transactions;
 target_account uuid; business uuid; target_id uuid;
 consumed uuid[]; before_state jsonb; after_state jsonb; answer jsonb; summary jsonb; summary_key text;
 inserted integer:=0; updated integer:=0; removed integer:=0; unchanged integer:=0; affected integer;
 required_expected text[]:=array['id','business_id','account_id','upload_id','txn_date','amount','direction','description','raw_gwamok','category_id','is_internal','balance','tax_invoice','dedup_hash','manually_classified'];
 required_row text[]:=array['txn_date','amount','direction','description','raw_gwamok','category_id','is_internal','balance','tax_invoice','dedup_hash','manually_classified'];
 optional_nulls jsonb:='{"txn_time":null,"source_sheet":null,"source_row":null}'::jsonb;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 if p_run is null or p_source_url is null or length(p_source_url)>2000
  or p_source_url !~ '^https://docs[.]google[.]com/spreadsheets/d/[A-Za-z0-9_-]+([/?#][^[:space:]]*)?$'
  or p_source_hash is null or p_source_hash !~ '^[a-f0-9]{64}$'
  or jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes)>20000
 then raise exception 'SHEET_INVALID_PAYLOAD';end if;
 if jsonb_typeof(p_summary) is distinct from 'object'
  or exists(select 1 from jsonb_object_keys(p_summary) k where k not in ('unchanged','sourceDuplicates','blocked'))
 then raise exception 'SHEET_INVALID_SUMMARY';end if;
 summary:='{"unchanged":0,"sourceDuplicates":0,"blocked":0}'::jsonb||p_summary;
 foreach summary_key in array array['unchanged','sourceDuplicates','blocked'] loop
  if jsonb_typeof(summary->summary_key) is distinct from 'number'
   or coalesce(summary->>summary_key,'') !~ '^(0|[1-9][0-9]{0,4})$'
  then raise exception 'SHEET_INVALID_SUMMARY';end if;
  if (summary->>summary_key)::integer>20000 then raise exception 'SHEET_INVALID_SUMMARY';end if;
 end loop;

 -- A conflicting run insert waits for the first transaction to commit. Its
 -- result is then returned, without applying the same changes a second time.
 insert into public.fd_sheet_imports(id,owner_id,source_url,source_hash,changes)
 values(p_run,workspace_owner,p_source_url,p_source_hash,jsonb_build_object('request',p_changes,'summary',summary))
 on conflict(id) do nothing;
 select * into saved_run from public.fd_sheet_imports where id=p_run and owner_id=workspace_owner for update;
 if saved_run.id is null or saved_run.source_url is distinct from p_source_url
  or saved_run.source_hash is distinct from p_source_hash or saved_run.changes->'request' is distinct from p_changes
  or saved_run.changes->'summary' is distinct from summary
 then raise exception 'SHEET_RUN_CONFLICT';end if;
 if saved_run.result is not null then return saved_run.result;end if;

 if exists(select 1 from jsonb_array_elements(p_changes) c
  where jsonb_typeof(c) is distinct from 'object'
   or coalesce(c->>'kind','') not in ('insert','update')
   or c->>'id' is null or c->>'account_id' is null
   or jsonb_typeof(c->'row') is distinct from 'object'
   or not (c->'row' ?& required_row)
   or jsonb_typeof(c->'duplicates') is distinct from 'array')
 then raise exception 'SHEET_INVALID_CHANGE';end if;
 if exists(select 1 from jsonb_array_elements(p_changes) c
  cross join lateral jsonb_array_elements(c->'duplicates') d
  where jsonb_typeof(d) is distinct from 'object' or d->>'id' is null
   or jsonb_typeof(d->'expected') is distinct from 'object' or not (d->'expected' ?& required_expected))
 then raise exception 'SHEET_INVALID_EXPECTED';end if;
 select coalesce(array_agg(id),'{}'::uuid[]) into consumed from(
  select (c->>'id')::uuid id from jsonb_array_elements(p_changes) c
  union all
  select (d->>'id')::uuid from jsonb_array_elements(p_changes) c
   cross join lateral jsonb_array_elements(c->'duplicates') d
 ) ids;
 if cardinality(consumed)>20000 or cardinality(consumed)<>(select count(distinct id) from unnest(consumed) id)
 then raise exception 'SHEET_DUPLICATE_ID';end if;

 perform a.id from public.fd_accounts a
 join (select distinct (c->>'account_id')::uuid id from jsonb_array_elements(p_changes) c) wanted on wanted.id=a.id
 where a.owner_id=workspace_owner order by a.id for update of a;
 if (select count(distinct (c->>'account_id')::uuid) from jsonb_array_elements(p_changes) c)<>
  (select count(*) from public.fd_accounts a where a.owner_id=workspace_owner
   and a.id in(select (c->>'account_id')::uuid from jsonb_array_elements(p_changes) c))
 then raise exception 'SHEET_ACCOUNT_REQUIRED';end if;
 perform t.id from public.fd_transactions t where t.owner_id=workspace_owner and t.id=any(consumed)
 order by t.id for update;
 select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) into before_state
 from public.fd_transactions t where t.owner_id=workspace_owner and t.id=any(consumed);

 -- Validate every row and every deletion before mutating anything. Full
 -- expected snapshots prevent a stale preview from overwriting admin edits.
 for change in select value from jsonb_array_elements(p_changes) loop
  target_account:=(change->>'account_id')::uuid;target_id:=(change->>'id')::uuid;
  select a.business_id into strict business from public.fd_accounts a where a.id=target_account and a.owner_id=workspace_owner;
  incoming:=jsonb_populate_record(null::public.fd_transactions,(change->'row')-array['id','owner_id','business_id','account_id','upload_id','created_at']);
  incoming.id:=target_id;incoming.owner_id:=workspace_owner;incoming.business_id:=business;incoming.account_id:=target_account;incoming.upload_id:=null;
  if incoming.dedup_hash is null or incoming.dedup_hash !~ '^([a-f0-9]{40}|[a-f0-9]{64})$'
   or incoming.txn_date is null or incoming.amount is null or incoming.amount<=0
   or incoming.direction is null or incoming.direction not in ('in','out')
   or incoming.description is null or incoming.raw_gwamok is null
   or incoming.is_internal is null or incoming.tax_invoice is null or incoming.manually_classified is null
  then raise exception 'SHEET_INVALID_ROW';end if;
  select * into existing from public.fd_transactions t where t.id=target_id and t.owner_id=workspace_owner;
  if change->>'kind'='insert' then
   if (change->'expected') is distinct from 'null'::jsonb or existing.id is not null then raise exception 'SHEET_STALE';end if;
   if jsonb_array_length(change->'duplicates')<>0 then raise exception 'SHEET_INSERT_DUPLICATES';end if;
  else
   expected:=optional_nulls||(change->'expected');
   if jsonb_typeof(change->'expected') is distinct from 'object' or not (change->'expected' ?& required_expected)
    or existing.id is null or existing.account_id<>target_account or not (to_jsonb(existing) @> expected)
   then raise exception 'SHEET_STALE';end if;
   if exists(select 1 from public.fd_inter_company_links l where l.owner_id=workspace_owner and (l.out_transaction_id=target_id or l.in_transaction_id=target_id))
    and (incoming.amount is distinct from existing.amount or incoming.direction is distinct from existing.direction
     or incoming.is_internal is distinct from existing.is_internal or incoming.business_id is distinct from existing.business_id)
   then raise exception 'SHEET_LINK_CONFLICT';end if;
  end if;
  for duplicate in select value from jsonb_array_elements(change->'duplicates') loop
   select * into extra from public.fd_transactions t where t.id=(duplicate->>'id')::uuid and t.owner_id=workspace_owner;
   duplicate_expected:=optional_nulls||(duplicate->'expected');
   if extra.id is null or extra.account_id<>target_account or not (to_jsonb(extra) @> duplicate_expected)
   then raise exception 'SHEET_STALE';end if;
   if extra.txn_date is distinct from incoming.txn_date or extra.amount is distinct from incoming.amount or extra.direction is distinct from incoming.direction
    or lower(regexp_replace(btrim(normalize(extra.description,NFKC)),'[[:space:]]+',' ','g'))
      is distinct from lower(regexp_replace(btrim(normalize(incoming.description,NFKC)),'[[:space:]]+',' ','g'))
    or (extra.balance is not null and incoming.balance is not null and extra.balance<>incoming.balance)
    or (extra.balance is not null and existing.balance is not null and extra.balance<>existing.balance)
    or (extra.txn_time is not null and incoming.txn_time is not null and extra.txn_time<>incoming.txn_time)
    or (extra.txn_time is not null and existing.txn_time is not null and extra.txn_time<>existing.txn_time)
   then raise exception 'SHEET_DUPLICATE_AMBIGUOUS';end if;
   if exists(select 1 from public.fd_inter_company_links l where l.owner_id=workspace_owner and (l.out_transaction_id=extra.id or l.in_transaction_id=extra.id))
    or exists(select 1 from public.fd_merchant_notes n where n.owner_id=workspace_owner and n.account_id=target_account and n.subject_key='transaction:'||extra.id::text)
   then raise exception 'SHEET_DUPLICATE_REFERENCED';end if;
  end loop;
 end loop;

 delete from public.fd_transactions t where t.owner_id=workspace_owner and t.id in(
  select (d->>'id')::uuid from jsonb_array_elements(p_changes) c cross join lateral jsonb_array_elements(c->'duplicates') d
 );
 get diagnostics removed=row_count;
 for change in select value from jsonb_array_elements(p_changes) loop
  target_account:=(change->>'account_id')::uuid;target_id:=(change->>'id')::uuid;
  select a.business_id into strict business from public.fd_accounts a where a.id=target_account and a.owner_id=workspace_owner;
  incoming:=jsonb_populate_record(null::public.fd_transactions,(change->'row')-array['id','owner_id','business_id','account_id','upload_id','created_at']);
  if change->>'kind'='insert' then
   insert into public.fd_transactions(id,owner_id,business_id,account_id,upload_id,txn_date,txn_time,source_sheet,source_row,amount,direction,description,raw_gwamok,category_id,is_internal,balance,tax_invoice,dedup_hash,manually_classified)
   values(target_id,workspace_owner,business,target_account,null,incoming.txn_date,incoming.txn_time,incoming.source_sheet,incoming.source_row,incoming.amount,incoming.direction,incoming.description,incoming.raw_gwamok,incoming.category_id,incoming.is_internal,incoming.balance,incoming.tax_invoice,incoming.dedup_hash,incoming.manually_classified);
   inserted:=inserted+1;
  else
   update public.fd_transactions t set upload_id=null,txn_date=incoming.txn_date,txn_time=incoming.txn_time,
    source_sheet=incoming.source_sheet,source_row=incoming.source_row,amount=incoming.amount,direction=incoming.direction,
    description=incoming.description,raw_gwamok=incoming.raw_gwamok,category_id=incoming.category_id,is_internal=incoming.is_internal,
    balance=incoming.balance,tax_invoice=incoming.tax_invoice,dedup_hash=incoming.dedup_hash,manually_classified=incoming.manually_classified
   where t.owner_id=workspace_owner and t.id=target_id
    and row(t.upload_id,t.txn_date,t.txn_time,t.source_sheet,t.source_row,t.amount,t.direction,t.description,t.raw_gwamok,t.category_id,t.is_internal,t.balance,t.tax_invoice,t.dedup_hash,t.manually_classified)
     is distinct from row(null::uuid,incoming.txn_date,incoming.txn_time,incoming.source_sheet,incoming.source_row,incoming.amount,incoming.direction,incoming.description,incoming.raw_gwamok,incoming.category_id,incoming.is_internal,incoming.balance,incoming.tax_invoice,incoming.dedup_hash,incoming.manually_classified);
   get diagnostics affected=row_count;
   updated:=updated+affected;unchanged:=unchanged+(1-affected);
  end if;
 end loop;
 select coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]'::jsonb) into after_state from public.fd_transactions t
 where t.owner_id=workspace_owner and t.id in(select (c->>'id')::uuid from jsonb_array_elements(p_changes) c);
 answer:=jsonb_build_object('inserted',inserted,'updated',updated,'removed',removed,
  'unchanged',unchanged+(summary->>'unchanged')::integer,'sourceDuplicates',(summary->>'sourceDuplicates')::integer,
  'blocked',(summary->>'blocked')::integer,'run_id',p_run);
 update public.fd_sheet_imports set result=answer,changes=jsonb_build_object('request',p_changes,'summary',summary,'before',before_state,'after',after_state)
 where id=p_run and owner_id=workspace_owner;
 insert into public.fd_audit_log(owner_id,action,detail) values(workspace_owner,'Google Sheets 가져오기',format('추가 %s건 · 갱신 %s건 · 중복 정리 %s건 · 변경 없음 %s건 · 실행 %s',inserted,updated,removed,unchanged,p_run));
 return answer;
end $$;
revoke all on function public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb) from public,anon;
grant execute on function public.fd_apply_sheet_import(uuid,text,text,jsonb,jsonb) to authenticated;

-- Join the same account lock used by the sheet merge. Keep the file-import
-- hash format and its 500-row batching behavior unchanged.
create or replace function public.fd_import_transactions(p_account uuid,p_upload uuid,p_rows jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();business uuid;inserted integer;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select business_id into strict business from public.fd_accounts where id=p_account and owner_id=workspace_owner for update;
 if not exists(select 1 from public.fd_uploads where id=p_upload and account_id=p_account and owner_id=workspace_owner) then raise exception 'Upload account mismatch';end if;
 if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>500 then raise exception 'Invalid batch';end if;
 insert into public.fd_transactions(owner_id,business_id,account_id,upload_id,txn_date,txn_time,source_sheet,source_row,amount,direction,description,raw_gwamok,category_id,is_internal,balance,tax_invoice,dedup_hash)
 select workspace_owner,business,p_account,p_upload,x.txn_date,x.txn_time,x.source_sheet,x.source_row,x.amount,x.direction,x.description,x.raw_gwamok,x.category_id,x.is_internal,x.balance,x.tax_invoice,
 case when x.balance is not null then encode(sha256(convert_to(concat_ws('|','v2',p_account::text,x.txn_date::text,x.amount::text,x.direction,x.description,x.balance::text),'UTF8')),'hex') else x.dedup_hash end
 from jsonb_to_recordset(p_rows) x(txn_date date,txn_time text,source_sheet text,source_row integer,amount bigint,direction text,description text,raw_gwamok text,category_id uuid,is_internal boolean,balance bigint,tax_invoice boolean,dedup_hash text)
 on conflict(account_id,dedup_hash) do nothing;
 get diagnostics inserted=row_count;return inserted;
end $$;
revoke all on function public.fd_import_transactions(uuid,uuid,jsonb) from public,anon;
grant execute on function public.fd_import_transactions(uuid,uuid,jsonb) to authenticated;

-- A full user-requested finance reset also clears private import snapshots.
do $$declare definition text;begin
 definition:=pg_get_functiondef('public.fd_delete_my_data()'::regprocedure);
 definition:=replace(definition,'delete from public.fd_inter_company_links','delete from public.fd_sheet_imports where owner_id=private.finance_workspace_owner();delete from public.fd_inter_company_links');
 execute definition;
end $$;
notify pgrst,'reload schema';
commit;
