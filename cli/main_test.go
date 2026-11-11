package main

import "testing"

// RFC 7636 appendix B test vector.
func TestChallenge(t *testing.T) {
	got := challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
	if want := "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; got != want {
		t.Fatalf("challenge = %q, want %q", got, want)
	}
}

// DISTRO_API_KEY is used as the bearer without touching the saved session.
func TestSessionFromEnvKey(t *testing.T) {
	t.Setenv("DISTRO_API_KEY", " dk_test ")
	t.Setenv("DISTRO_URL", "http://localhost:1/")
	c, err := session()
	if err != nil {
		t.Fatal(err)
	}
	if c.AccessToken != "dk_test" || c.Base != "http://localhost:1" {
		t.Fatalf("session = %+v", c)
	}
}
