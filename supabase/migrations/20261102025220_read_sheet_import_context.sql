begin;

-- Complete append/dedup/classification context in one statement snapshot.
-- Do not read expensive UI-only bank observations, plan revisions or history.
-- Table RLS and the existing shared-owner authorization remain in force.
create function public.fd_read_sheet_import_context() returns json
language plpgsql stable security invoker set search_path='' as $$
declare workspace_owner uuid; snapshot_at timestamptz:=statement_timestamp();
begin
 if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
 workspace_owner:=private.finance_workspace_owner();
 if workspace_owner is null then raise exception 'ADMIN_REQUIRED'; end if;
 return json_build_object(
  'businesses',(select coalesce(json_agg(row_to_json(r) order by r.id),'[]'::json) from (
   select id,name,representative,kind,reserve,color from public.fd_businesses where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'accounts',(select coalesce(json_agg(row_to_json(r) order by r.id),'[]'::json) from (
   select id,business_id,name,bank,masked_number,opening_balance,opening_balance_date from public.fd_accounts where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'categories',(select coalesce(json_agg(row_to_json(r) order by r.id),'[]'::json) from (
   select id,name,group_name,is_operating,is_internal,is_fixed from public.fd_categories where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'rules',(select coalesce(json_agg(row_to_json(r) order by r.id),'[]'::json) from (
   select id,pattern,field,category_id,priority,is_internal,account_id,direction from public.fd_category_rules where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'aliases',(select coalesce(json_agg(row_to_json(r) order by r.id),'[]'::json) from (
   select id,raw_name,standard_name from public.fd_gwamok_aliases where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'transactions',(select coalesce(json_agg(row_to_json(r) order by r.id),'[]'::json) from (
   select id,business_id,account_id,upload_id,txn_date,txn_time,source_sheet,source_row,source_details,amount,direction,description,raw_gwamok,category_id,is_internal,balance,tax_invoice,dedup_hash,manually_classified,transfer_fee_amount,transfer_fee_category_id
   from public.fd_transactions where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'links',(select coalesce(json_agg(row_to_json(r) order by r.id),'[]'::json) from (
   select id,out_transaction_id,in_transaction_id from public.fd_inter_company_links where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'notes',(select coalesce(json_agg(row_to_json(r) order by r.id),'[]'::json) from (
   select id,account_id,direction,subject_key,label,memo,version,updated_at from public.fd_merchant_notes where owner_id=workspace_owner and created_at<=snapshot_at) r)
 );
end;
$$;
revoke all on function public.fd_read_sheet_import_context() from public,anon,authenticated;
grant execute on function public.fd_read_sheet_import_context() to authenticated;

notify pgrst,'reload schema';
commit;
