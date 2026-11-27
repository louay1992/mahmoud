const ownerHostname = 'owner.nature-care.net';
const previousHosts = new Set(['hhyyw.netlify.app', 'applications.nature-care.net']);

export default function ownerDomain(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const url = new URL(request.url);
  if (url.hostname === ownerHostname && url.pathname === '/') {
    url.pathname = '/owner.html';
    return url;
  }
  if (previousHosts.has(url.hostname) && ['/owner', '/owner/', '/owner.html'].includes(url.pathname)) {
    const target = new URL(`https://${ownerHostname}/`);
    target.search = url.search;
    return new Response(null, {
      status: 302,
      headers: { Location: target.href, 'Cache-Control': 'no-store' },
    });
  }
}

export const config = { path: ['/', '/owner', '/owner/', '/owner.html'] };
