-- One statement snapshot instead of a separate HTTP request per table/page.
-- The caller retains table RLS; this function grants no elevated read access.
create function public.fd_read_finance_dataset() returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare workspace_owner uuid; snapshot_at timestamptz:=statement_timestamp();
begin
 if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
 workspace_owner:=private.finance_workspace_owner();
 if workspace_owner is null then raise exception 'ADMIN_REQUIRED'; end if;
 return jsonb_build_object(
  'businesses',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from (
   select id,name,representative,kind,reserve,color from public.fd_businesses where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'accounts',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from (
   select id,business_id,name,bank,masked_number,opening_balance,opening_balance_date from public.fd_accounts where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'categories',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from (
   select id,name,group_name,is_operating,is_internal,is_fixed from public.fd_categories where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'rules',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from (
   select id,pattern,field,category_id,priority,is_internal,account_id,direction from public.fd_category_rules where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'aliases',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from (
   select id,raw_name,standard_name from public.fd_gwamok_aliases where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'recurring',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from (
   select id,business_id,title,amount,direction,day,start_date,end_date,frequency from public.fd_recurring_items where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'transactions',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from (
   select id,business_id,account_id,upload_id,txn_date,txn_time,source_sheet,source_row,source_details,amount,direction,description,raw_gwamok,category_id,is_internal,balance,tax_invoice,dedup_hash,manually_classified
   from public.fd_transactions where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'uploads',(select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id),'[]'::jsonb) from (
   select id,account_id,filename,storage_path,success_count,duplicate_count,error_count,created_at,errors from public.fd_uploads where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'links',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from (
   select id,out_transaction_id,in_transaction_id from public.fd_inter_company_links where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'notes',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) from (
   select id,account_id,direction,subject_key,label,memo,version,updated_at from public.fd_merchant_notes where owner_id=workspace_owner and created_at<=snapshot_at) r),
  'audit',(select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc,r.id),'[]'::jsonb) from (
   select id,action,detail,created_at from public.fd_audit_log where owner_id=workspace_owner and created_at<=snapshot_at order by created_at desc,id limit 100) r)
 );
end;
$$;
revoke all on function public.fd_read_finance_dataset() from public,anon,authenticated;
grant execute on function public.fd_read_finance_dataset() to authenticated;
