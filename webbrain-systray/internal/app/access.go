package app

import (
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

// Who may use the subscriptions:
//
//   - Apps on this computer need no key. That covers native clients (no
//     Origin header), browser extensions such as WebBrain, and pages served
//     from localhost itself.
//   - Web pages from other sites are refused, so a site you visit cannot spend
//     your plans. Some extensions rewrite the Origin of every request to
//     127.0.0.1 (a common trick for Ollama); the browser still marks those
//     requests Sec-Fetch-Site: cross-site, which is checked too.
//   - Other devices can connect only when network access is on, and then need
//     the API key (the proxy checks it).

// apiPath reports whether a path is one of the proxy's model endpoints.
func apiPath(p string) bool {
	for _, prefix := range []string{"/v1/", "/v1beta/", "/openai/", "/backend-api/"} {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	return p == "/v1" || p == "/v1beta"
}

// loopbackAddr reports whether the TCP peer is this computer.
func loopbackAddr(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// localHost accepts only loopback Host headers, which defeats DNS rebinding.
func localHost(host string) bool {
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = host
	}
	return loopbackName(strings.Trim(h, "[]"))
}

func loopbackName(h string) bool {
	h = strings.ToLower(strings.TrimSuffix(h, "."))
	if h == "localhost" || strings.HasSuffix(h, ".localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func extensionOrigin(o string) bool {
	for _, p := range []string{"chrome-extension://", "moz-extension://", "safari-web-extension://"} {
		if strings.HasPrefix(o, p) {
			return true
		}
	}
	return false
}

// loopbackOrigin is a page served from this computer, on any port (extensions
// that rewrite Origin often drop the port).
func loopbackOrigin(o string) bool {
	u, err := url.Parse(o)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	return loopbackName(u.Hostname())
}

func crossSite(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")), "cross-site")
}

// localClientAllowed decides whether a request that arrived over loopback
// comes from something on this computer that may use the subscriptions
// without a key.
func localClientAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	switch {
	case extensionOrigin(origin):
		return true
	case crossSite(r):
		return false
	case origin == "":
		return true
	}
	return loopbackOrigin(origin)
}

// hasCredential reports whether the client sent an API key in any of the
// forms the proxy accepts.
func hasCredential(r *http.Request) bool {
	if r.Header.Get("Authorization") != "" || r.Header.Get("X-Api-Key") != "" || r.Header.Get("X-Goog-Api-Key") != "" {
		return true
	}
	q := r.URL.Query()
	return q.Get("key") != "" || q.Get("auth_token") != ""
}

func deny(c *gin.Context, msg string) {
	c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": gin.H{"message": msg, "type": "forbidden", "code": "companion_forbidden"}})
}

const (
	msgRebinding = "WebBrain Companion only answers to 127.0.0.1 or localhost."
	msgWebPage   = "Web pages can't use WebBrain Companion. Browser extensions and apps on this computer can; anything else needs the API key."
	msgNetwork   = "Network access is off. Turn on \"Allow other devices on this network\" in WebBrain Companion's Settings to connect from another device."
)

// access runs before the proxy's own middleware on its model endpoints.
func (a *App) access(c *gin.Context) {
	r := c.Request
	if !apiPath(r.URL.Path) {
		c.Next()
		return
	}
	if loopbackAddr(r.RemoteAddr) {
		if !localHost(r.Host) {
			deny(c, msgRebinding)
			return
		}
		if localClientAllowed(r) {
			// Authenticate as the companion itself; whatever key the app sent
			// (WebBrain insists on one) does not matter.
			r.Header.Set("Authorization", "Bearer "+a.internalKey)
			c.Next()
			return
		}
		if !hasCredential(r) {
			deny(c, msgWebPage)
			return
		}
		c.Next() // a web page that knows the API key: the proxy checks it
		return
	}
	if !a.Store.Get().Network {
		deny(c, msgNetwork)
		return
	}
	c.Next() // another device: the proxy checks the API key
}
