package app

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/esokullu/webbrain-systray/internal/settings"
)

func TestLocalHost(t *testing.T) {
	ok := []string{"127.0.0.1:8327", "localhost:8327", "[::1]:8327", "127.0.0.1", "localhost", "app.localhost:8327"}
	bad := []string{"evil.example:8327", "127.0.0.1.evil.example", "localhost.evil.example:8327", "192.168.1.5:8327", ""}
	for _, h := range ok {
		if !localHost(h) {
			t.Errorf("%q rejected", h)
		}
	}
	for _, h := range bad {
		if localHost(h) {
			t.Errorf("%q accepted", h)
		}
	}
}

func TestLocalClientAllowed(t *testing.T) {
	cases := []struct {
		origin, site string
		want         bool
	}{
		{"", "", true}, // curl, SDKs, native apps
		{"chrome-extension://abcdefgh", "none", true}, // WebBrain
		{"chrome-extension://abcdefgh", "cross-site", true},
		{"moz-extension://1234", "cross-site", true},
		{"http://127.0.0.1:8327", "same-origin", true}, // the panel
		{"http://127.0.0.1", "same-origin", true},      // Origin rewritten by an extension, port dropped
		{"http://localhost:5173", "same-site", true},   // a local web app
		{"http://127.0.0.1", "cross-site", false},      // a web page whose Origin an extension rewrote
		{"https://evil.example", "cross-site", false},
		{"https://evil.example", "", false},
		{"null", "", false},       // sandboxed frames
		{"", "cross-site", false}, // cross-site request without Origin
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "http://127.0.0.1:8327/v1/chat/completions", nil)
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		if c.site != "" {
			r.Header.Set("Sec-Fetch-Site", c.site)
		}
		if got := localClientAllowed(r); got != c.want {
			t.Errorf("Origin %q Sec-Fetch-Site %q: allowed=%v, want %v", c.origin, c.site, got, c.want)
		}
	}
}

func TestAccessMiddleware(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	a := &App{Store: store, internalKey: "internal"}
	e := gin.New()
	e.Use(a.access)
	e.GET("/v1/models", func(c *gin.Context) { c.String(http.StatusOK, c.GetHeader("Authorization")) })
	e.GET("/anthropic/callback", func(c *gin.Context) { c.String(http.StatusOK, "callback") })

	type req struct {
		name                       string
		remote, host, origin, site string
		auth                       string
		network                    bool
		path                       string
		wantStatus                 int
		wantAuth                   string
	}
	cases := []req{
		{name: "native app, no key", remote: "127.0.0.1:50000", host: "127.0.0.1:8327", wantStatus: 200, wantAuth: "Bearer internal"},
		{name: "native app, any key", remote: "127.0.0.1:50000", host: "127.0.0.1:8327", auth: "Bearer anything", wantStatus: 200, wantAuth: "Bearer internal"},
		{name: "extension", remote: "127.0.0.1:50000", host: "127.0.0.1:8327", origin: "chrome-extension://abc", site: "none", wantStatus: 200, wantAuth: "Bearer internal"},
		{name: "web page", remote: "127.0.0.1:50000", host: "127.0.0.1:8327", origin: "https://evil.example", site: "cross-site", wantStatus: 403},
		{name: "web page with rewritten origin", remote: "127.0.0.1:50000", host: "127.0.0.1:8327", origin: "http://127.0.0.1", site: "cross-site", wantStatus: 403},
		{name: "web page with the key", remote: "127.0.0.1:50000", host: "127.0.0.1:8327", origin: "https://tool.example", site: "cross-site", auth: "Bearer wb-user", wantStatus: 200, wantAuth: "Bearer wb-user"},
		{name: "dns rebinding", remote: "127.0.0.1:50000", host: "evil.example:8327", wantStatus: 403},
		{name: "other device, network off", remote: "192.168.1.20:50000", host: "192.168.1.57:8327", auth: "Bearer wb-user", wantStatus: 403},
		{name: "other device, network on", remote: "192.168.1.20:50000", host: "192.168.1.57:8327", auth: "Bearer wb-user", network: true, wantStatus: 200, wantAuth: "Bearer wb-user"},
		{name: "oauth callback untouched", remote: "127.0.0.1:50000", host: "localhost:8327", origin: "https://claude.ai", site: "cross-site", path: "/anthropic/callback", wantStatus: 200},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _ = store.Update(func(s *settings.Settings) { s.Network = c.network })
			path := c.path
			if path == "" {
				path = "/v1/models"
			}
			r := httptest.NewRequest("GET", "http://"+c.host+path, nil)
			r.RemoteAddr = c.remote
			r.Host = c.host
			if c.origin != "" {
				r.Header.Set("Origin", c.origin)
			}
			if c.site != "" {
				r.Header.Set("Sec-Fetch-Site", c.site)
			}
			if c.auth != "" {
				r.Header.Set("Authorization", c.auth)
			}
			w := httptest.NewRecorder()
			e.ServeHTTP(w, r)
			if w.Code != c.wantStatus {
				t.Fatalf("status %d, want %d (%s)", w.Code, c.wantStatus, w.Body.String())
			}
			if c.wantAuth != "" && w.Body.String() != c.wantAuth {
				t.Fatalf("upstream saw Authorization %q, want %q", w.Body.String(), c.wantAuth)
			}
		})
	}
}

func TestDecisionEndpointAcceptsProxyKeyForms(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("WBC_HOME", t.TempDir())
	store, err := settings.Open()
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.Update(func(s *settings.Settings) { s.Network = true; s.APIKey = "wb-user" })
	if err != nil {
		t.Fatal(err)
	}
	a := &App{Store: store}
	e := gin.New()
	e.POST("/companion/v1/decide", a.guardClient, func(c *gin.Context) { c.Status(http.StatusNoContent) })
	cases := []struct {
		name, url, header, value string
		want                     int
	}{
		{"bearer", "/companion/v1/decide", "Authorization", "Bearer wb-user", http.StatusNoContent},
		{"x-api-key", "/companion/v1/decide", "X-Api-Key", "wb-user", http.StatusNoContent},
		{"x-goog-api-key", "/companion/v1/decide", "X-Goog-Api-Key", "wb-user", http.StatusNoContent},
		{"query-key", "/companion/v1/decide?key=wb-user", "", "", http.StatusNoContent},
		{"query-auth-token", "/companion/v1/decide?auth_token=wb-user", "", "", http.StatusNoContent},
		{"wrong-key", "/companion/v1/decide?key=bad", "", "", http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "http://192.168.1.57:8327"+tc.url, nil)
			r.RemoteAddr = "192.168.1.20:50000"
			if tc.header != "" {
				r.Header.Set(tc.header, tc.value)
			}
			w := httptest.NewRecorder()
			e.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d (%s)", w.Code, tc.want, w.Body.String())
			}
		})
	}
}
