// Cloudflare Worker: proxies a target site, strips frame-blocking headers,
// rewrites relative URLs via <base>, and injects the Warmly widget script.

// Both injected at the top of <head>, no defer/async — fires reliably
// before any page-level scripts can interfere.
const WARMLY_SCRIPT = '<script id="warmly-script-loader" src="https://opps-widget.getwarmly.com/warmly.js?clientId=e46b6961c27fa5afcf0a9eb0a157542e"></script>';
const UPVERT_SCRIPT = '<!-- Upvert site "Demo Instance" --><script src="https://cdn.upvertcdn.io/Ar9QyVOBhKFnFOS7CfH7HVF42pQvfT/loader.js"></script>';

// Scoped CSS to repair Upvert popup layout when the proxied site's CSS
// bleeds in. Real-world failure: site's iframe { width:100% !important }
// (plus flex min-content) blows the Loom video out of the popup to the
// left, overflowing the container.
const UPVERT_FIXES = '<style id="upvert-fixes">\n' +
'  .upvert-popup, .upvert-popup *, .upvert-popup *::before, .upvert-popup *::after {\n' +
'    box-sizing: border-box !important;\n' +
'    max-width: 100% !important;\n' +
'    min-width: 0 !important;\n' +
'  }\n' +
'  .upvert-popup {\n' +
'    overflow: hidden !important;\n' +
'    animation: none !important;\n' +
'    transition: none !important;\n' +
'    opacity: 1 !important;\n' +
'    visibility: visible !important;\n' +
'    display: flex !important;\n' +
'    pointer-events: auto !important;\n' +
'    transform: none !important;\n' +
'  }\n' +
'  .upvert-popup * {\n' +
'    animation-name: none !important;\n' +
'    animation-duration: 0s !important;\n' +
'  }\n' +
'  .upvert-popup > div {\n' +
'    flex: 1 1 auto !important;\n' +
'    min-width: 0 !important;\n' +
'    overflow: hidden !important;\n' +
'  }\n' +
'  .upvert-popup iframe {\n' +
'    width: 100% !important;\n' +
'    height: 100% !important;\n' +
'    max-width: 100% !important;\n' +
'    min-width: 0 !important;\n' +
'    border: 0 !important;\n' +
'    display: block !important;\n' +
'  }\n' +
'</style>';

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

    // Strip CSP and X-Frame-Options meta tags before any other rewrites
    html = html.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
    html = html.replace(/<meta[^>]+http-equiv=["']?X-Frame-Options["']?[^>]*>/gi, '');

    // Warmly + Upvert at top of <head>, then <base> for relative URL resolution.
    // Upvert layout fixes go LAST (just before </head>) so they win specificity.
    const headInjection = '\n  ' + WARMLY_SCRIPT + '\n  ' + UPVERT_SCRIPT + '\n  <base href="' + origin + '/">';
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head([^>]*)>/i, '<head$1>' + headInjection);
    } else if (/<html[^>]*>/i.test(html)) {
      html = html.replace(/<html([^>]*)>/i, '<html$1><head>' + headInjection + '\n' + UPVERT_FIXES + '\n</head>');
    } else {
      html = '<head>' + headInjection + '\n' + UPVERT_FIXES + '\n</head>' + html;
    }

    // Inject Upvert layout fixes just before </head> so they load AFTER the
    // page's stylesheets and win specificity battles via !important.
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, '\n  ' + UPVERT_FIXES + '\n</head>');
    }

    // End-of-body: click interceptor (proxy nav) + Upvert persistence guard.
    // Persistence guard: SPAs (React/Vue) rerender and rip Upvert out. We
    // observe DOM mutations, track close-button clicks, and re-attach the
    // popup if it disappears WITHOUT the user closing it.
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
      '' +
      'var popupRef=null;var userClosed=false;' +
      'function trackClose(p){' +
        'p.querySelectorAll("button.i").forEach(function(b){' +
          'b.addEventListener("click",function(){userClosed=true;},true);' +
        '});' +
      '}' +
      'var obs=new MutationObserver(function(){' +
        'if(userClosed)return;' +
        'var live=document.querySelector(".upvert-popup");' +
        'if(live){' +
          'popupRef=live;' +
          'trackClose(live);' +
          'if(live.parentNode!==document.documentElement){' +
            'try{document.documentElement.appendChild(live);}catch(e){}' +
          '}' +
        '}else if(popupRef&&!popupRef.parentNode){' +
          'try{document.documentElement.appendChild(popupRef);}catch(e){}' +
        '}' +
      '});' +
      'obs.observe(document.documentElement,{childList:true,subtree:true});' +
      '})();</script>\n';

    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, bodyInjection + '</body>');
    } else {
      html += bodyInjection;
    }

    const headers = new Headers();
    headers.set('content-type', 'text/html; charset=utf-8');
    headers.set('cache-control', 'no-store');
    // Explicitly do NOT set x-frame-options or CSP — we want this iframeable

    return new Response(html, { status: 200, headers });
  }
};
