-- migrate:up
-- Purchasing: the supplier may type his prices INCLUDING VAT (25/10/2026). purchasing_* only.
--   purchasing_quotes.price_mode        'excl' (default) | 'incl' = how the supplier typed his unit prices.
--   purchasing_quote_lines.unit_price   stays NORMALISED BEFORE VAT (what the comparison, the
--                                       purchase-order prefill and the PDF read). For 'incl' it is
--                                       round2(entered / (1 + document vat_rate / 100)), computed by the server.
--   purchasing_quote_lines.entered_unit_price  the raw number the supplier typed, so the public page
--                                       can show it back unchanged. Existing rows: = unit_price.
alter table public.purchasing_quotes
  add column price_mode text not null default 'excl',
  add constraint purchasing_quotes_price_mode_check check (price_mode in ('excl', 'incl'));

alter table public.purchasing_quote_lines add column entered_unit_price numeric(12,2);
update public.purchasing_quote_lines set entered_unit_price = unit_price;
alter table public.purchasing_quote_lines
  alter column entered_unit_price set not null,
  add constraint purchasing_quote_lines_entered_unit_price_check check (entered_unit_price >= 0);

-- migrate:down
alter table public.purchasing_quote_lines
  drop constraint purchasing_quote_lines_entered_unit_price_check,
  drop column entered_unit_price;
alter table public.purchasing_quotes
  drop constraint purchasing_quotes_price_mode_check,
  drop column price_mode;
