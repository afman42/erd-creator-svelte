// security.go — the HTTP hardening layer: response headers, Host allowlist,
// and request timeouts.
//
// This server is designed to be run locally, but "-host" can bind it beyond
// loopback, so the hardening cannot assume the caller is friendly. Two attacks
// matter specifically for a localhost tool:
//
//   - DNS rebinding. A page on evil.example resolves that name to 127.0.0.1
//     after a short TTL, so the victim's browser believes evil.example and this
//     server are the same origin. CORS never applies, and the attacker can read
//     and write the schema store. The defence is to check the Host header: the
//     browser always sends the name it dialled, so a rebinding request arrives
//     with Host: evil.example, which is not a name this server answers to.
//
//   - Cross-site writes. SameSite cookies would help an app with sessions, but
//     this one has no auth, so a cross-origin request is authorised purely by
//     being able to reach the port. Checking Origin on state-changing methods
//     rejects the browser-driven case; the Host check above covers the rest.
//
// Security headers are cheap and are set on every response, including errors.
package main

import (
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// csp is deliberately strict, and it can be because the built app has no inline
// script or style: vite emits an external module script and a linked stylesheet
// (verified against frontend/dist/index.html). If a future change needs inline
// script, prefer a nonce over 'unsafe-inline'.
//
// connect-src 'self' is what stops the app being used as a proxy: every fetch it
// makes is same-origin (/api/…, /export).
const csp = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self'; " +
	"img-src 'self' data:; " +
	"font-src 'self'; " +
	"connect-src 'self'; " +
	"object-src 'none'; " +
	"base-uri 'none'; " +
	"form-action 'none'; " +
	"frame-ancestors 'none'"

// securityHeaders sets the response headers applied to every reply.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", csp)
		// Belt and braces with frame-ancestors: old browsers ignore the directive.
		h.Set("X-Frame-Options", "DENY")
		// Never let a browser second-guess our Content-Type — the schema
		// endpoints return JSON and DDL from user-controlled input.
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		// No feature of this app needs any of these.
		h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		// The server is plain HTTP (localhost), so HSTS is intentionally absent:
		// sending it over http:// has no effect and would be wrong to imply.
		next.ServeHTTP(w, r)
	})
}

// allowedHosts reports whether the Host header names this server.
//
// The check is an allowlist of the names the tool is documented to be reached
// by, not a denylist: a rebinding attack uses a name the attacker controls, so
// there is nothing to match against. Loopback names and any IP literal are
// accepted (an IP cannot be rebound — the browser dials the address it read),
// plus the operator-supplied -host when it is a name.
//
// A missing Host header is rejected: HTTP/1.1 requires it, and a request
// without one is not a browser request.
func allowedHosts(hostHeader string, extra ...string) bool {
	host := hostHeader
	if h, _, err := net.SplitHostPort(hostHeader); err == nil {
		host = h
	}
	host = strings.ToLower(strings.Trim(host, "[]"))
	if host == "" {
		return false
	}
	// An IP literal is safe: rebinding works by name resolution, which an
	// address literal bypasses entirely.
	if ip := net.ParseIP(host); ip != nil {
		return true
	}
	switch host {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	for _, e := range extra {
		e = strings.ToLower(strings.Trim(strings.TrimSpace(e), "[]"))
		if e != "" && host == e {
			return true
		}
	}
	return false
}

// hostGuard rejects requests whose Host is not this server.
func hostGuard(extra ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !allowedHosts(r.Host, extra...) {
				http.Error(w, "invalid Host header", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// sameOriginGuard rejects cross-site state-changing requests.
//
// Only Origin is consulted, and only on methods that mutate. A request with no
// Origin at all is allowed: that is curl, the test suite, and the app's own
// same-origin fetches on older browsers, none of which a page can forge — a
// browser always attaches Origin to a cross-origin request it initiates.
func sameOriginGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			// safe methods: reading is already gated by the Host check
		default:
			if o := r.Header.Get("Origin"); o != "" && !originMatchesHost(o, r.Host) {
				http.Error(w, "cross-origin request rejected", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// originMatchesHost compares an Origin header against the request's Host. The
// port must match too, so a page served from another localhost port cannot
// drive this one.
func originMatchesHost(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return strings.EqualFold(u.Host, host)
}

// newServer builds the http.Server with timeouts.
//
// A bare http.Serve has no read deadline, so a client that opens a connection
// and sends a partial request holds it open indefinitely (Slowloris). On a
// loopback-only server that is a nuisance; once -host binds elsewhere it is a
// denial of service. ReadHeaderTimeout bounds the header phase, which is the
// one that can be stalled indefinitely with a single byte at a time; ReadTimeout
// bounds the whole request, and IdleTimeout reaps kept-alive connections.
func newServer(h http.Handler) *http.Server {
	return &http.Server{
		Handler: h,
		// generous for a local tool, but finite
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 16, // 64 KiB of headers is plenty
	}
}
