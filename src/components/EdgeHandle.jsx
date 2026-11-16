import React from 'react';

export default function EdgeHandle({ panel, expanded, placement, onClick, className = '', direct = false, label: customLabel }) {
  const sidebar = panel === 'sidebar';
  const label = customLabel || (sidebar ? (expanded ? '收起侧栏' : '展开侧栏') : (expanded ? '收起 AI 对话' : '展开 AI 对话'));
  const pointsLeft = sidebar === expanded;
  const symbol = <svg className="edge-symbol" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 6 6 6-6 6" /><path d="m13 6 6 6-6 6" /></svg>;
  return (
    <button type="button" className={`edge-handle ${placement}${direct ? ' edge-direct' : ''} ${className}`} data-panel={panel} data-direction={pointsLeft ? 'left' : 'right'}
      title={direct ? undefined : label} aria-label={label} aria-expanded={expanded}
      aria-controls={sidebar ? 'sidebar-panel' : 'ai-panel'} onClick={onClick}>
      {direct ? symbol : <><span className="edge-grip" aria-hidden="true" /><span className="edge-hover" aria-hidden="true">{symbol}</span></>}
    </button>
  );
}
