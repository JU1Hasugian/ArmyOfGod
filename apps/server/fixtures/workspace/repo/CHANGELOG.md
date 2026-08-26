# Changelog

## v2.7.0
- Add idempotency keys to the payments endpoint
- Retry failed webhook deliveries with backoff
- Drop the legacy `/v1/charge` route

## v2.6.0
- Split the checkout session store from the order store
- Cache tax lookups for 15 minutes

## v2.5.0
- Move refunds behind a feature flag
- Fix a rounding error on multi-currency totals
