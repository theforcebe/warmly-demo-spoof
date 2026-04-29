// Cloudflare Worker: proxies a target site so it's iframeable.
// Strips frame-blocking headers, rewrites relative URLs via <base href>,
// and routes in-page navigation back through the proxy via a click handler.
//
// Note: widget scripts (Warmly, Upvert, etc.) are NOT injected here anymore.
// They run on the outer GH Pages shell so they execute in a normal,
// well-known origin and don't need the prospect's domain whitelisted in
// every vendor's backend. The iframe is purely a visual backdrop.

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

    // Strip CSP and X-Frame-Options meta tags that could block iframing
    html = html.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
    html = html.replace(/<meta[^>]+http-equiv=["']?X-Frame-Options["']?[^>]*>/gi, '');

    // <base href> at top of <head> so relative asset URLs resolve to the original site
    const baseTag = '<base href="' + origin + '/">';
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, '<head$1>\n  ' + baseTag);
    } else if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, '<html$1><head>' + baseTag + '</head>');
    } else {
      html = '<head>' + baseTag + '</head>' + html;
    }

    // Click interceptor at end of body so internal nav stays inside the proxy
    const bodyInjection = '\n<script>(function(){' +
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
      html = html.replace(/<\/body>/i, bodyInjection + '</body>');
    } else {
      html += bodyInjection;
    }

    const headers = new Headers();
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('cache-control', 'no-store');

    return new Response(html, { status: 200, headers });
  }
};
