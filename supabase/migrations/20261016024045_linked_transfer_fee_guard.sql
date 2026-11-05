begin;

-- A linked intercompany pair currently represents equal gross bank amounts.
-- Do not allocate a fee on that pair until it has been explicitly unlinked.
create function private.fd_guard_linked_transfer_fee() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 -- INSERT/UPDATE already holds this outgoing transaction row's write lock.
 -- Link insertion takes the SAME lock below before testing its allocation.
 if new.transfer_fee_amount>0 and exists(select 1 from public.fd_inter_company_links l
  where l.owner_id=new.owner_id and l.out_transaction_id=new.id) then
  raise exception 'TRANSFER_FEE_LINKED';
 end if;
 return new;
end $$;
revoke all on function private.fd_guard_linked_transfer_fee() from public,anon,authenticated;
create trigger fd_guard_linked_transfer_fee before insert or update of transfer_fee_amount,transfer_fee_category_id on public.fd_transactions
 for each row execute function private.fd_guard_linked_transfer_fee();

create function private.fd_guard_fee_allocated_link() returns trigger
language plpgsql security invoker set search_path='' as $$
declare outgoing public.fd_transactions;
begin
 -- Serialize with a fee UPDATE/RPC on the outgoing row. The pre-existing
 -- fd_validate_link trigger still checks ownership, amounts, direction and
 -- different businesses; none of its checks or permissions is replaced.
 select * into outgoing from public.fd_transactions t
  where t.id=new.out_transaction_id and t.owner_id=new.owner_id for update;
 if found and outgoing.transfer_fee_amount>0 then raise exception 'TRANSFER_FEE_LINKED';end if;
 return new;
end $$;
revoke all on function private.fd_guard_fee_allocated_link() from public,anon,authenticated;
create trigger fd_guard_fee_allocated_link before insert or update on public.fd_inter_company_links
 for each row execute function private.fd_guard_fee_allocated_link();

notify pgrst,'reload schema';
commit;
