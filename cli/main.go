// distro: sign in to a Distro server and call its tools from a terminal.
//
// Login is OAuth 2.1 against the Distro Worker itself (it is the authorization
// server): dynamic client registration, authorization code + PKCE (S256), and
// a loopback redirect, per RFC 8252. Standard library only.
package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

var version = "dev" // set by -ldflags at release time

const scopes = "accounts video research publish offline_access"

type creds struct {
	Base         string    `json:"base"`
	ClientID     string    `json:"client_id"`
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	Scope        string    `json:"scope,omitempty"`
	Expiry       time.Time `json:"expiry"`
	APIKey       string    `json:"api_key,omitempty"` // set instead of the OAuth fields by `login --with-key`
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	ErrorDesc    string `json:"error_description"`
}

var httpc = &http.Client{Timeout: 30 * time.Second}

func baseURL() string {
	if v := strings.TrimRight(os.Getenv("DISTRO_URL"), "/"); v != "" {
		return v
	}
	return "https://mcp.trydistro.app"
}

func credsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "distro", "credentials.json"), nil
}

// ponytail: tokens live in a 0600 file, not the OS keychain. Upgrade path: keychain/libsecret
// if this ever holds more than a revocable, scope-limited token.
func save(c *creds) error {
	p, err := credsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(p, b, 0o600)
}

func load() (*creds, error) {
	p, err := credsPath()
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return nil, errors.New("not signed in. Run: distro login")
	}
	if err != nil {
		return nil, err
	}
	var c creds
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, fmt.Errorf("credentials file is corrupt (%s). Run: distro login", p)
	}
	return &c, nil
}

func randomString() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func postForm(endpoint string, form url.Values) (*tokenResponse, error) {
	res, err := httpc.PostForm(endpoint, form)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var t tokenResponse
	if err := json.NewDecoder(res.Body).Decode(&t); err != nil {
		return nil, fmt.Errorf("token endpoint returned HTTP %d", res.StatusCode)
	}
	if t.Error != "" || t.AccessToken == "" {
		return nil, fmt.Errorf("token request failed: %s %s", t.Error, t.ErrorDesc)
	}
	return &t, nil
}

func (c *creds) apply(t *tokenResponse) {
	c.AccessToken = t.AccessToken
	if t.RefreshToken != "" {
		c.RefreshToken = t.RefreshToken
	}
	if t.Scope != "" {
		c.Scope = t.Scope
	}
	c.Expiry = time.Now().Add(time.Duration(t.ExpiresIn) * time.Second)
}

func openBrowser(u string) {
	cmd := "xdg-open"
	if runtime.GOOS == "darwin" {
		cmd = "open"
	}
	_ = exec.Command(cmd, u).Start()
}

func login() error {
	base := baseURL()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer ln.Close()
	redirect := fmt.Sprintf("http://127.0.0.1:%d/callback", ln.Addr().(*net.TCPAddr).Port)

	// ponytail: registers a new public client per login (one small KV record each).
	// Upgrade path: publish a Client ID Metadata Document and use its URL as client_id.
	body, _ := json.Marshal(map[string]any{
		"client_name":                "Distro CLI",
		"redirect_uris":              []string{redirect},
		"token_endpoint_auth_method": "none",
	})
	res, err := httpc.Post(base+"/oauth/register", "application/json", strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	var reg struct {
		ClientID string `json:"client_id"`
	}
	err = json.NewDecoder(res.Body).Decode(&reg)
	res.Body.Close()
	if err != nil || reg.ClientID == "" {
		return fmt.Errorf("client registration failed (HTTP %d)", res.StatusCode)
	}

	verifier, state := randomString(), randomString()
	authURL := base + "/authorize?" + url.Values{
		"response_type":         {"code"},
		"client_id":             {reg.ClientID},
		"redirect_uri":          {redirect},
		"code_challenge":        {challenge(verifier)},
		"code_challenge_method": {"S256"},
		"scope":                 {scopes},
		"state":                 {state},
		"resource":              {base},
	}.Encode()

	type result struct {
		code string
		err  error
	}
	done := make(chan result, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/callback" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		var out result
		switch {
		case q.Get("state") != state:
			out.err = errors.New("state mismatch; sign-in aborted")
		case q.Get("error") != "":
			out.err = fmt.Errorf("authorization refused: %s", q.Get("error"))
		case q.Get("code") == "":
			out.err = errors.New("no authorization code in the redirect")
		default:
			out.code = q.Get("code")
		}
		if out.err != nil {
			http.Error(w, "Sign-in failed. Return to the terminal.", http.StatusBadRequest)
		} else {
			fmt.Fprint(w, "Signed in to Distro. You can close this tab.")
		}
		select {
		case done <- out:
		default:
		}
	})}
	go srv.Serve(ln)
	defer srv.Close()

	fmt.Fprintf(os.Stderr, "Opening your browser to sign in. If it does not open, visit:\n\n  %s\n\n", authURL)
	openBrowser(authURL)

	var out result
	select {
	case out = <-done:
	case <-time.After(5 * time.Minute):
		return errors.New("timed out waiting for the browser")
	}
	if out.err != nil {
		return out.err
	}

	t, err := postForm(base+"/oauth/token", url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {reg.ClientID},
		"code":          {out.code},
		"code_verifier": {verifier},
		"redirect_uri":  {redirect},
		"resource":      {base},
	})
	if err != nil {
		return err
	}
	c := &creds{Base: base, ClientID: reg.ClientID}
	c.apply(t)
	if err := save(c); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Signed in to %s\n", base)
	return nil
}

// loginWithKey saves an API key read from stdin, after checking the server accepts it.
// Stdin, not an argument, so the key stays out of shell history and the process list.
func loginWithKey() error {
	b, err := io.ReadAll(io.LimitReader(os.Stdin, 4096))
	if err != nil {
		return err
	}
	c := &creds{Base: baseURL(), APIKey: strings.TrimSpace(string(b))}
	if c.APIKey == "" {
		return errors.New("no key on stdin. Usage: distro login --with-key < key.txt")
	}
	c.AccessToken = c.APIKey
	if status, _, err := send(c, "GET", "/api/me", ""); err != nil {
		return err
	} else if status != http.StatusOK {
		return fmt.Errorf("%s did not accept that key (HTTP %d)", c.Base, status)
	}
	c.AccessToken = "" // the key is the credential; session() fills this in
	if err := save(c); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "Signed in to %s with an API key\n", c.Base)
	return nil
}

// session returns valid credentials, refreshing the access token when it is about to expire.
// An API key never expires: DISTRO_API_KEY wins over anything saved by `distro login`.
func session() (*creds, error) {
	if k := strings.TrimSpace(os.Getenv("DISTRO_API_KEY")); k != "" {
		return &creds{Base: baseURL(), APIKey: k, AccessToken: k}, nil
	}
	c, err := load()
	if err != nil {
		return nil, err
	}
	if c.APIKey != "" {
		c.AccessToken = c.APIKey
		return c, nil
	}
	if time.Until(c.Expiry) > time.Minute {
		return c, nil
	}
	if c.RefreshToken == "" {
		return nil, errors.New("session expired. Run: distro login")
	}
	t, err := postForm(c.Base+"/oauth/token", url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {c.ClientID},
		"refresh_token": {c.RefreshToken},
	})
	if err != nil {
		return nil, fmt.Errorf("session expired (%v). Run: distro login", err)
	}
	c.apply(t)
	return c, save(c)
}

func call(tool, args string) (int, []byte, error) {
	return request("POST", "/api/tools/"+url.PathEscape(tool), args)
}

func request(method, path, body string) (int, []byte, error) {
	c, err := session()
	if err != nil {
		return 0, nil, err
	}
	return send(c, method, path, body)
}

func send(c *creds, method, path, body string) (int, []byte, error) {
	req, _ := http.NewRequestWithContext(context.Background(), method, c.Base+path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+c.AccessToken)
	req.Header.Set("Content-Type", "application/json")
	res, err := httpc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(res.Body)
	return res.StatusCode, b, err
}

func logout() error {
	c, err := load()
	if err != nil {
		return err
	}
	// Best effort: revoke server-side, then always forget locally. A saved API key is only
	// forgotten: it may be in use elsewhere. Revoke it with `distro apikey revoke`.
	for _, tok := range []string{c.RefreshToken, c.AccessToken} {
		if tok != "" {
			if res, err := httpc.PostForm(c.Base+"/oauth/token", url.Values{"token": {tok}, "client_id": {c.ClientID}}); err == nil {
				res.Body.Close()
			}
		}
	}
	p, _ := credsPath()
	if err := os.Remove(p); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Signed out.")
	return nil
}

const usage = `distro: social tools for agents, from your terminal

Usage:
  distro login                 Sign in through your browser
  distro login --with-key      Sign in with an API key read from stdin
  distro logout                Revoke and forget the saved session
  distro status                Show whether you are signed in
  distro token                 Print a valid access token (for curl and scripts)
  distro call <tool> [json]    Call a tool, e.g. distro call list_models '{}'
  distro apikey create [name]  Make an API key (shown once). Needs a browser sign-in
  distro apikey list
  distro apikey revoke <id>
  distro version

Environment:
  DISTRO_API_KEY  API key to use instead of the saved session (CI, servers)
  DISTRO_URL   Server to use (default https://mcp.trydistro.app)
`

func run(args []string) error {
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		return nil
	}
	switch args[0] {
	case "login":
		if len(args) > 1 && args[1] == "--with-key" {
			return loginWithKey()
		}
		return login()
	case "apikey":
		return apikey(args[1:])
	case "logout":
		return logout()
	case "status":
		c, err := session()
		if err != nil {
			return err
		}
		if c.APIKey != "" {
			fmt.Printf("Signed in to %s with an API key\n", c.Base)
			return nil
		}
		fmt.Printf("Signed in to %s\nScopes: %s\nAccess token valid until %s\n", c.Base, c.Scope, c.Expiry.Local().Format(time.RFC1123))
		return nil
	case "token":
		c, err := session()
		if err != nil {
			return err
		}
		fmt.Println(c.AccessToken)
		return nil
	case "call":
		if len(args) < 2 {
			return errors.New("usage: distro call <tool> [json]")
		}
		body := "{}"
		if len(args) > 2 {
			body = args[2]
		}
		if !json.Valid([]byte(body)) {
			return errors.New("arguments must be valid JSON")
		}
		status, out, err := call(args[1], body)
		if err != nil {
			return err
		}
		fmt.Println(strings.TrimSpace(string(out)))
		if status >= 400 {
			return fmt.Errorf("HTTP %d", status)
		}
		return nil
	case "version", "--version", "-v":
		fmt.Println(version)
		return nil
	case "help", "--help", "-h":
		fmt.Print(usage)
		return nil
	}
	return fmt.Errorf("unknown command %q. Run: distro help", args[0])
}

func apikey(args []string) error {
	var status int
	var out []byte
	var err error
	switch {
	case len(args) >= 1 && args[0] == "create":
		body, _ := json.Marshal(map[string]string{"name": strings.Join(args[1:], " ")})
		status, out, err = request("POST", "/api/api-keys", string(body))
	case len(args) == 1 && args[0] == "list":
		status, out, err = request("GET", "/api/api-keys", "")
	case len(args) == 2 && args[0] == "revoke":
		status, out, err = request("DELETE", "/api/api-keys?id="+url.QueryEscape(args[1]), "")
	default:
		return errors.New("usage: distro apikey create [name] | list | revoke <id>")
	}
	if err != nil {
		return err
	}
	fmt.Println(strings.TrimSpace(string(out)))
	if status >= 400 {
		return fmt.Errorf("HTTP %d", status)
	}
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "distro:", err)
		os.Exit(1)
	}
}
