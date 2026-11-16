import React from 'react';

export function MobileHeader({ title, serversOpen, onServers, chatOpen, onChat }) {
  return (
    <header className="mobile-header" inert={serversOpen ? '' : undefined}>
      <div className="mobile-heading">
        <strong>{title}</strong>
      </div>
    </header>
  );
}
