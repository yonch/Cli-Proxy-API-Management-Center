/**
 * Ledger view: one dense row per account, grouped by provider.
 *
 * Each provider group shares one column set — every window identity any of its
 * rows reports — so the same limit lines up down the group, and an account that
 * lacks a limit shows an explicit "not reported" cell instead of shifting its
 * other windows left. Row states mirror the cards: not loaded, loading, failed,
 * loaded. Manual reset actions stay on the cards; the ledger keeps per-account
 * refresh only.
 */

import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ResolvedTheme } from '@/types';
import { buildResetDisplay, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey, getQuotaDisplayName } from '@/utils/quota/identity';
import { getTypeLabel } from '@/features/authFiles/constants';
import { QUOTA_TAB_ORDER } from '../constants';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { resolveQuotaPlanLabel } from '../planLabels';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import { ledgerColumns } from '../quotaPool';
import {
  formatQuotaWindowLabel,
  formatRemainingPercent,
  normalizeQuotaWindows,
  type NormalizedQuotaWindow,
  type QuotaWindowLabel,
} from '../quotaWindows';
import { remainingTone } from './quotaTone';
import { ProviderGlyph } from './ProviderGlyph';
import styles from './QuotaLedger.module.scss';

export interface QuotaLedgerProps {
  entries: QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  displayNameFor: (name: string) => string;
  resolvedTheme: ResolvedTheme;
  now: number;
  /** Ranked window keys per provider (from the pools) so columns match the summary. */
  columnOrder?: Partial<Record<QuotaProviderType, readonly string[]>>;
  canRefresh: (entry: QuotaFileEntry) => boolean;
  resettingKey: string | null;
  onRefresh: (entry: QuotaFileEntry) => void;
}

const TONE_CLASS = {
  high: styles.fillHigh,
  medium: styles.fillMedium,
  low: styles.fillLow,
} as const;

/** Skeleton cells drawn while a row with no known columns is loading. */
const LOADING_PLACEHOLDER_CELLS = 3;

function resetText(
  t: TFunction,
  window: NormalizedQuotaWindow,
  now: number,
  locale: string | undefined
): { text: string; tone: 'normal' | 'muted' | 'stale' } | null {
  if (window.resetAtMs === null) {
    // A full window with nothing scheduled is a fact worth stating; a depleted
    // or unknown one without a reset instant simply wasn't reported.
    return window.remainingPercent !== null && window.remainingPercent >= 100
      ? { text: t('quota_management.ledger_no_reset'), tone: 'muted' }
      : null;
  }
  if (window.resetAtMs <= now) {
    return { text: t('quota_management.ledger_reset_passed'), tone: 'stale' };
  }
  const display = buildResetDisplay(null, window.resetAtMs, now, locale);
  if (!display) return null;
  return {
    text: display.relative ? `${display.relative} · ${display.absolute}` : display.absolute,
    tone: 'normal',
  };
}

function WindowCell({
  window,
  label,
  now,
}: {
  window: NormalizedQuotaWindow | null;
  label: QuotaWindowLabel;
  now: number;
}) {
  const { t, i18n } = useTranslation();
  const text = formatQuotaWindowLabel(t, label);

  if (!window) {
    return (
      <div className={`${styles.cell} ${styles.cellAbsent}`}>
        <div className={styles.cellHead}>
          <span className={styles.cellLabel}>{text}</span>
        </div>
        <div className={`${styles.track} ${styles.trackUnknown}`} aria-hidden="true" />
        <div className={styles.cellReset}>{t('quota_management.ledger_not_reported')}</div>
      </div>
    );
  }

  const percent = window.remainingPercent;
  const reset = resetText(t, window, now, i18n.resolvedLanguage);
  return (
    <div className={styles.cell}>
      <div className={styles.cellHead}>
        <span className={styles.cellLabel} title={text}>
          {text}
        </span>
        <span className={styles.cellPercent}>{formatRemainingPercent(percent)}</span>
      </div>
      {percent === null ? (
        <div className={`${styles.track} ${styles.trackUnknown}`} aria-hidden="true" />
      ) : (
        <div
          className={styles.track}
          role="meter"
          aria-label={t('quota_management.window_remaining_label', {
            label: text,
            percent: Math.round(percent),
          })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <div
            className={`${styles.fill} ${TONE_CLASS[remainingTone(percent)]}`}
            style={{ width: `${Math.round(percent * 100) / 100}%` }}
          />
        </div>
      )}
      <div
        className={
          reset?.tone === 'stale'
            ? `${styles.cellReset} ${styles.cellResetStale}`
            : reset?.tone === 'muted'
              ? `${styles.cellReset} ${styles.cellResetMuted}`
              : styles.cellReset
        }
      >
        {reset?.text ?? (percent === null ? t('quota_management.member_status_unreported') : '')}
      </div>
    </div>
  );
}

function LedgerRow({
  entry,
  quota,
  columns,
  displayName,
  now,
  canRefresh,
  resetting,
  onRefresh,
}: {
  entry: QuotaFileEntry;
  quota: QuotaCardState | undefined;
  columns: { key: string; label: QuotaWindowLabel }[];
  displayName: string;
  now: number;
  canRefresh: boolean;
  resetting: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const plan = resolveQuotaPlanLabel(entry.type, quota, t);
  const own = normalizeQuotaWindows(entry.type, quota);

  let body;
  if (status === 'success') {
    body =
      own.length === 0 ? (
        <p className={styles.rowMessage}>{t('quota_management.ledger_no_windows')}</p>
      ) : (
        <div className={styles.cells}>
          {columns.map((column) => (
            <WindowCell
              key={column.key}
              label={column.label}
              window={own.find((window) => window.key === column.key) ?? null}
              now={now}
            />
          ))}
        </div>
      );
  } else if (loading) {
    body = (
      <div className={styles.cells} aria-busy="true">
        <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
        {Array.from({ length: columns.length || LOADING_PLACEHOLDER_CELLS }, (_, index) => (
          <div key={index} className={styles.cell} aria-hidden="true">
            <span className={styles.skeletonLabel} />
            <span className={`${styles.track} ${styles.skeletonTrack}`} />
          </div>
        ))}
      </div>
    );
  } else if (status === 'error') {
    body = (
      <p className={`${styles.rowMessage} ${styles.rowError}`} role="alert">
        {t(`${adapter.i18nPrefix}.load_failed`, {
          message: resolveQuotaErrorMessage(
            t,
            quota?.errorStatus,
            quota?.error || t('common.unknown_error')
          ),
        })}
      </p>
    );
  } else {
    body = <p className={styles.rowMessage}>{t('quota_management.ledger_not_loaded')}</p>;
  }

  return (
    <li className={styles.row}>
      <div className={styles.identity}>
        <span className={styles.name} title={displayName}>
          {displayName}
        </span>
        {plan && <span className={styles.plan}>{plan}</span>}
      </div>
      <div className={styles.body}>{body}</div>
      <div className={styles.action}>
        <button
          type="button"
          className={styles.refresh}
          onClick={onRefresh}
          disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting)}
          aria-label={t('quota_management.ledger_refresh_label', { name: displayName })}
          title={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw
            size={13}
            aria-hidden="true"
            className={loading ? styles.spinning : undefined}
          />
          <span>{t('auth_files.quota_refresh_single')}</span>
        </button>
      </div>
    </li>
  );
}

export function QuotaLedger({
  entries,
  quotaFor,
  displayNameFor,
  resolvedTheme,
  now,
  columnOrder,
  canRefresh,
  resettingKey,
  onRefresh,
}: QuotaLedgerProps) {
  const { t } = useTranslation();
  const groups = QUOTA_TAB_ORDER.map((provider) => ({
    provider,
    entries: entries.filter((entry) => entry.type === provider),
  })).filter((group) => group.entries.length > 0);

  return (
    <div className={styles.ledger} aria-label={t('quota_management.ledger_label')} role="region">
      {groups.map((group) => {
        const columns = ledgerColumns(
          group.provider,
          group.entries,
          quotaFor,
          columnOrder?.[group.provider]
        );
        const headingId = `quota-ledger-${group.provider}`;
        return (
          <section key={group.provider} className={styles.group} aria-labelledby={headingId}>
            <h3 className={styles.groupHead} id={headingId}>
              <ProviderGlyph provider={group.provider} resolvedTheme={resolvedTheme} />
              <span>{getTypeLabel(t, group.provider)}</span>
              <span className={styles.groupCount}>{group.entries.length}</span>
            </h3>
            <ul className={styles.rows}>
              {group.entries.map((entry) => {
                const key = getQuotaCacheKey(entry.file);
                return (
                  <LedgerRow
                    key={`${entry.type}:${key}`}
                    entry={entry}
                    quota={quotaFor(entry)}
                    columns={columns}
                    displayName={displayNameFor(getQuotaDisplayName(entry.file))}
                    now={now}
                    canRefresh={canRefresh(entry)}
                    resetting={resettingKey === key}
                    onRefresh={() => onRefresh(entry)}
                  />
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
