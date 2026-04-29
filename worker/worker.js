// Cloudflare Worker: proxies a target site, strips frame-blocking headers,
// rewrites relative URLs via <base>, and injects the Warmly widget script.

const WARMLY_SCRIPT = '<script id="warmly-script-loader" src="https://opps-widget.getwarmly.com/warmly.js?clientId=e46b6961c27fa5afcf0a9eb0a157542e" defer></script>';

export default {
  async fetch(request) {
    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');

    if (!target) {
      return new Response('Missing ?url= parameter', { status: 400 });
    }

    let targetUrl;
    try {
      const normalized = /^https?:\/\//i.test(target) ? target : 'https://' + target;
      targetUrl = new URL(normalized);
    } catch {
      return new Response('Invalid URL', { status: 400 });
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), {
        headers: {
          'User-Agent': request.headers.get('User-Agent') || 'Mozilla/5.0 (compatible; WarmlyDemo/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': request.headers.get('Accept-Language') || 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } catch (err) {
      return new Response('Failed to fetch target: ' + err.message, { status: 502 });
    }

    const contentType = upstream.headers.get('content-type') || '';

    // Non-HTML (rare here since assets load directly from origin via <base>) — pass through
    if (!contentType.includes('text/html')) {
      const headers = new Headers(upstream.headers);
      headers.delete('x-frame-options');
      headers.delete('content-security-policy');
      headers.delete('content-security-policy-report-only');
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    let html = await upstream.text();
    const origin = targetUrl.origin;
    const workerOrigin = reqUrl.origin;

    // Inject <base> so the browser resolves relative asset URLs against the original site
    const baseTag = '<base href="' + origin + '/">';
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, '<head$1>\n  ' + baseTag);
    } else {
      html = baseTag + html;
    }

    // Remove any <meta http-equiv="Content-Security-Policy"> that could block our injection
    html = html.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
    html = html.replace(/<meta[^>]+http-equiv=["']?X-Frame-Options["']?[^>]*>/gi, '');

    // Inject Warmly script + click interceptor so navigation stays inside the proxy
    const injection = '\n' + WARMLY_SCRIPT + '\n' +
      '<script>(function(){' +
      'var W=' + JSON.stringify(workerOrigin) + ';' +
      'document.addEventListener("click",function(e){' +
        'var a=e.target&&e.target.closest&&e.target.closest("a");' +
        'if(!a||!a.href)return;' +
        'try{' +
          'var u=new URL(a.href);' +
          'if(u.origin===location.origin)return;' +
          'if(u.protocol!=="http:"&&u.protocol!=="https:")return;' +
          'e.preventDefault();' +
          'location.href=W+"/?url="+encodeURIComponent(a.href);' +
        '}catch(err){}' +
      '},true);' +
      '})();</script>\n';

    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, injection + '</body>');
    } else {
      html += injection;
    }

    const headers = new Headers();
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('cache-control', 'no-store');
    // Explicitly do NOT set x-frame-options or CSP — we want this iframeable

    return new Response(html, { status: 200, headers });
  }
};
