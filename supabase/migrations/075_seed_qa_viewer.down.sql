-- 075_seed_qa_viewer.down.sql
-- Removes the standing QA viewer account. user_permissions rows cascade via
-- the user_id FK; sessions of this user are deleted explicitly first so no
-- live session survives the account.

begin;

delete from public.sessions
 where user_id in (select id from public.users where username = 'qa-viewer');

delete from public.users where username = 'qa-viewer';

commit;
