import React from 'react';
import EdgeHandle from './EdgeHandle.jsx';

export function MobileHeader({ title, serversOpen, onServers, chatOpen, onChat, showChat = true }) {
  return (
    <header className="mobile-header" inert={serversOpen ? '' : undefined}>
      {!serversOpen && <EdgeHandle panel="sidebar" expanded={false} placement="edge-inline-left" onClick={onServers} />}
      <div className="mobile-heading">
        <strong>{title}</strong>
      </div>
      {showChat && <EdgeHandle panel="ai" expanded={chatOpen} placement="edge-inline-right" onClick={onChat} />}
    </header>
  );
}
