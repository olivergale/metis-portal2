import './style.css';
import { createHeader } from './components/Header';
import RegressionDashboard from './components/RegressionDashboard';
import React from 'react';
import ReactDOM from 'react-dom/client';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div id="header"></div>
  <div id="dashboard"></div>
`;

const header = createHeader('regression');
document.getElementById('header')!.appendChild(header);

const dashboardRoot = ReactDOM.createRoot(
  document.getElementById('dashboard') as HTMLElement
);
dashboardRoot.render(React.createElement(RegressionDashboard));
