// 浏览器回归使用实际的安卓抽屉和边缘开关，不改产品的平台判断。
export const platformOptions=width => ({userAgent:width<=760
  ? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36'
  : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36'});

export async function showMobilePage(page, name) {
  if (name === 'AI') {
    const open=page.getByRole('button',{name:'展开 AI 对话',exact:true});
    if (await open.isVisible()) await open.click();
    return;
  }
  const open=page.getByRole('button',{name:'展开侧栏',exact:true});
  if (await open.isVisible()) await open.click();
  if (name === '服务器') return;
  const labels={'总览':'机器总览','工作台':'工作台','设置':'配置'};
  await page.locator('#sidebar-panel').getByRole('button',{name:labels[name] || name,exact:true}).click();
}
