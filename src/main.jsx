import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// 界面缩放统一由 App.jsx 的 apply() 管理（用户偏好 × 窗口自适应，作用于 html 元素）
createRoot(document.getElementById('root')).render(<App />);
