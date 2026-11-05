-- Descriptions can mean different things in different accounts or directions.
alter table public.fd_category_rules add column if not exists account_id uuid;
alter table public.fd_category_rules add column if not exists direction text check (direction in ('in','out'));
alter table public.fd_category_rules add constraint fd_rules_account_owner_fk
  foreign key (owner_id,account_id) references public.fd_accounts(owner_id,id);
alter table public.fd_category_rules drop constraint fd_category_rules_owner_id_pattern_field_key;
create unique index fd_rules_scope_unique on public.fd_category_rules
  (owner_id,pattern,field,coalesce(account_id,'00000000-0000-0000-0000-000000000000'::uuid),coalesce(direction,''));
create index fd_rules_account_idx on public.fd_category_rules(owner_id,account_id);
