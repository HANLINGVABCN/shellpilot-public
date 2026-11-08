import React from 'react';

// 左侧面板图标（收起/展开侧栏）
export function PanelLeftIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <rect x="1.2" y="2.2" width="13.6" height="11.6" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.8" y="3.8" width="4.6" height="8.4" rx="1.2" fill="currentColor" />
    </svg>
  );
}

// 右侧面板图标（收起/展开 AI 对话）
export function PanelRightIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <rect x="1.2" y="2.2" width="13.6" height="11.6" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="8.6" y="3.8" width="4.6" height="8.4" rx="1.2" fill="currentColor" />
    </svg>
  );
}

// 机器总览：四宫格
export function GridIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <rect x="1.5" y="1.5" width="5.4" height="5.4" rx="1.2" fill="currentColor" />
      <rect x="9.1" y="1.5" width="5.4" height="5.4" rx="1.2" fill="currentColor" opacity=".45" />
      <rect x="1.5" y="9.1" width="5.4" height="5.4" rx="1.2" fill="currentColor" opacity=".45" />
      <rect x="9.1" y="9.1" width="5.4" height="5.4" rx="1.2" fill="currentColor" opacity=".7" />
    </svg>
  );
}

// 工作台：终端提示符
export function PromptIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <rect x="1.2" y="2.2" width="13.6" height="11.6" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 5.8l2.7 2.2-2.7 2.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.8 10.4h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// 性能监控：折线
export function ChartIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <path d="M1.5 13.5V2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M1.5 13.5H14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M3.5 11l3-4 2.6 2.4L13.5 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// 设置：滑杆
export function SlidersIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <path d="M2 4.4h12M2 8h12M2 11.6h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity=".4" />
      <circle cx="5.6" cy="4.4" r="1.9" fill="currentColor" />
      <circle cx="10.8" cy="8" r="1.9" fill="currentColor" />
      <circle cx="4.8" cy="11.6" r="1.9" fill="currentColor" />
    </svg>
  );
}

// 编辑：铅笔
export function EditIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <path d="M11.3 2.6a1.7 1.7 0 0 1 2.4 2.4L5.4 13.3l-3.2.8.8-3.2 8.3-8.3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

// 删除：垃圾桶
export function TrashIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <path d="M2.5 4.2h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M6 4V2.8h4V4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M3.8 4.6l.7 8.4a1.4 1.4 0 0 0 1.4 1.3h4.2a1.4 1.4 0 0 0 1.4-1.3l.7-8.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.5 7v4.4M9.5 7v4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity=".7" />
    </svg>
  );
}

// 固定标签：图钉（filled=已固定）
export function PinIcon({ size = 12, filled = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <path d="M10.1 2l3.9 3.9-1.5.5-2.8 1-1.6 3.7c-.2.4-.7.5-1 .2L3.7 7.9c-.3-.3-.2-.8.2-1l3.7-1.6 1-2.8.5-1.5z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M7.1 8.9l-4.6 4.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// 文件管理：文件夹
export function FolderIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" style={{ display: 'block' }}>
      <path d="M1.5 3.5h4.6l1.4 1.8h7v7.2a1.3 1.3 0 0 1-1.3 1.3H2.8a1.3 1.3 0 0 1-1.3-1.3V3.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
