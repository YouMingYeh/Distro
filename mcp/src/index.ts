import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { authHandler } from "./auth";
import { env, SCOPES } from "./env";
import { apiHandler, mcpHandler } from "./tools";

// One Worker: OAuth 2.1 authorization server + the MCP and REST resources it protects.
export default new OAuthProvider({
  apiHandlers: { "/mcp": mcpHandler, "/api/": apiHandler },
  defaultHandler: authHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register", // DCR, for clients without CIMD
  clientIdMetadataDocumentEnabled: true,
  scopesSupported: [...Object.keys(SCOPES), "offline_access"],
  resourceMetadata: { resource: env.ORIGIN },
});
