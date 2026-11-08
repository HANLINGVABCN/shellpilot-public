export async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || 'HTTP ' + res.status;
    if(data.storageError){window.dispatchEvent(new CustomEvent('shellpilot-storage-error',{detail:message}));}
    if (message.includes('服务器身份') || message.includes('服务器指纹')) {
      const hostId = body?.host || new URL('/api' + path, location.href).searchParams.get('host');
      window.dispatchEvent(new CustomEvent('shellpilot-ssh-identity', {detail:{hostId}}));
    }
    throw new Error(message);
  }
  return data;
}
