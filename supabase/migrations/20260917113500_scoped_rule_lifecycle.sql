begin;
-- Supabase Postgres 15+ supports null-equal keys used by PostgREST upserts.
do $$ begin
 if current_setting('server_version_num')::int < 150000 then
  raise exception 'Postgres 15 or newer is required for scoped rule uniqueness';
 end if;
end $$;
drop index public.fd_rules_scope_unique;
create unique index fd_rules_scope_unique on public.fd_category_rules
  (owner_id,pattern,field,account_id,direction) nulls not distinct;
-- Scoped rules belong to their account, including during full workspace deletion.
alter table public.fd_category_rules drop constraint fd_rules_account_owner_fk;
alter table public.fd_category_rules add constraint fd_rules_account_owner_fk
  foreign key (owner_id,account_id) references public.fd_accounts(owner_id,id) on delete cascade;
notify pgrst,'reload schema';
commit;
