# Foundry Local BYOK Provider

The Foundry Local provider enables integration with local Foundry services for BYOK (Bring Your Own Key) scenarios. This provider follows the established patterns for local service providers in the VS Code Copilot Chat extension.

## Configuration

The provider can be configured through the VS Code setting:

```json
{
  "github.copilot.chat.byok.foundryLocalEndpoint": "http://localhost:5273"
}
```

## Expected API Endpoints

The Foundry Local provider expects the service to implement the following REST API endpoints:

### Health Check Endpoints

The provider will attempt to verify service availability using these endpoints (in order):

1. `GET /health` - Primary health check endpoint
   - Expected response: `{ "status": "ok" | "healthy", "version"?: string }`

2. `GET /v1/models` - Fallback health check via models endpoint
   - Used if health endpoint is not available

### Model Endpoints

1. `GET /v1/models` - List available models (OpenAI-compatible)
   ```json
   {
     "object": "list",
     "data": [
       {
         "id": "model-id",
         "object": "model",
         "owned_by": "foundry-local"
       }
     ]
   }
   ```

2. `GET /api/models/{modelId}` - Get detailed model information (optional)
   ```json
   {
     "id": "model-id",
     "name": "Model Display Name",
     "description": "Model description",
     "capabilities": ["tools", "vision"],
     "context_length": 4096,
     "max_tokens": 2048
   }
   ```

### Chat Completions

1. `POST /v1/chat/completions` - OpenAI-compatible chat completions endpoint
   - Should accept standard OpenAI chat completion requests
   - Used for actual chat interactions

## Capabilities Detection

The provider infers model capabilities using the following logic:

- **Tool Calling**: Detected if model capabilities include `"tools"`, `"function_calling"`, or `"tool_calling"`
- **Vision**: Detected if model capabilities include `"vision"` or model name contains "vision"
- **Context Window**: Uses `context_length` from model details, defaults to 4096 tokens
- **Max Output**: Uses `max_tokens` from model details, defaults to half of context window

## Error Handling

The provider provides clear error messages for common issues:

- Service not running: Suggests using `foundry local start`
- Configuration problems: Points to endpoint configuration
- Model availability: Graceful fallback for missing model details

## Authentication

This provider uses `BYOKAuthType.None`, meaning no API key is required for authentication. This is appropriate for local services.

## Implementation Notes

- The provider extends `BaseOpenAICompatibleLMProvider` for consistent behavior
- Uses direct REST API calls via `IFetcherService` instead of external SDKs
- Implements caching for model information to improve performance
- Follows the same patterns as other local service providers (e.g., Ollama)

## Development

When extending or modifying this provider:

1. Follow the established patterns from other BYOK providers
2. Use the `_fetcherService` for all HTTP requests
3. Implement proper error handling with actionable error messages
4. Cache model information when possible
5. Provide graceful fallbacks for optional endpoints