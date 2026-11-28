const ownerHostname = 'owner.nature-care.net';
const appHostname = 'applications.nature-care.net';
const natureCareOwner = 'https://naturecare-operations.netlify.app/owner#';
const previousHosts = new Set(['hhyyw.netlify.app', appHostname]);
const appPaths = ['admin', 'captain', 'account-setup'].flatMap(name => ['/'+name, '/'+name+'/', '/'+name+'.html']);

function redirect(url) {
  return new Response(null, { status: 302, headers: { Location: url.href, 'Cache-Control': 'no-store' } });
}

export default function ownerDomain(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const url = new URL(request.url);
  if (url.hostname === ownerHostname && ['/naturecare', '/naturecare/'].includes(url.pathname)) {
    const response = redirect(new URL(natureCareOwner));
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
  }
  if (url.hostname === ownerHostname && url.pathname === '/') {
    url.pathname = '/owner.html';
    return url;
  }
  if (url.hostname === ownerHostname && appPaths.includes(url.pathname)) {
    const target = new URL(`https://${appHostname}`);
    target.pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
    target.search = url.search;
    return redirect(target);
  }
  if (previousHosts.has(url.hostname) && ['/owner', '/owner/', '/owner.html'].includes(url.pathname)) {
    const target = new URL(`https://${ownerHostname}/`);
    target.search = url.search;
    return redirect(target);
  }
}

export const config = { path: ['/', '/owner', '/owner/', '/owner.html', '/naturecare', '/naturecare/', '/admin', '/admin/', '/admin.html', '/captain', '/captain/', '/captain.html', '/account-setup', '/account-setup/', '/account-setup.html'] };
