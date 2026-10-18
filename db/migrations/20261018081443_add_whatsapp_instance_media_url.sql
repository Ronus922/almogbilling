-- migrate:up
alter table public.whatsapp_instances add column media_url text;

comment on column public.whatsapp_instances.media_url is
  'Explicit Green API media-host override (uploadFile/sendFileByUpload). '
  'Null = derive from api_url (api. -> media.). Some dedicated/regional Green '
  'hosts have no media. subdomain at all and need this set explicitly '
  '(observed 18/10/2026: 7107.api.greenapi.com has no media host; uploadFile '
  'lives on the api host itself).';

-- migrate:down
alter table public.whatsapp_instances drop column media_url;
