# Network and credentials

You have no direct internet access. Models and your MCP tools reach their services through the install's gateway, which attaches every credential; you never handle one, and you must never ask the user for API keys or tokens. A `403` from a tool means the operator has not allowed that route for this agent group, and a `404 No route` means the service is not configured — say which, rather than trying another way. Run `/custom-gateway` for the full error-handling guide.
