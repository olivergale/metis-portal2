export function createHeader(activePage: 'chat' | 'workspace' | 'health'): HTMLElement {
  const nav = document.createElement('nav');
  nav.style.cssText = `
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 8px 24px;
    background: #353432;
    border-bottom: 1px solid #4a4946;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
  `;

  const logo = document.createElement('span');
  logo.textContent = 'ENDGAME';
  logo.style.cssText = `
    font-weight: 700;
    color: #d4a574;
    letter-spacing: 0.5px;
    margin-right: 8px;
  `;
  nav.appendChild(logo);

  const links = [
    { text: 'Chat', href: 'index.html', page: 'chat' },
    { text: 'Workspace', href: 'workspace.html', page: 'workspace' },
    { text: 'Health', href: 'health.html', page: 'health' },
  ];

  links.forEach(link => {
    const a = document.createElement('a');
    a.href = link.href;
    a.textContent = link.text;
    const isActive = link.page === activePage;
    a.style.cssText = `
      color: ${isActive ? '#ececec' : '#b8b8b6'};
      text-decoration: none;
      padding: 4px 10px;
      border-radius: 6px;
      background: ${isActive ? 'rgba(212,165,116,0.15)' : 'transparent'};
    `;
    nav.appendChild(a);
  });

  return nav;
}
