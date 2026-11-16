import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './mobile.css';
import './edge-handles.css';

// 界面缩放和面板宽度统一由 usePanelLayout 管理。
createRoot(document.getElementById('root')).render(<App />);
