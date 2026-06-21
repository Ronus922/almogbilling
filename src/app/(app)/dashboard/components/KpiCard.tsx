// Promoted to the shared @/components/KpiCard so the overview + tasks/issues
// pages can reuse it without a cross-feature import. Re-exported here so the
// debtors screen's KpiGrid (which imports './KpiCard') is unchanged.
export { KpiCard, type KpiTone } from '@/components/KpiCard';
