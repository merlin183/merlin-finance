"use client";

import {useId, type ReactNode} from 'react';
import {Button} from '@/components/ui/button';
import {resolveDateRange, type DateRange} from '@/lib/finance/date-range';
import {DateRangeControl} from './date-range-control';
import './analysis-section.css';

export const analysisSections = [
  {value: 'funds', label: '자금 현황'},
  {value: 'categories', label: '계정과목'},
  {value: 'fixed', label: '고정비'},
  {value: 'plans', label: '반복 지출 계획'},
  {value: 'cashflow', label: '현금흐름'},
  {value: 'transfers', label: '내부 자금이동'},
] as const;

export type AnalysisSectionId = typeof analysisSections[number]['value'];

export function AnalysisSection({title, overall, override, bounds, onChange, onReset, visible, description, children}: {
  title: string;
  overall: DateRange;
  override?: DateRange;
  bounds: DateRange;
  onChange: (range: DateRange) => void;
  onReset: () => void;
  visible: boolean;
  description?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  const range = resolveDateRange(overall, override);
  if (!visible) return null;

  return <section className="analysis-section" aria-labelledby={headingId}>
    <header className="analysis-section-header">
      <div className="analysis-section-heading">
        <div><h2 id={headingId}>{title}</h2><span className={override ? 'analysis-period-status is-custom' : 'analysis-period-status'}>{override ? '개별 기간' : '전체 기간'}</span></div>
        <p><time dateTime={range.from}>{range.from}</time> ~ <time dateTime={range.to}>{range.to}</time>{description && ` · ${description}`}</p>
      </div>
      <div className="analysis-section-actions">
        <DateRangeControl label={`${title} 조회`} value={range} onChange={onChange} bounds={bounds} compact/>
        {override && <Button variant="ghost" size="sm" onClick={onReset} aria-label={`${title} 전체 기간 사용`}>전체 기간 사용</Button>}
      </div>
    </header>
    {children}
  </section>;
}
