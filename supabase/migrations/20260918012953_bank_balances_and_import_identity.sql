begin;
alter table public.fd_transactions add column txn_time text check(txn_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$');
alter table public.fd_transactions add column source_sheet text check(length(source_sheet)<=200);
alter table public.fd_transactions add column source_row integer check(source_row between 1 and 20002);
-- Keep existing IDs, amounts and classifications. Re-key only records with bank-balance evidence.
update public.fd_transactions set dedup_hash=encode(sha256(convert_to(concat_ws('|','v2',account_id::text,txn_date::text,amount::text,direction,description,balance::text),'UTF8')),'hex') where balance is not null;
create or replace function public.fd_import_transactions(p_account uuid,p_upload uuid,p_rows jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare workspace_owner uuid:=private.finance_workspace_owner();business uuid;inserted integer;
begin
 if auth.uid() is null or workspace_owner is null then raise exception 'ADMIN_REQUIRED';end if;
 select business_id into strict business from public.fd_accounts where id=p_account and owner_id=workspace_owner;
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
notify pgrst,'reload schema';
commit;
