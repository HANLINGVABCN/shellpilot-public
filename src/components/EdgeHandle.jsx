import React from 'react';

export default function EdgeHandle({ panel, expanded, placement, onClick, className = '' }) {
  const sidebar = panel === 'sidebar';
  const label = sidebar ? (expanded ? '收起侧栏' : '展开侧栏') : (expanded ? '收起 AI 对话' : '展开 AI 对话');
  const pointsLeft = sidebar === expanded;
  return (
    <button type="button" className={`edge-handle ${placement} ${className}`} data-panel={panel}
      title={label} aria-label={label} aria-expanded={expanded}
      aria-controls={sidebar ? 'sidebar-panel' : 'ai-panel'} onClick={onClick}>
      <span className="edge-grip" aria-hidden="true" />
      <svg className="edge-chevron" width="6" height="10" viewBox="0 0 6 10" aria-hidden="true">
        <path d={pointsLeft ? 'M4.5 2L1.5 5l3 3' : 'M1.5 2l3 3-3 3'} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
