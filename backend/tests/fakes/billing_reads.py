"""Semantic reference for adapter tests; real formulas are exercised in SQL contracts."""
from datetime import datetime
from tests.fakes.supabase import RpcBackedSupabase


class BillingReadRpcMixin:
    def _rpc_billing_payment_cohort(self, params):
        start, end = (datetime.fromisoformat(params[key]) for key in ('p_period_start', 'p_period_end'))
        totals = dict(payment_count=0, gross_paid_amount_cents=0, refunded_amount_cents=0,
                      disputed_amount_cents=0, stripe_net_amount_cents=0, external_net_amount_cents=0, net_amount_cents=0)
        for row in self.tables.get('billing_payments', []):
            stamp = row.get('processed_at')
            if row.get('studio_id') != params['p_studio_id'] or not stamp or row['status'] not in {'succeeded','refunded','disputed','externally_recorded'}:
                continue
            if not start <= datetime.fromisoformat(stamp) < end:
                continue
            gross = max(0, row['gross_paid_amount_cents'] if row.get('gross_paid_amount_cents') is not None else row.get('amount_cents',0))
            refunded = min(gross,max(0,row.get('refunded_amount_cents') or 0))
            disputed = min(gross-refunded,max(0,row.get('disputed_amount_cents') or 0))
            net = max(0,row['net_collected_amount_cents'] if row.get('net_collected_amount_cents') is not None else gross-refunded-disputed)
            totals['payment_count'] += 1
            totals['gross_paid_amount_cents'] += gross
            totals['refunded_amount_cents'] += refunded
            totals['disputed_amount_cents'] += disputed
            totals['net_amount_cents'] += net
            totals['external_net_amount_cents' if row['status']=='externally_recorded' else 'stripe_net_amount_cents'] += net
        return dict(totals, period_start=params['p_period_start'],period_end=params['p_period_end'])

    def _rpc_billing_webhook_health(self, params):
        if 'stripe_events' in self.table_failures:
            raise self.table_failures['stripe_events']
        result = {}
        for account in [None]+([params['p_account_id']] if params['p_account_id'] else []):
            rows = [r for r in self.tables.get('stripe_events',[]) if r.get('stripe_account_id')==account]
            processed = sorted([r for r in rows if r.get('processing_status')=='processed' and r.get('processed_at')], key=lambda r:r['processed_at'],reverse=True)
            latest = processed[0] if processed else {}
            result[account or 'platform'] = dict(
                stripe_account_id=account, latest_processed_at=latest.get('processed_at'),latest_event_type=latest.get('type'),
                pending_count=sum(r.get('processing_status')=='pending' for r in rows),
                processing_count=sum(r.get('processing_status')=='processing' for r in rows),
                failed_count=sum(r.get('processing_status')=='failed' for r in rows),
                stale_processing_count=sum(r.get('processing_status')=='processing' and bool(r.get('processing_started_at') or r.get('created_at')) and datetime.fromisoformat(r.get('processing_started_at') or r['created_at'])<=datetime.fromisoformat(params['p_stale_before']) for r in rows),
                mode_mismatch_count=sum(r.get('livemode') is not None and r['livemode']!=params['p_expected_livemode'] for r in rows) if params['p_expected_livemode'] is not None else 0)
        return result


class BillingReadSupabase(BillingReadRpcMixin, RpcBackedSupabase):
    pass
