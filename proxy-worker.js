// Shelf Watch CORS proxy — deploy this as a free Cloudflare Worker.
//
// Public CORS proxies (corsproxy.io, corsfix, allorigins, etc.) are either
// rate-limited, require paid domain registration, or disappear over time.
// This tiny worker is yours alone — free forever on Cloudflare's free tier
// (100,000 requests/day), and only ever proxies the Goodreads RSS URL this
// app asks for.
//
// Setup:
// 1. Go to https://workers.cloudflare.com/ and sign up (free, no card needed).
// 2. Create a new Worker, delete the sample code, and paste this file in.
// 3. Deploy. Copy the worker's URL (looks like https://shelf-watch-proxy.<you>.workers.dev).
// 4. In Shelf Watch's Settings, set the "CORS proxy" field to that URL + "/?url="
//    e.g. https://shelf-watch-proxy.<you>.workers.dev/?url=

export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url= parameter", { status: 400 });
    }

    // Only ever proxy Goodreads — this worker isn't meant to be an open relay.
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("Invalid url parameter", { status: 400 });
    }
    if (!targetUrl.hostname.endsWith("goodreads.com")) {
      return new Response("This proxy only allows goodreads.com", { status: 403 });
    }

    const res = await fetch(targetUrl.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShelfWatch/1.0)" },
    });
    const body = await res.arrayBuffer();

    return new Response(body, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "text/xml",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
